import { Authenticator } from '@dcl/crypto'
import type { AuthIdentity } from '@dcl/crypto/dist/types'
import { WsPacket } from '@dcl/protocol/out-js/decentraland/kernel/comms/rfc5/ws_comms.gen'

export type Rfc5PeerHandlers = {
  onWelcome?: (alias: number, peers: Map<number, string>) => void
  onPeerJoin?: (alias: number, address: string) => void
  onPeerLeave?: (alias: number) => void
  onPeerUpdate?: (fromAlias: number, body: Uint8Array) => void
  onDisconnect?: () => void
  onError?: (err: Error) => void
}

/** Browser RFC5 room client — auth challenge + protobuf packets. */
export class Rfc5RoomClient {
  private socket: WebSocket | null = null
  private aliasByAddress = new Map<string, number>()
  private addressByAlias = new Map<number, string>()
  private myAlias: number | null = null

  connect(wsUrl: string, address: string, identity: AuthIdentity, handlers: Rfc5PeerHandlers): void {
    this.disconnect()
    const socket = new WebSocket(wsUrl, ['rfc5'])
    this.socket = socket

    socket.binaryType = 'arraybuffer'
    socket.onopen = () => {
      this.sendPacket({
        message: {
          $case: 'peerIdentification',
          peerIdentification: { address }
        }
      })
    }

    socket.onmessage = (ev) => {
      void this.handleMessage(ev.data, identity, handlers)
    }

    socket.onerror = () => handlers.onError?.(new Error('Comms socket error'))
    socket.onclose = () => handlers.onDisconnect?.()
  }

  disconnect(): void {
    this.socket?.close()
    this.socket = null
    this.aliasByAddress.clear()
    this.addressByAlias.clear()
    this.myAlias = null
  }

  getAddressForAlias(alias: number): string | undefined {
    return this.addressByAlias.get(alias)
  }

  send(body: Uint8Array, unreliable = true): void {
    if (this.myAlias === null) return
    this.sendPacket({
      message: {
        $case: 'peerUpdateMessage',
        peerUpdateMessage: {
          fromAlias: this.myAlias,
          body,
          unreliable
        }
      }
    })
  }

  isConnected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN && this.myAlias !== null
  }

  private sendPacket(packet: WsPacket): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return
    const bytes = WsPacket.encode(packet).finish()
    this.socket.send(bytes)
  }

  private trackPeer(alias: number, address: string): void {
    const normalized = address.toLowerCase()
    this.aliasByAddress.set(normalized, alias)
    this.addressByAlias.set(alias, normalized)
  }

  private async handleMessage(
    data: ArrayBuffer | Blob,
    identity: AuthIdentity,
    handlers: Rfc5PeerHandlers
  ): Promise<void> {
    const buffer =
      data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(await data.arrayBuffer())
    const packet = WsPacket.decode(buffer)
    const message = packet.message
    if (!message) return

    switch (message.$case) {
      case 'challengeMessage': {
        const authChain = Authenticator.signPayload(identity, message.challengeMessage.challengeToSign)
        this.sendPacket({
          message: {
            $case: 'signedChallengeForServer',
            signedChallengeForServer: { authChainJson: JSON.stringify(authChain) }
          }
        })
        break
      }
      case 'welcomeMessage': {
        this.myAlias = message.welcomeMessage.alias
        const peers = new Map<number, string>()
        for (const [aliasKey, addr] of Object.entries(message.welcomeMessage.peerIdentities)) {
          const alias = Number(aliasKey)
          this.trackPeer(alias, addr)
          peers.set(alias, addr.toLowerCase())
        }
        handlers.onWelcome?.(message.welcomeMessage.alias, peers)
        break
      }
      case 'peerJoinMessage': {
        this.trackPeer(message.peerJoinMessage.alias, message.peerJoinMessage.address)
        handlers.onPeerJoin?.(
          message.peerJoinMessage.alias,
          message.peerJoinMessage.address.toLowerCase()
        )
        break
      }
      case 'peerLeaveMessage': {
        const address = this.addressByAlias.get(message.peerLeaveMessage.alias)
        if (address) this.aliasByAddress.delete(address)
        this.addressByAlias.delete(message.peerLeaveMessage.alias)
        handlers.onPeerLeave?.(message.peerLeaveMessage.alias)
        break
      }
      case 'peerUpdateMessage': {
        handlers.onPeerUpdate?.(message.peerUpdateMessage.fromAlias, message.peerUpdateMessage.body)
        break
      }
      case 'peerKicked': {
        handlers.onError?.(new Error(message.peerKicked.reason || 'Kicked from comms room'))
        this.disconnect()
        break
      }
      default:
        break
    }
  }
}
