import {
  Movement,
  Packet,
  type AnnounceProfileVersion,
  type PlayerEmote,
  type ProfileRequest,
  type ProfileResponse,
  type MovementCompressed as Rfc4MovementCompressed
} from '@dcl/protocol/out-ts/decentraland/kernel/comms/rfc4/comms.gen'
import {
  decodeMovementCompressedTransform,
  decodeMovementWireToScene,
  encodeMovementCompressed,
  encodeSceneToMovementWire,
  expandRealmBounds,
  extractMovementCompressedFromRfc4Packet,
  genesisToSceneLocal,
  movementCompressedToSceneLocal,
  playerYawToTemporalRotationRad,
  sceneLocalToGenesis,
  sceneLocalToMovementCompressed,
  temporalRotationRadToPlayerYaw,
  type CommsSceneOrigin,
  type RealmBounds
} from './movementCompressed'

/** DCL RFC4 default protocol version (Bevy `crates/comms`). */
export const RFC4_PROTOCOL_VERSION = 100

export type Rfc4Transform = {
  x: number
  y: number
  z: number
  yaw: number
  moving: boolean
}

/** RFC4 Movement — Unity Foundation Client / Bevy global_crdt scene + world LiveKit rooms. */
export function encodeRfc4MovementPacket(
  world: Rfc4Transform,
  sessionElapsedSec: number,
  velocity: { x: number; y: number; z: number } = { x: 0, y: 0, z: 0 },
  bounds?: RealmBounds | null,
  preferCompressed = false,
  sceneOrigin?: CommsSceneOrigin | null,
  isEmoting = false,
  locomotion?: {
    isGrounded?: boolean
    isJumping?: boolean
    jumpCount?: number
    isFalling?: boolean
  }
): Uint8Array {
  const codecBounds = expandRealmBounds(bounds ?? null)
  const genesis = sceneOrigin
    ? sceneLocalToGenesis(world.x, world.y, world.z, sceneOrigin)
    : { x: world.x, y: world.y, z: world.z }

  if (preferCompressed && codecBounds && sceneOrigin) {
    const bevy = sceneLocalToMovementCompressed(genesis.x, genesis.y, genesis.z, velocity)
    const compressed = encodeMovementCompressed(
      bevy.x,
      bevy.y,
      bevy.z,
      playerYawToTemporalRotationRad(world.yaw),
      codecBounds,
      sessionElapsedSec,
      bevy.velocity
    )
    return Packet.encode({
      protocolVersion: RFC4_PROTOCOL_VERSION,
      message: {
        $case: 'movementCompressed',
        movementCompressed: compressed as unknown as Rfc4MovementCompressed
      }
    }).finish()
  }

  const wire = encodeSceneToMovementWire(genesis.x, genesis.y, genesis.z, world.yaw, velocity)
  const horizontalSpeed = Math.hypot(velocity.x, velocity.z)
  const movementBlendValue = movementBlendTier(horizontalSpeed, world.moving)
  const isGrounded = locomotion?.isGrounded ?? true
  const isJumping = locomotion?.isJumping ?? false
  const jumpCount = locomotion?.jumpCount ?? 0
  const isFalling = locomotion?.isFalling ?? false

  return Packet.encode({
    protocolVersion: RFC4_PROTOCOL_VERSION,
    message: {
      $case: 'movement',
      movement: {
        timestamp: sessionElapsedSec,
        positionX: wire.positionX,
        positionY: wire.positionY,
        positionZ: wire.positionZ,
        velocityX: wire.velocityX,
        velocityY: wire.velocityY,
        velocityZ: wire.velocityZ,
        movementBlendValue,
        slideBlendValue: 0,
        isGrounded,
        isJumping,
        jumpCount,
        isLongJump: false,
        isLongFall: false,
        isFalling,
        isStunned: false,
        glideState: 0,
        rotationY: wire.rotationYDeg,
        isInstant: false,
        isEmoting,
        headIkYawEnabled: false,
        headIkPitchEnabled: false,
        headYaw: 0,
        headPitch: 0,
        pointAtX: 0,
        pointAtY: 0,
        pointAtZ: 0,
        isPointingAt: false
      } satisfies Movement
    }
  }).finish()
}

