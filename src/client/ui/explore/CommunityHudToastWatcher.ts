import type { AuthIdentity } from '@dcl/crypto/dist/types'
import { fetchActiveCommunityVoiceChats } from '../../../network/gatekeeper/communityVoice'
import { getCommunityVoiceSession } from '../../../social/CommunityVoiceSession'
import {
  fetchCommunityPosts,
  fetchMemberCommunitiesSigned
} from '../../../social/socialApi'
import type { CommunityListRow } from '../../../social/types'
import { communityDisplayImageUrl } from '../../../social/communityThumbnails'

/** Companion: poll member community posts ~90s (no Social realtime post stream). */
const ANNOUNCEMENT_POLL_MS = 90_000
/** Active voice list poll — companion uses Social WS; we poll as a client-side fallback. */
const VOICE_POLL_MS = 25_000
const INTER_COMMUNITY_DELAY_MS = 80
const MAX_SEEN_POST_IDS = 120
const VOICE_TOAST_DEDUPE_MS = 45_000

export type CommunityAnnouncementToast = {
  communityId: string
  communityDisplayName: string
  text: string
  imageUrl?: string | null
}

export type CommunityVoiceToast = {
  communityId: string
  communityDisplayName: string
  imageUrl?: string | null
}

export type CommunityHudToastWatcherOptions = {
  getAuthIdentity: () => AuthIdentity | null
  getUserAddress: () => string | null
  /** Prefer SocialService membership list when ready. */
  getMemberCommunities?: () => CommunityListRow[]
  onAnnouncement: (toast: CommunityAnnouncementToast) => void
  onVoiceStarted: (toast: CommunityVoiceToast) => void
  /** When true, skip toast (e.g. user already viewing that community modal). */
  isSuppressed?: (communityId: string, kind: 'announcement' | 'voice') => boolean
}

