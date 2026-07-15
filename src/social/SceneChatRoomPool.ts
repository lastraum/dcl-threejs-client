/**
 * Multi-room LiveKit chat pool (dcl-companion style).
 * One tab can stay joined to many scene/world chat rooms; UI tab switches never drop sockets.
 */
import type { AuthIdentity } from '@dcl/crypto/dist/types'
import { clientDebugLog } from '../client/debug/ClientDebugLog'
import { LiveKitCommsSession } from '../network/comms/LiveKitCommsSession'
import { TransportType } from '../network/comms/Transport'
import { isLiveKitAdapter } from '../network/comms/livekitAdapter'
import { tryDecodeRfc4ChatPacket } from './dclRfc4Chat'

export type SceneChatInbound = {
  sceneKey: string
  senderAddress: string
  text: string
  time: number
}

export type SceneChatRoomPoolOptions = {
  onChat: (msg: SceneChatInbound) => void
}

type RoomEntry = {
  sceneKey: string
  label: string
  session: LiveKitCommsSession
  adapter: string
}

function normalizeKey(pointer: string): string {
  return pointer.trim().toLowerCase()
}

export class SceneChatRoomPool {
  private readonly rooms = new Map<string, RoomEntry>()
  private readonly onChat: SceneChatRoomPoolOptions['onChat']
  private localAddress: string | null = null
  private lambdasUrl = ''
  private joinChain: Promise<unknown> = Promise.resolve()

  constructor(opts: SceneChatRoomPoolOptions) {
    this.onChat = opts.onChat
  }

  setIdentity(address: string | undefined, _identity: AuthIdentity | null): void {
    this.localAddress = address?.toLowerCase() ?? null
    for (const entry of this.rooms.values()) {
      entry.session.setLocalAddress(this.localAddress ?? undefined)
    }
  }

  setLambdasUrl(url: string): void {
    this.lambdasUrl = url.replace(/\/$/, '')
    for (const entry of this.rooms.values()) {
      entry.session.setLambdasUrl(this.lambdasUrl)
    }
  }

  isJoined(sceneKey: string): boolean {
    const entry = this.rooms.get(normalizeKey(sceneKey))
    return Boolean(entry?.session.isConnected())
  }

  getJoinedKeys(): string[] {
    return [...this.rooms.entries()]
      .filter(([, e]) => e.session.isConnected())
      .map(([k]) => k)
  }

  /** Join (or keep) a chat room. Does **not** leave other rooms. */
  async join(opts: {
    sceneKey: string
    label: string
    adapter: string
    isWorldChat: boolean
  }): Promise<boolean> {
    const run = this.joinChain.then(() => this.joinExclusive(opts))
    this.joinChain = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }

  private async joinExclusive(opts: {
    sceneKey: string
    label: string
    adapter: string
    isWorldChat: boolean
  }): Promise<boolean> {
    const key = normalizeKey(opts.sceneKey)
    const existing = this.rooms.get(key)
    if (existing?.session.isConnected()) {
      existing.label = opts.label
      return true
    }

    if (!isLiveKitAdapter(opts.adapter)) {
      clientDebugLog.log('social', `Chat room join skipped — not LiveKit adapter for ${key}`, {
        level: 'warn'
      })
      return false
    }

    if (existing) {
      existing.session.disconnect()
      this.rooms.delete(key)
    }

    const transport = opts.isWorldChat ? TransportType.World : TransportType.SceneRoom
    const session = new LiveKitCommsSession(transport, false)
    session.setLocalAddress(this.localAddress ?? undefined)
    if (this.lambdasUrl) session.setLambdasUrl(this.lambdasUrl)

    session.setPacketHandler((_transport, address, data) => {
      if (this.localAddress && address === this.localAddress) return
      const decoded = tryDecodeRfc4ChatPacket(data)
      if (decoded.kind !== 'chat') return
      this.onChat({
        sceneKey: key,
        senderAddress: address,
        text: decoded.text,
        time: decoded.time
      })
    })

    const ok = await session.connect(opts.adapter)
    if (!ok || !session.isConnected()) {
      session.disconnect()
      clientDebugLog.log('social', `Chat room join failed · ${key}`, {
        level: 'error',
        alsoConsole: true
      })
      return false
    }

    this.rooms.set(key, {
      sceneKey: key,
      label: opts.label,
      session,
      adapter: opts.adapter
    })
    clientDebugLog.log(
      'social',
      `Chat room joined · ${opts.label} (${key}) · rooms=${this.rooms.size}`,
      { level: 'success', alsoConsole: true }
    )
    return true
  }

  async sendChat(sceneKey: string, text: string): Promise<boolean> {
    const entry = this.rooms.get(normalizeKey(sceneKey))
    if (!entry?.session.isConnected()) {
      console.warn(`[chat] multi-room send skip — not joined ${sceneKey}`)
      return false
    }
    return entry.session.publishChat(text)
  }

  async sendChatMedia(sceneKey: string, envelopes: Uint8Array[]): Promise<boolean> {
    const entry = this.rooms.get(normalizeKey(sceneKey))
    if (!entry?.session.isConnected() || !envelopes.length) return false
    return entry.session.publishChatMedia(envelopes)
  }

  leave(sceneKey: string): void {
    const key = normalizeKey(sceneKey)
    const entry = this.rooms.get(key)
    if (!entry) return
    entry.session.disconnect()
    this.rooms.delete(key)
    clientDebugLog.log('social', `Chat room left · ${key} · rooms=${this.rooms.size}`, {
      level: 'info',
      alsoConsole: true
    })
  }

  leaveAll(): void {
    for (const key of [...this.rooms.keys()]) this.leave(key)
  }

  /** Disconnect every pool room except the jump-in target (if joined). */
  leaveExcept(keepSceneKey: string | null | undefined): void {
    const keep = keepSceneKey ? normalizeKey(keepSceneKey) : null
    for (const key of [...this.rooms.keys()]) {
      if (keep && key === keep) continue
      this.leave(key)
    }
  }
}