export function encodeRfc4ProfileRequestPacket(address: string, profileVersion = 0): Uint8Array {
  return Packet.encode({
    protocolVersion: RFC4_PROTOCOL_VERSION,
    message: {
      $case: 'profileRequest',
      profileRequest: {
        address: address.toLowerCase(),
        profileVersion
      } satisfies ProfileRequest
    }
  }).finish()
}

export function encodeRfc4ProfileVersionPacket(profileVersion = 0): Uint8Array {
  return Packet.encode({
    protocolVersion: RFC4_PROTOCOL_VERSION,
    message: {
      $case: 'profileVersion',
      profileVersion: {
        profileVersion
      } satisfies AnnounceProfileVersion
    }
  }).finish()
}

export function encodeRfc4ProfileResponsePacket(
  serializedProfile: string,
  baseUrl: string
): Uint8Array {
  return Packet.encode({
    protocolVersion: RFC4_PROTOCOL_VERSION,
    message: {
      $case: 'profileResponse',
      profileResponse: {
        serializedProfile,
        baseUrl
      } satisfies ProfileResponse
    }
  }).finish()
}

/** RFC4 PlayerEmote — Unity Explorer broadcasts equipped emote URN to peers. */
export function encodeRfc4PlayerEmotePacket(
  urn: string,
  incrementalId: number,
  sessionElapsedSec: number
): Uint8Array {
  return Packet.encode({
    protocolVersion: RFC4_PROTOCOL_VERSION,
    message: {
      $case: 'playerEmote',
      playerEmote: {
        incrementalId,
        urn,
        timestamp: sessionElapsedSec
      } satisfies PlayerEmote
    }
  }).finish()
}

export type DecodedRfc4PlayerEmote = {
  urn: string
  incrementalId: number
  timestamp: number
}

export function tryDecodeRfc4PlayerEmote(buf: Uint8Array): DecodedRfc4PlayerEmote | null {
  try {
    const packet = Packet.decode(buf)
    if (packet.message?.$case !== 'playerEmote') return null
    const emote = packet.message.playerEmote
    const urn = emote.urn?.trim()
    if (!urn) return null
    return {
      urn,
      incrementalId: emote.incrementalId ?? 0,
      timestamp: emote.timestamp ?? 0
    }
  } catch {
    return null
  }
}

export type DecodedRfc4ProfileResponse = {
  serializedProfile: string
  baseUrl: string
}

export function tryDecodeRfc4ProfileResponse(buf: Uint8Array): DecodedRfc4ProfileResponse | null {
  try {
    const packet = Packet.decode(buf)
    if (packet.message?.$case !== 'profileResponse') return null
    const response = packet.message.profileResponse
    const serializedProfile = response.serializedProfile?.trim()
    if (!serializedProfile) return null
    return {
      serializedProfile,
      baseUrl: response.baseUrl?.trim() ?? ''
    }
  } catch {
    return null
  }
}

export type DecodedRfc4ProfileVersion = {
  profileVersion: number
}

export function tryDecodeRfc4ProfileVersion(buf: Uint8Array): DecodedRfc4ProfileVersion | null {
  try {
    const packet = Packet.decode(buf)
    if (packet.message?.$case !== 'profileVersion') return null
    return { profileVersion: packet.message.profileVersion.profileVersion ?? 0 }
  } catch {
    return null
  }
}

export type DecodedRfc4ProfileRequest = {
  address: string
  profileVersion: number
}

export function tryDecodeRfc4ProfileRequest(buf: Uint8Array): DecodedRfc4ProfileRequest | null {
  try {
    const packet = Packet.decode(buf)
    const message = packet.message
    if (message?.$case !== 'profileRequest') return null
    const req = message.profileRequest
    const address = req.address?.trim().toLowerCase()
    if (!address) return null
    return { address, profileVersion: req.profileVersion ?? 0 }
  } catch {
    return null
  }
}

