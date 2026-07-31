/**
 * Shared real-time bus for community voice started/ended.
 *
 * Explorer path: Social Service v2 `SubscribeToCommunityVoiceChatUpdates` (WS).
 * LiveKit is only the media room after join — stream *discovery* is this social stream,
 * not scene LiveKit and not REST polling.
 */
import type { AuthIdentity } from '@dcl/crypto/dist/types'
import { fetchActiveCommunityVoiceChats } from '../network/gatekeeper/communityVoice'
import {
  CommunityVoiceChatStatus,
  consumeCommunityVoiceChatUpdates,
  type CommunityVoiceChatUpdate
} from './socialServiceV2'
import { clientDebugLog } from '../client/debug/ClientDebugLog'

export type CommunityVoiceLiveEvent = {
  communityId: string
  status: 'started' | 'ended'
  communityName?: string
  communityImage?: string
  /** From social WS when present */
  isMember?: boolean
  source: 'ws' | 'local' | 'seed'
}

export type CommunityVoiceActiveEntry = {
  communityId: string
  communityName?: string
  communityImage?: string
  participantCount: number
  moderatorCount: number
}

type Listener = (ev: CommunityVoiceLiveEvent) => void

const RETRY_MS = 3_000

function identityKey(id: AuthIdentity): string {
  return String(id.ephemeralIdentity?.address ?? '').toLowerCase()
}

function normalizeId(id: string): string {
  return id.trim().toLowerCase()
}

class CommunityVoiceUpdatesBus {
  private readonly listeners = new Set<Listener>()
  private readonly active = new Map<string, CommunityVoiceActiveEntry>()
  private identity: AuthIdentity | null = null
  private identityKey = ''
  private abort: AbortController | null = null
  private loopId = 0
  private started = false
  private streamHealthy = false

  /** Subscribe to started/ended. Emits current actives as synthetic seed events on first attach optional — use getActive() instead. */
  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  isStreamHealthy(): boolean {
    return this.streamHealthy
  }

  getActive(): CommunityVoiceActiveEntry[] {
    return [...this.active.values()]
  }

  isActive(communityId: string): boolean {
    return this.active.has(normalizeId(communityId))
  }

  /**
   * Bind to a signed identity and keep one WS subscription alive.
   * Safe to call repeatedly (e.g. on login change).
   */
  ensureStarted(identity: AuthIdentity | null): void {
    if (!identity) {
      this.stop()
      return
    }
    const key = identityKey(identity)
    if (this.started && this.identityKey === key) return
    this.stop()
    this.identity = identity
    this.identityKey = key
    this.started = true
    void this.seedFromRestOnce()
    this.startStreamLoop()
  }

  stop(): void {
    this.loopId++
    this.abort?.abort()
    this.abort = null
    this.started = false
    this.streamHealthy = false
    this.identity = null
    this.identityKey = ''
    // Keep `active` map until next ensureStarted seed so late UI can still paint once.
  }

  /** Starter client: broadcast immediately so local browse/modal update without waiting for WS echo. */
  notifyLocalStarted(
    communityId: string,
    meta?: { communityName?: string; communityImage?: string }
  ): void {
    const id = communityId.trim()
    if (!id) return
    const key = normalizeId(id)
    const prev = this.active.get(key)
    this.active.set(key, {
      communityId: id,
      communityName: meta?.communityName ?? prev?.communityName,
      communityImage: meta?.communityImage ?? prev?.communityImage,
      participantCount: prev?.participantCount ?? 1,
      moderatorCount: prev?.moderatorCount ?? 1
    })
    this.emit({
      communityId: id,
      status: 'started',
      communityName: meta?.communityName,
      communityImage: meta?.communityImage,
      isMember: true,
      source: 'local'
    })
  }

  /** Local end / last-mod leave. */
  notifyLocalEnded(communityId: string): void {
    const id = communityId.trim()
    if (!id) return
    this.active.delete(normalizeId(id))
    this.emit({
      communityId: id,
      status: 'ended',
      source: 'local'
    })
  }

