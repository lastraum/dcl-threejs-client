/** Bevy `TransportType` — one ECS transport entity per connection. */
export enum TransportType {
  Archipelago = 'archipelago',
  Island = 'island',
  SceneRoom = 'scene',
  World = 'world',
  WebsocketRoom = 'rfc5'
}

export type OutboundPacket = {
  data: Uint8Array
  unreliable: boolean
}

export type InboundPacket = {
  transport: TransportType
  address: string
  data: Uint8Array
}

export type PeerLifecycleHandlers = {
  onPeerJoin: (address: string, transport: TransportType) => void
  onPeerLeave: (address: string, transport: TransportType) => void
}
