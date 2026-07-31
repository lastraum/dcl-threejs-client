/**
 * Shared real-time bus for community voice started/ended.
 *
 * Dual path (no polling):
 * 1. **PM LiveKit** room topic `d3js-community-voice` — reliable for guests + wallets
 *    already in the private-messages room (same pattern as pool claims).
 * 2. **Social Service v2** `SubscribeToCommunityVoiceChatUpdates` — Explorer path;
 *    kept as best-effort (often flaps with "RPC Transport closed").
 *
 * LiveKit *media* room is separate (after Join). Discovery does not poll REST.
 */
import type { AuthIdentity } from '@dcl/crypto/dist/types'
import { fetchActiveCommunityVoiceChats } from '../network/gatekeeper/communityVoice'
import {
  CommunityVoiceChatStatus,
  consumeCommunityVoiceChatUpdates,
  invalidateSocialV2Transport,
  type CommunityVoiceChatUpdate
} from './socialServiceV2'
import { getPrivateMessagesService } from './PrivateMessagesService'
import type { CommunityVoiceSignalMsg } from './communityVoiceWire'
import { clientDebugLog } from '../client/debug/ClientDebugLog'

export type CommunityVoiceLiveEvent = {
  communityId: string
  status: 'started' | 'ended'
  communityName?: string
  communityImage?: string
  /** From social WS when present */
  isMember?: boolean
  source: 'ws' | 'livekit' | 'local' | 'seed'
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
/** One-shot retransmits after start (not polling) — cover connect races / late peers. */
const START_RETRANSMIT_MS = [0, 800, 2500] as const

function sessionKey(id: AuthIdentity): string {
  return String(id.ephemeralIdentity?.address ?? '').toLowerCase()
}

/** Root wallet from AuthChain (SIGNER), not the ephemeral session key. */
function walletFromAuthIdentity(id: AuthIdentity): string {
  const chain = id.authChain
  if (!Array.isArray(chain)) return ''
  for (const link of chain) {
    const p = typeof link?.payload === 'string' ? link.payload.trim().toLowerCase() : ''
    if (/^0x[a-f0-9]{40}$/.test(p)) return p
  }
  return ''
}

function normalizeWallet(addr: string | null | undefined): string {
  const a = (addr ?? '').trim().toLowerCase()
  return /^0x[a-f0-9]{40}$/.test(a) ? a : ''
}

function normalizeId(id: string): string {
  return id.trim().toLowerCase()
}

class CommunityVoiceUpdatesBus {
  private readonly listeners = new Set<Listener>()
  private readonly active = new Map<string, CommunityVoiceActiveEntry>()
  private identity: AuthIdentity | null = null
  private identityKey = ''
  /** Real wallet (0x…) for PM LiveKit — never ephemeral. */
  private walletAddress = ''
  private abort: AbortController | null = null
  private loopId = 0
  private started = false
  private streamHealthy = false
  private unsubPmVoice: (() => void) | null = null
  private pmHeld = false
  private retransmitTimers = new Set<number>()

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
   * Bind to a signed identity and keep one WS subscription + PM signal path alive.
   * Safe to call repeatedly (e.g. on login change).
   * @param walletAddress Optional real wallet — preferred over AuthChain parse for PM connect.
   */
  ensureStarted(identity: AuthIdentity | null, walletAddress?: string | null): void {
    if (!identity) {
      this.stop()
      return
    }
    const key = sessionKey(identity)
    const wallet = normalizeWallet(walletAddress) || walletFromAuthIdentity(identity)
    if (this.started && this.identityKey === key) {
      // Refresh wallet if caller now has a better address; keep streams.
      if (wallet && wallet !== this.walletAddress) this.walletAddress = wallet
      return
    }
    this.stop()
    this.identity = identity
    this.identityKey = key
    this.walletAddress = wallet
    this.started = true
    this.wirePmLiveKit(identity)
    void this.seedFromRestOnce()
    this.startStreamLoop()
  }

  stop(): void {
    this.loopId++
    this.abort?.abort()
    this.abort = null
    this.clearRetransmits()
    this.unsubPmVoice?.()
    this.unsubPmVoice = null
    this.releasePmHold()
    this.started = false
    this.streamHealthy = false
    this.identity = null
    this.identityKey = ''
    this.walletAddress = ''
    // Keep `active` map until next ensureStarted seed so late UI can still paint once.
  }

  /** Starter client: local UI + PM LiveKit fan-out (reaches guests in PM room). */
  notifyLocalStarted(
    communityId: string,
    meta?: { communityName?: string; communityImage?: string; starterAddress?: string }
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
    const starter = normalizeWallet(meta?.starterAddress) || this.walletAddress
    if (starter) this.walletAddress = starter
    const msg: CommunityVoiceSignalMsg = {
      t: 'voice',
      s: 'started',
      c: id,
      n: meta?.communityName,
      img: meta?.communityImage,
      a: starter || undefined,
      at: Date.now()
    }
    this.scheduleStartedBroadcasts(msg)
  }

  /** Local end / last-mod leave. */
  notifyLocalEnded(communityId: string, meta?: { starterAddress?: string }): void {
    const id = communityId.trim()
    if (!id) return
    this.clearRetransmits()
    this.active.delete(normalizeId(id))
    this.emit({
      communityId: id,
      status: 'ended',
      source: 'local'
    })
    const starter = normalizeWallet(meta?.starterAddress) || this.walletAddress
    void this.publishPmSignal({
      t: 'voice',
      s: 'ended',
      c: id,
      a: starter || undefined,
      at: Date.now()
    })
  }

  private scheduleStartedBroadcasts(msg: CommunityVoiceSignalMsg): void {
    this.clearRetransmits()
    for (const delay of START_RETRANSMIT_MS) {
      const t = window.setTimeout(() => {
        this.retransmitTimers.delete(t)
        if (!this.active.has(normalizeId(msg.c))) return
        void this.publishPmSignal({ ...msg, at: Date.now() })
      }, delay)
      this.retransmitTimers.add(t)
    }
  }

  private clearRetransmits(): void {
    for (const t of this.retransmitTimers) window.clearTimeout(t)
    this.retransmitTimers.clear()
  }

  private wirePmLiveKit(identity: AuthIdentity): void {
    this.unsubPmVoice?.()
    const pm = getPrivateMessagesService()
    if (!this.pmHeld) {
      pm.retain()
      this.pmHeld = true
    }
    // Ensure PM room is up so we can receive + send voice signals (guest + wallet).
    const addr = this.walletAddress || walletFromAuthIdentity(identity)
    if (addr) {
      void pm.connect(identity, addr).then((ok) => {
        if (!this.started) return
        clientDebugLog.log(
          'social',
          ok && pm.isConnected()
            ? `Community voice PM path ready · remotes=${pm.getRemoteIdentities().length}`
            : `Community voice PM path offline — ${pm.getLastError() ?? 'connect failed'}`,
          { level: ok && pm.isConnected() ? 'success' : 'warn', alsoConsole: true }
        )
      })
    } else {
      clientDebugLog.log(
        'social',
        'Community voice PM path skipped — no wallet address on identity',
        { level: 'warn', alsoConsole: true }
      )
    }
    this.unsubPmVoice = pm.subscribeCommunityVoiceSignal((ev) => {
      if (!this.started) return
      const msg = ev.msg
      const id = msg.c.trim()
      if (!id) return
      const key = normalizeId(id)
      if (msg.s === 'ended') {
        this.active.delete(key)
        this.emit({
          communityId: id,
          status: 'ended',
          communityName: msg.n,
          communityImage: msg.img,
          isMember: true,
          source: 'livekit'
        })
        return
      }
      const prev = this.active.get(key)
      this.active.set(key, {
        communityId: id,
        communityName: msg.n ?? prev?.communityName,
        communityImage: msg.img ?? prev?.communityImage,
        participantCount: prev?.participantCount ?? 1,
        moderatorCount: prev?.moderatorCount ?? 1
      })
      this.emit({
        communityId: id,
        status: 'started',
        communityName: msg.n,
        communityImage: msg.img,
        isMember: true,
        source: 'livekit'
      })
    })
  }

  private releasePmHold(): void {
    if (!this.pmHeld) return
    getPrivateMessagesService().release()
    this.pmHeld = false
  }

  /**
   * Publish on PM LiveKit — same retain/connect/flush pattern as pool claims.
   * Uses real wallet address (never ephemeral session key).
   */
  private async publishPmSignal(msg: CommunityVoiceSignalMsg): Promise<void> {
    const pm = getPrivateMessagesService()
    const identity = this.identity
    const addr = normalizeWallet(msg.a) || this.walletAddress

    pm.retain()
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        if (identity && addr) {
          await pm.connect(identity, addr)
        }
        if (pm.isConnected()) {
          const ok = await pm.sendCommunityVoiceSignal(msg)
          if (ok) {
            // Brief hold so reliable SCTP can flush before optional teardown on release.
            await sleep(300)
            return
          }
        }
        await sleep(400 * (attempt + 1))
      }
      clientDebugLog.log(
        'social',
        `Community voice PM LiveKit signal not sent (${msg.s}) — peers may miss instant update · ${
          pm.getLastError() ?? 'unknown'
        }`,
        { level: 'warn', alsoConsole: true }
      )
    } finally {
      pm.release()
    }
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
      // Merge only — never wipe LiveKit/local actives with a lagging empty REST list.
      for (const row of list) {
        const id = row.communityId.trim()
        if (!id) continue
        const key = normalizeId(id)
        const prev = this.active.get(key)
        this.active.set(key, {
          communityId: id,
          communityName: row.communityName ?? prev?.communityName,
          communityImage: row.communityImage ?? prev?.communityImage,
          participantCount: row.participantCount,
          moderatorCount: row.moderatorCount
        })
        // Only seed-emit communities we did not already know (avoid toast noise).
        if (!prev) {
          this.emit({
            communityId: id,
            status: 'started',
            communityName: row.communityName,
            communityImage: row.communityImage,
            isMember: true,
            source: 'seed'
          })
        }
      }
      clientDebugLog.log(
        'social',
        `Community voice bus seed · ${list.length} active (map=${this.active.size})`,
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
          // Stream ended cleanly — still drop zombie RPC so join/start reconnect.
          invalidateSocialV2Transport()
        } catch (err) {
          this.streamHealthy = false
          if (!this.started || ac.signal.aborted || loopId !== this.loopId) return
          // "RPC Transport closed" leaves a dead cached client — force reconnect path.
          invalidateSocialV2Transport()
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