function trimSeenSet(seen: Set<string>): void {
  if (seen.size <= MAX_SEEN_POST_IDS) return
  const arr = [...seen]
  const drop = arr.length - MAX_SEEN_POST_IDS
  for (let i = 0; i < drop; i++) seen.delete(arr[i]!)
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/**
 * Client HUD toasts for community announcements + newly live voice streams.
 * Parity with dcl-companion:
 * - announcements: poll GET /v1/communities/{id}/posts (seed first, then toast)
 * - voice: poll GET /v1/community-voice-chats/active (seed first; toast new ids)
 */
export class CommunityHudToastWatcher {
  private readonly getAuthIdentity: CommunityHudToastWatcherOptions['getAuthIdentity']
  private readonly getUserAddress: CommunityHudToastWatcherOptions['getUserAddress']
  private readonly getMemberCommunities?: CommunityHudToastWatcherOptions['getMemberCommunities']
  private readonly onAnnouncement: CommunityHudToastWatcherOptions['onAnnouncement']
  private readonly onVoiceStarted: CommunityHudToastWatcherOptions['onVoiceStarted']
  private readonly isSuppressed?: CommunityHudToastWatcherOptions['isSuppressed']

  private disposed = false
  private announceTimer = 0
  private voiceTimer = 0
  private announceBusy = false
  private voiceBusy = false

  private readonly seenPostsByCommunity = new Map<string, Set<string>>()
  private readonly bootstrappedPosts = new Set<string>()
  private readonly knownActiveVoice = new Set<string>()
  private voiceBootstrapped = false
  private readonly lastVoiceToastAt = new Map<string, number>()
  private memberCache: CommunityListRow[] = []

  constructor(opts: CommunityHudToastWatcherOptions) {
    this.getAuthIdentity = opts.getAuthIdentity
    this.getUserAddress = opts.getUserAddress
    this.getMemberCommunities = opts.getMemberCommunities
    this.onAnnouncement = opts.onAnnouncement
    this.onVoiceStarted = opts.onVoiceStarted
    this.isSuppressed = opts.isSuppressed
  }

  start(): void {
    this.stopTimers()
    if (!this.getAuthIdentity()) return
    void this.pollAnnouncements()
    void this.pollVoice()
    this.announceTimer = window.setInterval(() => void this.pollAnnouncements(), ANNOUNCEMENT_POLL_MS)
    this.voiceTimer = window.setInterval(() => void this.pollVoice(), VOICE_POLL_MS)
  }

  stop(): void {
    this.stopTimers()
    this.resetState()
  }

  dispose(): void {
    this.disposed = true
    this.stop()
  }

  private stopTimers(): void {
    if (this.announceTimer) window.clearInterval(this.announceTimer)
    if (this.voiceTimer) window.clearInterval(this.voiceTimer)
    this.announceTimer = 0
    this.voiceTimer = 0
  }

  private resetState(): void {
    this.seenPostsByCommunity.clear()
    this.bootstrappedPosts.clear()
    this.knownActiveVoice.clear()
    this.voiceBootstrapped = false
    this.lastVoiceToastAt.clear()
    this.memberCache = []
  }

  private async resolveMembers(identity: AuthIdentity): Promise<CommunityListRow[]> {
    const fromSocial = this.getMemberCommunities?.() ?? []
    if (fromSocial.length > 0) {
      this.memberCache = fromSocial
      return fromSocial
    }
    if (this.memberCache.length > 0) return this.memberCache
    try {
      const { communities } = await fetchMemberCommunitiesSigned(identity)
      this.memberCache = communities
      return communities
    } catch {
      return this.memberCache
    }
  }

  private async pollAnnouncements(): Promise<void> {
    if (this.disposed || this.announceBusy) return
    const identity = this.getAuthIdentity()
    const address = this.getUserAddress()?.trim().toLowerCase() ?? ''
    if (!identity || !address) return

    this.announceBusy = true
    try {
      const members = await this.resolveMembers(identity)
      if (this.disposed || members.length === 0) return

      for (const row of members) {
        if (this.disposed) return
        const communityId = row.id.trim()
        if (!communityId) continue
        const idKey = communityId.toLowerCase()
        try {
          const { posts } = await fetchCommunityPosts(communityId, { identity, limit: 30 })
          let seen = this.seenPostsByCommunity.get(idKey)
          if (!seen) {
            seen = new Set()
            this.seenPostsByCommunity.set(idKey, seen)
          }

          if (!this.bootstrappedPosts.has(idKey)) {
            for (const p of posts) seen.add(p.id)
            trimSeenSet(seen)
            this.bootstrappedPosts.add(idKey)
            await sleep(INTER_COMMUNITY_DELAY_MS)
            continue
          }

          let newest: (typeof posts)[number] | null = null
          for (const p of posts) {
            if (seen.has(p.id)) continue
            const author = p.authorAddress.trim().toLowerCase()
            if (author && author === address) continue
            newest = p
            break
          }
          for (const p of posts) seen.add(p.id)
          trimSeenSet(seen)

          if (newest && !this.isSuppressed?.(communityId, 'announcement')) {
            const raw = newest.content.trim()
            const text = raw.length > 140 ? `${raw.slice(0, 137)}…` : raw
            this.onAnnouncement({
              communityId,
              communityDisplayName: row.name?.trim() || 'Community',
              text,
              imageUrl: communityDisplayImageUrl(communityId, row.thumbnails)
            })
          }
        } catch {
          /* offline / rate — next interval */
        }
        await sleep(INTER_COMMUNITY_DELAY_MS)
      }
    } finally {
      this.announceBusy = false
    }
  }

  private async pollVoice(): Promise<void> {
    if (this.disposed || this.voiceBusy) return
    const identity = this.getAuthIdentity()
    if (!identity) return

    this.voiceBusy = true
    try {
      const active = await fetchActiveCommunityVoiceChats(identity)
      if (this.disposed) return

      const nextIds = new Set(
        active.map((c) => c.communityId.trim().toLowerCase()).filter(Boolean)
      )

      if (!this.voiceBootstrapped) {
        for (const id of nextIds) this.knownActiveVoice.add(id)
        this.voiceBootstrapped = true
        return
      }

      const members = await this.resolveMembers(identity)
      const nameById = new Map(
        members.map((c) => [c.id.trim().toLowerCase(), c] as const)
      )

      const session = getCommunityVoiceSession()
      const connectedId = session.isActive()
        ? session.getCommunityId()?.trim().toLowerCase() ?? ''
        : ''

      for (const chat of active) {
        const id = chat.communityId.trim()
        const idKey = id.toLowerCase()
        if (!idKey || this.knownActiveVoice.has(idKey)) continue

        // Newly appeared while we were already tracking others.
        this.knownActiveVoice.add(idKey)

        if (connectedId && connectedId === idKey) continue
        if (this.isSuppressed?.(id, 'voice')) continue

        const now = Date.now()
        const prev = this.lastVoiceToastAt.get(idKey) ?? 0
        if (now - prev < VOICE_TOAST_DEDUPE_MS) continue
        this.lastVoiceToastAt.set(idKey, now)

        const row = nameById.get(idKey)
        const displayName =
          chat.communityName?.trim() ||
          row?.name?.trim() ||
          'Community'
        const imageUrl =
          chat.communityImage?.trim() ||
          (row ? communityDisplayImageUrl(id, row.thumbnails) : null)

        this.onVoiceStarted({
          communityId: id,
          communityDisplayName: displayName,
          imageUrl
        })
      }

      // Drop ids no longer active so a later restart can toast again after bootstrap window.
      for (const id of [...this.knownActiveVoice]) {
        if (!nextIds.has(id)) this.knownActiveVoice.delete(id)
      }
    } finally {
      this.voiceBusy = false
    }
  }
}
