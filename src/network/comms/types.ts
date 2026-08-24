import { base64ToBytes, bytesToBase64 } from './commsBinaryWire'

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
  /** RFC4 Movement_GlideState (0 closed … 3 closing). */
  glideState?: number
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

/** One-shot topics (ability VFX, etc.) over RFC-5 mini-comms peer updates. */
export type Rfc5TopicPayload = {
  type: 'topic'
  topic: string
  data: string
}

export function encodeRfc5TopicPayload(topic: string, packet: Uint8Array): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({
      type: 'topic',
      topic: topic.trim(),
      data: bytesToBase64(packet)
    } satisfies Rfc5TopicPayload)
  )
}

export function decodeRfc5TopicPayload(
  body: Uint8Array
): { topic: string; packet: Uint8Array } | null {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(body)) as Partial<Rfc5TopicPayload>
    if (parsed?.type !== 'topic' || typeof parsed.topic !== 'string' || !parsed.topic.trim()) {
      return null
    }
    if (typeof parsed.data !== 'string') return null
    return { topic: parsed.topic.trim(), packet: base64ToBytes(parsed.data) }
  } catch {
    return null
  }
}

/**
 * sdk-commands mini-comms (`ws-room`) carries three peer-update payloads:
 * our JSON avatar transform, our JSON topic envelope, and SDK craftCommsMessage
 * (`[type][payload]`) for CRDT / CUSTOM_EVENT / REQ/RES.
 *
 * Auth-server games (Last Call Dock deck rows, Flagtag, pixelwars) publish the
 * third kind. Dropping it means `room.send` never reaches isRoomReady.
 */
export type Rfc5PeerUpdateKind = 'transform' | 'topic' | 'scene-binary'

export function classifyRfc5PeerUpdateBody(body: Uint8Array): Rfc5PeerUpdateKind {
  if (decodeTransformPayload(body)) return 'transform'
  if (decodeRfc5TopicPayload(body)) return 'topic'
  return 'scene-binary'
}

export function isLocalPreviewComms(adapter: string, realmName: string): boolean {
  const a = adapter.trim()
  const name = realmName.trim()
  return (
    a.startsWith('ws-room:') ||
    a.includes('/mini-comms/') ||
    name === 'LocalPreview'
  )
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
