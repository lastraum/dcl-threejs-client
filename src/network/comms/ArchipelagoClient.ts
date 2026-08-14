import { Authenticator } from '@dcl/crypto'
import type { AuthIdentity } from '@dcl/crypto/dist/types'
import {
  ChallengeRequestMessage,
  ClientPacket,
  Heartbeat,
  ServerPacket,
  SignedChallengeMessage
} from '@dcl/protocol/out-ts/decentraland/kernel/comms/v3/archipelago.gen'
import { Position } from '@dcl/protocol/out-ts/decentraland/common/vectors.gen'
import { clientDebugLog } from '../../client/debug/ClientDebugLog'

export type IslandChangedEvent = {
  islandId: string
  connStr: string
}

/** Archipelago WS control plane — Bevy `ArchipelagoPlugin`. */
export class ArchipelagoClient {
  private socket: WebSocket | null = null
  private identity: AuthIdentity | null = null
  private address: string | null = null
  private pendingPosition: Position | null = null
  /** Last known position — keep-alive heartbeats so island assignment is not one-shot. */
  private lastPosition: Position | null = null
  private onIslandChanged: ((event: IslandChangedEvent) => void) | null = null
  private retries = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private wsUrl = ''
  private welcomed = false
  private islandId: string | null = null
  /** Ignore onclose from a socket we replaced or closed on purpose. */
  private closeGeneration = 0

  setIslandHandler(handler: ((event: IslandChangedEvent) => void) | null): void {
    this.onIslandChanged = handler
  }

