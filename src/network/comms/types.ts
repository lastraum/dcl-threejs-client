/** JSON payload broadcast for remote avatar transforms. */
export type AvatarTransformPayload = {
  type: 'avatar-transform'
  x: number
  y: number
  z: number
  yaw: number
  vx?: number
  vy?: number
  vz?: number
  isGrounded?: boolean
  isJumping?: boolean
  jumpCount?: number
}

export type CommsRealmInfo = {
  realmName: string
  domain: string
  baseUrl: string
  networkId: number
  commsAdapter: string
  isPreview: boolean
  room?: string
  isConnectedSceneRoom: boolean
}

export function encodeTransformPayload(payload: AvatarTransformPayload): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(payload))
}

export function decodeTransformPayload(body: Uint8Array): AvatarTransformPayload | null {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(body)) as AvatarTransformPayload
    if (parsed?.type !== 'avatar-transform') return null
    return parsed
  } catch {
    return null
  }
}

/** ADR-180 `ws-room:ws://host/path` → browser WebSocket URL. */
export function parseCommsAdapter(connectionString: string): string | null {
  const trimmed = connectionString.trim()
  if (!trimmed) return null
  if (trimmed.startsWith('ws-room:')) return trimmed.slice('ws-room:'.length)
  if (trimmed.startsWith('ws://') || trimmed.startsWith('wss://')) return trimmed
  return null
}

export function defaultRoomId(sceneKey: string): string {
  return sceneKey.replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 64) || 'local-room'
}
