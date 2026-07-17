import type { AuthIdentity } from '@dcl/crypto/dist/types'
import { fetchActiveCommunityVoiceChats } from '../../../network/gatekeeper/communityVoice'
import { getCommunityVoiceSession } from '../../../social/CommunityVoiceSession'
import {
  fetchCommunityPosts,
  fetchMemberCommunitiesSigned
} from '../../../social/socialApi'
import {
  CommunityVoiceChatStatus,
  consumeCommunityVoiceChatUpdates
} from '../../../social/socialServiceV2'
import type { CommunityListRow } from '../../../social/types'
import { communityDisplayImageUrl } from '../../../social/communityThumbnails'

/** Companion: poll member community posts ~90s (no Social realtime post stream). */
const ANNOUNCEMENT_POLL_MS = 90_000
/** REST fallback if Social WS stream is unavailable. */
const VOICE_POLL_MS = 45_000
const VOICE_STREAM_RETRY_MS = 4_000
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
  getMemberCommunities?: () => CommunityListRow[]
  onAnnouncement: (toast: CommunityAnnouncementToast) => void
  onVoiceStarted: (toast: CommunityVoiceToast) => void
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
 * - announcements: poll posts (seed first)
 * - voice: Social v2 SubscribeToCommunityVoiceChatUpdates (instant) + REST poll fallback
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
  private voicePollTimer = 0
  private announceBusy = false
  private voicePollBusy = false
  private voiceStreamAbort: AbortController | null = null
  private voiceStreamLoop = 0

  private readonly seenPostsByCommunity = new Map<string, Set<string>>()
  private readonly bootstrappedPosts = new Set<string>()
  private readonly knownActiveVoice = new Set<string>()
  private voiceBootstrapped = false
  private readonly lastVoiceToastAt = new Map<string, number>()
  private memberCache: CommunityListRow[] = []
  /** Prefer WS stream; use REST poll only as seed/fallback. */
  private voiceStreamHealthy = false

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
    void this.seedVoiceFromRest()
    this.announceTimer = window.setInterval(() => void this.pollAnnouncements(), ANNOUNCEMENT_POLL_MS)
    this.voicePollTimer = window.setInterval(() => void this.pollVoiceFallback(), VOICE_POLL_MS)
    this.startVoiceStreamLoop()
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
    if (this.voicePollTimer) window.clearInterval(this.voicePollTimer)
    this.announceTimer = 0
    this.voicePollTimer = 0
    this.voiceStreamAbort?.abort()
    this.voiceStreamAbort = null
    this.voiceStreamLoop++
  }

  private resetState(): void {
    this.seenPostsByCommunity.clear()
    this.bootstrappedPosts.clear()
    this.knownActiveVoice.clear()
    this.voiceBootstrapped = false
    this.voiceStreamHealthy = false
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

  private startVoiceStreamLoop(): void {
    const loopId = ++this.voiceStreamLoop
    this.voiceStreamAbort?.abort()
    const ac = new AbortController()
    this.voiceStreamAbort = ac

    void (async () => {
      while (!this.disposed && loopId === this.voiceStreamLoop && !ac.signal.aborted) {
        const identity = this.getAuthIdentity()
        if (!identity) {
          await sleep(VOICE_STREAM_RETRY_MS)
          continue
        }
        try {
          await consumeCommunityVoiceChatUpdates(
            identity,
            (update) => {
              void this.handleVoiceStreamUpdate(update)
            },
            ac.signal
          )
          this.voiceStreamHealthy = false
        } catch {
          this.voiceStreamHealthy = false
          if (this.disposed || ac.signal.aborted || loopId !== this.voiceStreamLoop) return
          await sleep(VOICE_STREAM_RETRY_MS)
        }
      }
    })()
  }

  private async handleVoiceStreamUpdate(update: {
    communityId?: string
    communityName?: string
    status?: CommunityVoiceChatStatus
    isMember?: boolean
  }): Promise<void> {
    this.voiceStreamHealthy = true
    const id = String(update.communityId ?? '').trim()
    const idKey = id.toLowerCase()
    if (!id || update.isMember === false) return

    if (update.status === CommunityVoiceChatStatus.COMMUNITY_VOICE_CHAT_ENDED) {
      this.knownActiveVoice.delete(idKey)
      return
    }

    if (update.status !== CommunityVoiceChatStatus.COMMUNITY_VOICE_CHAT_STARTED) return

    // First events after connect may include already-live rooms — seed without toasting
    // until REST seed finished once.
    if (!this.voiceBootstrapped) {
      this.knownActiveVoice.add(idKey)
      return
    }

    if (this.knownActiveVoice.has(idKey)) return
    this.knownActiveVoice.add(idKey)

    const session = getCommunityVoiceSession()
    const connectedId = session.isActive()
      ? session.getCommunityId()?.trim().toLowerCase() ?? ''
      : ''
    if (connectedId && connectedId === idKey) return
    if (this.isSuppressed?.(id, 'voice')) return

    const now = Date.now()
    const prev = this.lastVoiceToastAt.get(idKey) ?? 0
    if (now - prev < VOICE_TOAST_DEDUPE_MS) return
    this.lastVoiceToastAt.set(idKey, now)

    const members = this.getMemberCommunities?.() ?? this.memberCache
    const row = members.find((c) => c.id.trim().toLowerCase() === idKey)
    const displayName =
      String(update.communityName ?? '').trim() || row?.name?.trim() || 'Community'

    this.onVoiceStarted({
      communityId: id,
      communityDisplayName: displayName,
      imageUrl: row ? communityDisplayImageUrl(id, row.thumbnails) : null
    })
  }

  private async seedVoiceFromRest(): Promise<void> {
    const identity = this.getAuthIdentity()
    if (!identity) return
    try {
      const active = await fetchActiveCommunityVoiceChats(identity)
      for (const c of active) {
        const k = c.communityId.trim().toLowerCase()
        if (k) this.knownActiveVoice.add(k)
      }
      this.voiceBootstrapped = true
    } catch {
      this.voiceBootstrapped = true
    }
  }

  /** Fallback when WS is down — same REST poll as before. */
  private async pollVoiceFallback(): Promise<void> {
    if (this.disposed || this.voicePollBusy || this.voiceStreamHealthy) return
    const identity = this.getAuthIdentity()
    if (!identity) return

    this.voicePollBusy = true
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
      const nameById = new Map(members.map((c) => [c.id.trim().toLowerCase(), c] as const))
      const session = getCommunityVoiceSession()
      const connectedId = session.isActive()
        ? session.getCommunityId()?.trim().toLowerCase() ?? ''
        : ''

      for (const chat of active) {
        const id = chat.communityId.trim()
        const idKey = id.toLowerCase()
        if (!idKey || this.knownActiveVoice.has(idKey)) continue
        this.knownActiveVoice.add(idKey)
        if (connectedId && connectedId === idKey) continue
        if (this.isSuppressed?.(id, 'voice')) continue

        const now = Date.now()
        const prev = this.lastVoiceToastAt.get(idKey) ?? 0
        if (now - prev < VOICE_TOAST_DEDUPE_MS) continue
        this.lastVoiceToastAt.set(idKey, now)

        const row = nameById.get(idKey)
        this.onVoiceStarted({
          communityId: id,
          communityDisplayName: chat.communityName?.trim() || row?.name?.trim() || 'Community',
          imageUrl:
            chat.communityImage?.trim() ||
            (row ? communityDisplayImageUrl(id, row.thumbnails) : null)
        })
      }

      for (const id of [...this.knownActiveVoice]) {
        if (!nextIds.has(id)) this.knownActiveVoice.delete(id)
      }
    } finally {
      this.voicePollBusy = false
    }
  }
}
