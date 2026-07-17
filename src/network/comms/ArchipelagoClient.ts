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
  private lastPosLogAt = 0
  private onIslandChanged: ((event: IslandChangedEvent) => void) | null = null
  private retries = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private wsUrl = ''
  private welcomed = false
  private islandId: string | null = null

  setIslandHandler(handler: ((event: IslandChangedEvent) => void) | null): void {
    this.onIslandChanged = handler
  }

  isConnected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN
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
    this.disconnect()
    this.identity = identity
    this.address = address.toLowerCase()
    this.retries = 0
    this.welcomed = false
    this.islandId = null

    let url = wsTarget.trim()
    if (url.startsWith('archipelago:')) url = url.slice('archipelago:'.length)
    if (!url.startsWith('ws://') && !url.startsWith('wss://')) {
      url = `wss://${url.replace(/^\/+/, '')}`
    }
    this.wsUrl = url

    // Always console — ClientDebugLog silences category `comms`.
    console.log('[archipelago] connecting', url)
    clientDebugLog.log('network', `Archipelago connecting · ${url}`, {
      level: 'info',
      alsoConsole: true
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
    // Log occasionally so island co-location is debuggable.
    if (!this.lastPosLogAt || performance.now() - this.lastPosLogAt > 5000) {
      this.lastPosLogAt = performance.now()
      console.log(
        '[archipelago] heartbeat genesis',
        `x=${x.toFixed(1)} y=${y.toFixed(1)} z=${z.toFixed(1)}`,
        `island=${this.islandId ?? 'none'}`
      )
    }
    this.flushHeartbeat()
  }

  /**
   * Keep Social Service friend/community ONLINE while on landing/shell.
   * Explorer greys community avatars when we're missing from archipelago stats.
   * No-op once a real position has been queued (spawn / walk).
   */
  ensurePresenceSeed(): void {
    if (this.lastPosition) return
    this.queuePosition(0, 0, 0)
    if (this.welcomed && this.isConnected()) {
      this.startHeartbeatLoop()
    }
  }

  disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.stopHeartbeatLoop()
    this.socket?.close()
    this.socket = null
    this.pendingPosition = null
    this.welcomed = false
    this.islandId = null
  }

  private openSocket(url: string): void {
    const socket = new WebSocket(url, ['archipelago'])
    this.socket = socket
    socket.binaryType = 'arraybuffer'

    socket.onopen = () => {
      console.log('[archipelago] WS open · challenge')
      clientDebugLog.log('network', 'Archipelago WS open · sending challenge', {
        level: 'success',
        alsoConsole: true
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
      console.warn('[archipelago] WS error')
      clientDebugLog.log('network', 'Archipelago WS error', { level: 'error', alsoConsole: true })
    }

    socket.onclose = () => {
      console.warn('[archipelago] WS closed · retries=', this.retries)
      clientDebugLog.log('network', 'Archipelago WS closed', { level: 'warn', alsoConsole: true })
      this.socket = null
      this.welcomed = false
      this.stopHeartbeatLoop()
      if (this.retries < 5 && this.wsUrl && this.identity && this.address) {
        this.retries++
        this.reconnectTimer = setTimeout(() => this.openSocket(this.wsUrl), 1500 * this.retries)
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
          console.error('[archipelago] invalid challenge')
          clientDebugLog.log('network', 'Archipelago invalid challenge', {
            level: 'error',
            alsoConsole: true
          })
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
        console.log('[archipelago] welcome peer=', message.welcome.peerId)
        clientDebugLog.log('network', `Archipelago welcome · peer=${message.welcome.peerId}`, {
          level: 'success',
          alsoConsole: true
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
          console.log('[archipelago] presence seed genesis (0,0,0) — friend/community online status')
        }
        this.flushHeartbeat()
        this.startHeartbeatLoop()
        break
      case 'islandChanged': {
        const change = message.islandChanged
        this.islandId = change.islandId
        console.log('[archipelago] island →', change.islandId, change.connStr.slice(0, 56))
        clientDebugLog.log(
          'network',
          `Archipelago island → ${change.islandId} · conn=${change.connStr.slice(0, 48)}…`,
          { level: 'success', alsoConsole: true }
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