  private emit(ev: CommunityVoiceLiveEvent): void {
    for (const fn of this.listeners) {
      try {
        fn(ev)
      } catch {
        /* ignore */
      }
    }
  }

  private async seedFromRestOnce(): Promise<void> {
    const identity = this.identity
    if (!identity) return
    try {
      const list = await fetchActiveCommunityVoiceChats(identity)
      if (!this.started || this.identity !== identity) return
      this.active.clear()
      for (const row of list) {
        const id = row.communityId.trim()
        if (!id) continue
        this.active.set(normalizeId(id), {
          communityId: id,
          communityName: row.communityName,
          communityImage: row.communityImage,
          participantCount: row.participantCount,
          moderatorCount: row.moderatorCount
        })
        this.emit({
          communityId: id,
          status: 'started',
          communityName: row.communityName,
          communityImage: row.communityImage,
          isMember: true,
          source: 'seed'
        })
      }
      clientDebugLog.log(
        'social',
        `Community voice bus seed · ${list.length} active`,
        { level: 'info', alsoConsole: true }
      )
    } catch (err) {
      clientDebugLog.log(
        'social',
        `Community voice bus seed failed — ${err instanceof Error ? err.message : err}`,
        { level: 'warn', alsoConsole: true }
      )
    }
  }

  private startStreamLoop(): void {
    const loopId = ++this.loopId
    this.abort?.abort()
    const ac = new AbortController()
    this.abort = ac

    void (async () => {
      while (this.started && loopId === this.loopId && !ac.signal.aborted) {
        const identity = this.identity
        if (!identity) {
          await sleep(RETRY_MS)
          continue
        }
        try {
          await consumeCommunityVoiceChatUpdates(
            identity,
            (update) => this.handleWsUpdate(update),
            ac.signal
          )
          this.streamHealthy = false
        } catch (err) {
          this.streamHealthy = false
          if (!this.started || ac.signal.aborted || loopId !== this.loopId) return
          clientDebugLog.log(
            'social',
            `Community voice WS stream dropped — retry in ${RETRY_MS}ms · ${
              err instanceof Error ? err.message : err
            }`,
            { level: 'warn', alsoConsole: true, throttleMs: 8_000, throttleKey: 'voice-bus-ws-drop' }
          )
          await sleep(RETRY_MS)
        }
      }
    })()
  }

  private handleWsUpdate(update: CommunityVoiceChatUpdate): void {
    this.streamHealthy = true
    const id = String(update.communityId ?? '').trim()
    if (!id) return
    // Server may omit isMember; only skip explicit non-members.
    if (update.isMember === false) return

    const key = normalizeId(id)
    const name = String(update.communityName ?? '').trim() || undefined
    const image =
      typeof update.communityImage === 'string' && update.communityImage.trim()
        ? update.communityImage.trim()
        : undefined

    if (update.status === CommunityVoiceChatStatus.COMMUNITY_VOICE_CHAT_ENDED) {
      this.active.delete(key)
      this.emit({
        communityId: id,
        status: 'ended',
        communityName: name,
        communityImage: image,
        isMember: update.isMember,
        source: 'ws'
      })
      return
    }

    if (update.status !== CommunityVoiceChatStatus.COMMUNITY_VOICE_CHAT_STARTED) return

    const prev = this.active.get(key)
    this.active.set(key, {
      communityId: id,
      communityName: name ?? prev?.communityName,
      communityImage: image ?? prev?.communityImage,
      participantCount: prev?.participantCount ?? 0,
      moderatorCount: prev?.moderatorCount ?? 0
    })
    this.emit({
      communityId: id,
      status: 'started',
      communityName: name,
      communityImage: image,
      isMember: update.isMember,
      source: 'ws'
    })
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** App-wide singleton — one Social WS for voice discovery. */
export const communityVoiceUpdatesBus = new CommunityVoiceUpdatesBus()
