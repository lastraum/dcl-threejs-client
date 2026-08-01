/**
 * Global Live directory — who is broadcasting right now.
 *
 * - Always-on receive when PM is connected
 * - Local Go Live → start/hb/stop on `d3js-live`
 * - TTL sweep removes dead sessions; listeners teardown PiP
 */

import { clientDebugLog } from '../client/debug/ClientDebugLog'
import {
  GLOBAL_LIVE_HEARTBEAT_MS,
  GLOBAL_LIVE_SWEEP_MS,
  GLOBAL_LIVE_TTL_MS,
  parseMediaFromPlayUrl,
  type GlobalLiveMedia,
  type GlobalLiveWireMsg,
  type LiveSession
} from './globalLiveWire'

export type LiveDirectoryListener = (sessions: readonly LiveSession[]) => void

export type LiveDirectoryPublish = (msg: GlobalLiveWireMsg) => Promise<boolean>

export type LiveDirectoryControllerOpts = {
  publish: LiveDirectoryPublish
  getLocalAddress: () => string | null
  getDisplayName: () => string
}

function newSessionId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `live-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

export class LiveDirectoryController {
  private readonly sessions = new Map<string, LiveSession>()
  private readonly listeners = new Set<LiveDirectoryListener>()
  private readonly endedListeners = new Set<(sessionId: string) => void>()
  private hbTimer: ReturnType<typeof setInterval> | null = null
  private sweepTimer: ReturnType<typeof setInterval> | null = null
  private broadcasting: LiveSession | null = null
  private disposed = false

  constructor(private readonly opts: LiveDirectoryControllerOpts) {
    this.sweepTimer = setInterval(() => this.sweep(), GLOBAL_LIVE_SWEEP_MS)
  }

  dispose(): void {
    this.disposed = true
    void this.endLive()
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer)
      this.sweepTimer = null
    }
    this.listeners.clear()
    this.endedListeners.clear()
    this.sessions.clear()
  }

  subscribe(listener: LiveDirectoryListener): () => void {
    this.listeners.add(listener)
    listener(this.list())
    return () => this.listeners.delete(listener)
  }

  /** Fired when a session disappears (TTL, stop, self-end) — close PiP. */
  onSessionEnded(listener: (sessionId: string) => void): () => void {
    this.endedListeners.add(listener)
    return () => this.endedListeners.delete(listener)
  }

  list(): LiveSession[] {
    return [...this.sessions.values()].sort((a, b) => b.lastSeenAt - a.lastSeenAt)
  }

  get(sessionId: string): LiveSession | null {
    return this.sessions.get(sessionId) ?? null
  }

  isBroadcasting(): boolean {
    return this.broadcasting !== null
  }

  getBroadcasting(): LiveSession | null {
    return this.broadcasting
  }

  /**
   * Go Live with a playable URL (HLS / progressive https).
   * Publish keys for OBS stay out of band.
   */
  async goLive(playUrl: string, title?: string): Promise<{ ok: true } | { ok: false; error: string }> {
    const media = parseMediaFromPlayUrl(playUrl)
    if (!media) {
      return {
        ok: false,
        error: 'Enter a playable https stream URL (HLS .m3u8 or progressive video)'
      }
    }
    return this.goLiveWithMedia(media, title)
  }

  /**
   * Go Live with an already-resolved media pointer (HLS/http or DCL world cast).
   */
  async goLiveWithMedia(
    media: GlobalLiveMedia,
    title?: string
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    if (this.disposed) return { ok: false, error: 'Live directory disposed' }
    const address = this.opts.getLocalAddress()?.trim().toLowerCase() ?? ''
    if (!/^0x[a-f0-9]{40}$/.test(address)) {
      return { ok: false, error: 'Sign in with a wallet to go live' }
    }
    if (this.broadcasting) await this.endLive()

    const sessionId = newSessionId()
    const displayName = this.opts.getDisplayName().trim().slice(0, 48) || shortAddr(address)
    const cleanTitle = title?.trim().slice(0, 80) || undefined
    const defaultTitle =
      media.type === 'dcl-cast'
        ? `${displayName} · ${media.worldName}`
        : `${displayName}'s stream`
    const session: LiveSession = {
      sessionId,
      hostAddress: address,
      displayName,
      title: cleanTitle ?? defaultTitle,
      media,
      lastSeenAt: Date.now(),
      isSelf: true
    }
    this.broadcasting = session
    this.upsert(session, false)
    const startMsg: GlobalLiveWireMsg = {
      t: 'start',
      s: sessionId,
      a: address,
      n: displayName,
      at: Date.now(),
      m: media,
      title: cleanTitle
    }
    const published = await this.opts.publish(startMsg)
    if (!published) {
      this.broadcasting = null
      this.removeSession(sessionId, false)
      return { ok: false, error: 'Could not publish to live directory (PM room not ready)' }
    }
    this.startHeartbeat()
    const mediaLabel =
      media.type === 'dcl-cast' ? `dcl-cast:${media.worldName}` : media.type
    clientDebugLog.log('social', `Live goLive session=${sessionId.slice(0, 8)} media=${mediaLabel}`, {
      level: 'success',
      alsoConsole: true
    })
    return { ok: true }
  }

  async endLive(): Promise<void> {
    const b = this.broadcasting
    this.stopHeartbeat()
    if (!b) return
    this.broadcasting = null
    const stopMsg: GlobalLiveWireMsg = {
      t: 'stop',
      s: b.sessionId,
      a: b.hostAddress,
      at: Date.now()
    }
    try {
      await this.opts.publish(stopMsg)
    } catch {
      /* best effort */
    }
    this.removeSession(b.sessionId, true)
    clientDebugLog.log('social', `Live endLive session=${b.sessionId.slice(0, 8)}`, {
      alsoConsole: true
    })
  }

  handleRemote(fromAddress: string, msg: GlobalLiveWireMsg): void {
    if (this.disposed) return
    const from = fromAddress.trim().toLowerCase()
    const me = this.opts.getLocalAddress()?.trim().toLowerCase() ?? ''
    if (msg.t === 'stop') {
      // Prefer session id; host wallet as secondary match.
      if (this.sessions.has(msg.s)) this.removeSession(msg.s, true)
      else {
        for (const [id, s] of this.sessions) {
          if (s.hostAddress === msg.a || s.hostAddress === from) this.removeSession(id, true)
        }
      }
      return
    }
    // start | hb
    if (me && msg.a === me) {
      // Echo of self — keep local broadcasting row authoritative.
      if (this.broadcasting && this.broadcasting.sessionId === msg.s) {
        this.broadcasting.lastSeenAt = Date.now()
        this.upsert(this.broadcasting, false)
      }
      return
    }
    const session: LiveSession = {
      sessionId: msg.s,
      hostAddress: msg.a || from,
      displayName: msg.n,
      title: msg.title?.trim() || `${msg.n}'s stream`,
      media: msg.m,
      lastSeenAt: msg.at || Date.now(),
      isSelf: false
    }
    // One row per host — replace older session from same wallet.
    for (const [id, s] of this.sessions) {
      if (s.hostAddress === session.hostAddress && id !== session.sessionId) {
        this.removeSession(id, true)
      }
    }
    this.upsert(session, true)
  }

  private startHeartbeat(): void {
    this.stopHeartbeat()
    this.hbTimer = setInterval(() => {
      void this.sendHeartbeat()
    }, GLOBAL_LIVE_HEARTBEAT_MS)
    void this.sendHeartbeat()
  }

  private stopHeartbeat(): void {
    if (this.hbTimer) {
      clearInterval(this.hbTimer)
      this.hbTimer = null
    }
  }

  private async sendHeartbeat(): Promise<void> {
    const b = this.broadcasting
    if (!b) return
    b.lastSeenAt = Date.now()
    this.upsert(b, false)
    const msg: GlobalLiveWireMsg = {
      t: 'hb',
      s: b.sessionId,
      a: b.hostAddress,
      n: b.displayName,
      at: b.lastSeenAt,
      m: b.media,
      title: b.title
    }
    const ok = await this.opts.publish(msg)
    if (!ok) {
      clientDebugLog.log('social', 'Live heartbeat publish failed — will retry', {
        level: 'warn',
        alsoConsole: true,
        throttleMs: 8000,
        throttleKey: 'live-hb-fail'
      })
    }
  }

  private sweep(): void {
    const now = Date.now()
    for (const [id, s] of this.sessions) {
      if (s.isSelf && this.broadcasting?.sessionId === id) continue
      if (now - s.lastSeenAt > GLOBAL_LIVE_TTL_MS) {
        this.removeSession(id, true)
      }
    }
  }

  private upsert(session: LiveSession, notify: boolean): void {
    this.sessions.set(session.sessionId, { ...session })
    if (notify !== false) this.emit()
    else this.emit()
  }

  private removeSession(sessionId: string, notifyEnded: boolean): void {
    if (!this.sessions.delete(sessionId)) return
    if (notifyEnded) {
      for (const l of this.endedListeners) {
        try {
          l(sessionId)
        } catch {
          /* ignore */
        }
      }
    }
    this.emit()
  }

  private emit(): void {
    const list = this.list()
    for (const l of this.listeners) {
      try {
        l(list)
      } catch {
        /* ignore */
      }
    }
  }
}

function shortAddr(a: string): string {
  return a.length >= 10 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a
}

export type { GlobalLiveMedia, LiveSession }
