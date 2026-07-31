import type { AuthIdentity } from '@dcl/crypto/dist/types'
import { getCommunityVoiceSession } from '../../../social/CommunityVoiceSession'
import {
  communityVoiceUpdatesBus,
  type CommunityVoiceLiveEvent
} from '../../../social/communityVoiceUpdatesBus'
import {
  fetchCommunityPosts,
  fetchMemberCommunitiesSigned
} from '../../../social/socialApi'
import type { CommunityListRow } from '../../../social/types'
import { communityDisplayImageUrl } from '../../../social/communityThumbnails'

/** Companion: poll member community posts ~90s (no Social realtime post stream). */
const ANNOUNCEMENT_POLL_MS = 90_000
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
 * - announcements: poll posts (seed first) — Social has no post push stream
 * - voice: shared Social WS bus (`communityVoiceUpdatesBus`) — no REST polling
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
  private announceBusy = false
  private unsubVoiceBus: (() => void) | null = null

  private readonly seenPostsByCommunity = new Map<string, Set<string>>()
  private readonly bootstrappedPosts = new Set<string>()
  private readonly knownActiveVoice = new Set<string>()
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
    const identity = this.getAuthIdentity()
    if (!identity) return
    void this.pollAnnouncements()
    this.announceTimer = window.setInterval(() => void this.pollAnnouncements(), ANNOUNCEMENT_POLL_MS)
    this.wireVoiceBus(identity)
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
    this.announceTimer = 0
    this.unsubVoiceBus?.()
    this.unsubVoiceBus = null
  }

  private resetState(): void {
    this.seenPostsByCommunity.clear()
    this.bootstrappedPosts.clear()
    this.knownActiveVoice.clear()
    this.lastVoiceToastAt.clear()
    this.memberCache = []
  }

  private wireVoiceBus(identity: AuthIdentity): void {
    this.unsubVoiceBus?.()
    const wallet = this.getUserAddress()?.trim().toLowerCase() ?? null
    communityVoiceUpdatesBus.ensureStarted(identity, wallet)
    // Seed known set from bus (one-time REST seed inside bus) without toasting.
    for (const row of communityVoiceUpdatesBus.getActive()) {
      const k = row.communityId.trim().toLowerCase()
      if (k) this.knownActiveVoice.add(k)
    }
    this.unsubVoiceBus = communityVoiceUpdatesBus.subscribe((ev) => {
      if (this.disposed) return
      void this.handleVoiceEvent(ev)
    })
  }

  private async handleVoiceEvent(ev: CommunityVoiceLiveEvent): Promise<void> {
    const id = ev.communityId.trim()
    const idKey = id.toLowerCase()
    if (!id) return
    if (ev.isMember === false) return

    if (ev.status === 'ended') {
      this.knownActiveVoice.delete(idKey)
      return
    }

    if (ev.status !== 'started') return

    // Seed events only fill the known set (already live when we connected).
    if (ev.source === 'seed') {
      this.knownActiveVoice.add(idKey)
      return
    }

    if (this.knownActiveVoice.has(idKey)) return
    this.knownActiveVoice.add(idKey)

    // Don't toast for rooms we ourselves just joined/started.
    const session = getCommunityVoiceSession()
    const connectedId = session.isActive()
      ? session.getCommunityId()?.trim().toLowerCase() ?? ''
      : ''
    if (connectedId && connectedId === idKey) return
    if (ev.source === 'local') return
    // LiveKit PM fan-out + Social WS both fire — toast once.
    if (this.isSuppressed?.(id, 'voice')) return

    const now = Date.now()
    const prev = this.lastVoiceToastAt.get(idKey) ?? 0
    if (now - prev < VOICE_TOAST_DEDUPE_MS) return
    this.lastVoiceToastAt.set(idKey, now)

    const identity = this.getAuthIdentity()
    const members = identity
      ? await this.resolveMembers(identity)
      : this.getMemberCommunities?.() ?? this.memberCache
    const row = members.find((c) => c.id.trim().toLowerCase() === idKey)
    const displayName =
      String(ev.communityName ?? '').trim() || row?.name?.trim() || 'Community'

    this.onVoiceStarted({
      communityId: id,
      communityDisplayName: displayName,
      imageUrl:
        ev.communityImage?.trim() ||
        (row ? communityDisplayImageUrl(id, row.thumbnails) : null)
    })
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
}