  isConnected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN
  }

  isConnecting(): boolean {
    return this.socket?.readyState === WebSocket.CONNECTING
  }

  isWelcomed(): boolean {
    return this.welcomed && this.isConnected()
  }

  getIslandId(): string | null {
    return this.islandId
  }

  describe(): string {
    const ws =
      this.socket?.readyState === WebSocket.OPEN
        ? 'open'
        : this.socket?.readyState === WebSocket.CONNECTING
          ? 'connecting'
          : 'closed'
    return `ws=${ws} welcomed=${this.welcomed} island=${this.islandId ?? 'none'} url=${this.wsUrl.slice(0, 48) || '-'}`
  }

  connect(wsTarget: string, address: string, identity: AuthIdentity): void {
    let url = wsTarget.trim()
    if (url.startsWith('archipelago:')) url = url.slice('archipelago:'.length)
    if (!url.startsWith('ws://') && !url.startsWith('wss://')) {
      url = `wss://${url.replace(/^\/+/, '')}`
    }
    while (url.startsWith('archipelago:')) url = url.slice('archipelago:'.length)
    this.identity = identity
    this.address = address.toLowerCase()
    // Same control plane already up or handshaking — do not close it (onclose would
    // reconnect forever: welcome resets retries, then connect() kills the live socket).
    if (
      this.wsUrl === url &&
      (this.isConnected() || this.isConnecting()) &&
      this.socket
    ) {
      return
    }
    this.disconnect({ keepIdentity: true })
    this.retries = 0
    this.welcomed = false
    this.islandId = null
    this.wsUrl = url

    clientDebugLog.log('network', `Archipelago connecting · ${url}`, {
      level: 'info',
      throttleMs: 5000,
      throttleKey: 'archipelago-connecting'
    })
    this.openSocket(url)
  }

  /**
   * @param x,y,z — **DCL genesis meters** (+X east, +Y up, +Z north).
   * Callers pass `sceneLocalToGenesis(player.getPosition())` — getPosition is already
   * DCL scene-local via threeToDclVec. Do **not** flip Z here (that mirrored us to the
   * opposite side of the map → empty island, remotes=0, Explorer never co-clustered).
   */
  queuePosition(x: number, y: number, z: number): void {
    const pos: Position = { x, y, z }
    this.pendingPosition = pos
    this.lastPosition = pos
    this.flushHeartbeat()
  }

  /**
   * Keep Social Service friend/community ONLINE while on landing/shell.
   * Prefer genesis meters for the **current landing parcel** — never leave a stale
   * (0,0,0) seed after the user navigates to another parcel (wrong island + chat).
   *
   * @param genesis — DCL genesis meters. When provided, always updates (overwrites 0,0,0).
   *                  When omitted and no position yet, falls back to (0,0,0) friends-only seed.
   */
  ensurePresenceSeed(genesis?: { x: number; y: number; z: number }): void {
    if (genesis) {
      this.queuePosition(genesis.x, genesis.y, genesis.z)
    } else if (!this.lastPosition) {
      this.queuePosition(0, 0, 0)
    }
    if (this.welcomed && this.isConnected()) {
      this.startHeartbeatLoop()
    }
  }

  disconnect(opts?: { keepIdentity?: boolean }): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.stopHeartbeatLoop()
    this.closeGeneration++
    const socket = this.socket
    this.socket = null
    if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
      socket.close()
    }
    this.pendingPosition = null
    if (!opts?.keepIdentity) {
      this.lastPosition = null
      this.identity = null
      this.address = null
      this.wsUrl = ''
    }
    this.welcomed = false
    this.islandId = null
  }

  private openSocket(url: string): void {
    const generation = this.closeGeneration
    const socket = new WebSocket(url, ['archipelago'])
    this.socket = socket
    socket.binaryType = 'arraybuffer'

    socket.onopen = () => {
      if (this.socket !== socket || generation !== this.closeGeneration) return
      clientDebugLog.log('network', 'Archipelago WS open · sending challenge', {
        level: 'success',
        throttleMs: 5000,
        throttleKey: 'archipelago-ws-open'
      })
      this.sendClientPacket({
        message: {
          $case: 'challengeRequest',
          challengeRequest: ChallengeRequestMessage.create({ address: this.address ?? '' })
        }
      })
    }

    socket.onmessage = (ev) => {
      void this.handleMessage(ev.data)
    }

    socket.onerror = () => {
      clientDebugLog.log('network', 'Archipelago WS error', {
        level: 'warn',
        throttleMs: 5000,
        throttleKey: 'archipelago-ws-error'
      })
      clientDebugLog.log('network', 'Archipelago WS error', { level: 'error', alsoConsole: true })
    }

    socket.onclose = () => {
      if (this.socket !== socket || generation !== this.closeGeneration) return
      clientDebugLog.log('network', `Archipelago WS closed · retries=${this.retries}`, {
        level: 'warn',
        throttleMs: 8000,
        throttleKey: 'archipelago-ws-closed'
      })
      this.socket = null
      this.welcomed = false
      this.stopHeartbeatLoop()
      if (this.retries < 5 && this.wsUrl && this.identity && this.address) {
        this.retries++
        const delay = 1500 * this.retries
        this.reconnectTimer = setTimeout(() => {
          if (generation !== this.closeGeneration) return
          this.openSocket(this.wsUrl)
        }, delay)
      }
    }
  }

  private startHeartbeatLoop(): void {
    this.stopHeartbeatLoop()
    // Island assignment + keep-alive — one seed during load is not enough if the first
    // heartbeat is lost before welcome or assignment.
    this.heartbeatTimer = setInterval(() => {
      if (!this.isConnected() || !this.welcomed) return
      if (this.lastPosition) {
        this.pendingPosition = { ...this.lastPosition }
        this.flushHeartbeat()
      }
    }, 2000)
  }

  private stopHeartbeatLoop(): void {
    if (this.heartbeatTimer != null) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
  }

  private sendClientPacket(packet: ClientPacket): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return
    this.socket.send(ClientPacket.encode(packet).finish())
  }

  private flushHeartbeat(): void {
    if (!this.pendingPosition || !this.isConnected()) return
    this.sendClientPacket({
      message: {
        $case: 'heartbeat',
        heartbeat: Heartbeat.create({ position: this.pendingPosition })
      }
    })
    this.pendingPosition = null
  }

  private async handleMessage(data: ArrayBuffer | Blob): Promise<void> {
    if (!this.identity) return
    const buffer =
      data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(await data.arrayBuffer())
    const packet = ServerPacket.decode(buffer)
    const message = packet.message
    if (!message) return

    switch (message.$case) {
      case 'challengeResponse': {
        const challenge = message.challengeResponse.challengeToSign
        if (!challenge.startsWith('dcl-')) {
          clientDebugLog.log('network', 'Archipelago invalid challenge', { level: 'error' })
          this.disconnect()
          return
        }
        const authChain = Authenticator.signPayload(this.identity, challenge)
        this.sendClientPacket({
          message: {
            $case: 'signedChallenge',
            signedChallenge: SignedChallengeMessage.create({
              authChainJson: JSON.stringify(authChain)
            })
          }
        })
        break
      }
      case 'welcome':
        this.welcomed = true
        this.retries = 0
        clientDebugLog.log('network', `Archipelago welcome · peer=${message.welcome.peerId}`, {
          level: 'success'
        })
        // Prefer last known position if pending was cleared.
        if (!this.pendingPosition && this.lastPosition) {
          this.pendingPosition = { ...this.lastPosition }
        }
        // Social Service friend/community ONLINE comes from archipelago stats + NATS
        // peer.*.heartbeat — without a position we never enter the online set and
        // Explorer greys us out in community chat. Seed genesis origin for presence
        // until real player/spawn heartbeats replace it.
        if (!this.pendingPosition && !this.lastPosition) {
          const presenceSeed: Position = { x: 0, y: 0, z: 0 }
          this.pendingPosition = presenceSeed
          this.lastPosition = presenceSeed
        }
        this.flushHeartbeat()
        this.startHeartbeatLoop()
        break
      case 'islandChanged': {
        const change = message.islandChanged
        this.islandId = change.islandId
        clientDebugLog.log(
          'network',
          `Archipelago island → ${change.islandId} · conn=${change.connStr.slice(0, 48)}…`,
          { level: 'success' }
        )
        this.onIslandChanged?.({
          islandId: change.islandId,
          connStr: change.connStr
        })
        break
      }
      default:
        break
    }
  }
}