export type DecodedRfc4Transform =
  | {
      kind: 'transform'
      source: 'compressed' | 'movement' | 'position'
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
  | { kind: 'unknown' }

function toSceneTransform(
  decoded: NonNullable<ReturnType<typeof decodeMovementCompressedTransform>>,
  sceneOrigin?: CommsSceneOrigin | null
): DecodedRfc4Transform {
  const scene = movementCompressedToSceneLocal(
    decoded.x,
    decoded.y,
    decoded.z,
    { x: decoded.vx, y: decoded.vy, z: decoded.vz }
  )
  const local = sceneOrigin
    ? genesisToSceneLocal(scene.x, scene.y, scene.z, sceneOrigin)
    : { x: scene.x, y: scene.y, z: scene.z }
  return {
    kind: 'transform',
    source: 'compressed',
    x: local.x,
    y: local.y,
    z: local.z,
    yaw: temporalRotationRadToPlayerYaw(decoded.yaw),
    vx: scene.velocity.x,
    vy: scene.velocity.y,
    vz: scene.velocity.z
  }
}

export function tryDecodeRfc4TransformPacket(
  buf: Uint8Array,
  bounds?: RealmBounds | null,
  sceneOrigin?: CommsSceneOrigin | null
): DecodedRfc4Transform {
  const codecBounds = expandRealmBounds(bounds ?? null)
  const compressed = extractMovementCompressedFromRfc4Packet(buf)
  if (compressed) {
    const decoded = decodeMovementCompressedTransform(compressed, codecBounds)
    if (decoded) return toSceneTransform(decoded, sceneOrigin)
    return { kind: 'unknown' }
  }

  try {
    const packet = Packet.decode(buf)
    const message = packet.message
    if (!message) return { kind: 'unknown' }

    if (message.$case === 'movementCompressed') {
      const decoded = decodeMovementCompressedTransform(message.movementCompressed, codecBounds)
      if (!decoded) return { kind: 'unknown' }
      return toSceneTransform(decoded, sceneOrigin)
    }

    if (message.$case === 'position') {
      const p = message.position
      return {
        kind: 'transform',
        source: 'position',
        x: p.positionX,
        y: p.positionY,
        z: p.positionZ,
        yaw: yawFromQuaternion(p.rotationX, p.rotationY, -p.rotationZ, -p.rotationW)
      }
    }

    if (message.$case === 'movement') {
      const m = message.movement
      const genesis = decodeMovementWireToScene(m.positionX, m.positionY, m.positionZ, m.rotationY, {
        x: m.velocityX,
        y: m.velocityY,
        z: m.velocityZ
      })
      const local = sceneOrigin
        ? genesisToSceneLocal(genesis.x, genesis.y, genesis.z, sceneOrigin)
        : { x: genesis.x, y: genesis.y, z: genesis.z }
      return {
        kind: 'transform',
        source: 'movement',
        x: local.x,
        y: local.y,
        z: local.z,
        yaw: genesis.yaw,
        vx: genesis.velocity?.x,
        vy: genesis.velocity?.y,
        vz: genesis.velocity?.z,
        isGrounded: m.isGrounded,
        isJumping: m.isJumping,
        jumpCount: m.jumpCount
      }
    }
  } catch {
    /* not RFC4 */
  }
  return { kind: 'unknown' }
}

export function describeRfc4Packet(buf: Uint8Array): string {
  try {
    const packet = Packet.decode(buf)
    return packet.message?.$case ?? 'empty'
  } catch {
    return 'unknown'
  }
}

function yawFromQuaternion(rx: number, ry: number, rz: number, rw: number): number {
  const sinyCosp = 2 * (rw * ry + rx * rz)
  const cosyCosp = 1 - 2 * (ry * ry + rz * rz)
  return Math.atan2(sinyCosp, cosyCosp)
}

/** Unity Foundation Client — 0 idle, 1 walk, 2 jog, 3 run. */
export function movementBlendTier(horizontalSpeed: number, moving: boolean): number {
  if (!moving || horizontalSpeed < 0.12) return 0
  if (horizontalSpeed < 4) return 1
  if (horizontalSpeed < 9) return 2
  return 3
}
