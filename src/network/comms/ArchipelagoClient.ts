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
  private onIslandChanged: ((event: IslandChangedEvent) => void) | null = null
  private retries = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private wsUrl = ''

  setIslandHandler(handler: ((event: IslandChangedEvent) => void) | null): void {
    this.onIslandChanged = handler
  }

  isConnected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN
  }

  connect(wsTarget: string, address: string, identity: AuthIdentity): void {
    this.disconnect()
    this.identity = identity
    this.address = address.toLowerCase()
    this.retries = 0

    let url = wsTarget.trim()
    if (url.startsWith('archipelago:')) url = url.slice('archipelago:'.length)
    if (!url.startsWith('ws://') && !url.startsWith('wss://')) {
      url = `wss://${url.replace(/^\/+/, '')}`
    }
    this.wsUrl = url

    clientDebugLog.log('comms', `Archipelago connecting · ${url}`, { level: 'info' })
    this.openSocket(url)
  }

  queuePosition(x: number, y: number, z: number): void {
    this.pendingPosition = { x, y, z: -z }
    this.flushHeartbeat()
  }

  disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.socket?.close()
    this.socket = null
    this.pendingPosition = null
  }

  private openSocket(url: string): void {
    const socket = new WebSocket(url, ['archipelago'])
    this.socket = socket
    socket.binaryType = 'arraybuffer'

    socket.onopen = () => {
      clientDebugLog.log('comms', 'Archipelago WS open · sending challenge', { level: 'success' })
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
      clientDebugLog.log('comms', 'Archipelago WS error', { level: 'error' })
    }

    socket.onclose = () => {
      clientDebugLog.log('comms', 'Archipelago WS closed', { level: 'warn' })
      this.socket = null
      if (this.retries < 3 && this.wsUrl && this.identity && this.address) {
        this.retries++
        this.reconnectTimer = setTimeout(() => this.openSocket(this.wsUrl), 1500 * this.retries)
      }
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
          clientDebugLog.log('comms', 'Archipelago invalid challenge', { level: 'error' })
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
        clientDebugLog.log('comms', `Archipelago welcome · peer=${message.welcome.peerId}`, {
          level: 'success'
        })
        this.flushHeartbeat()
        break
      case 'islandChanged': {
        const change = message.islandChanged
        clientDebugLog.log(
          'comms',
          `Archipelago island → ${change.islandId} · conn=${change.connStr.slice(0, 32)}…`,
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
