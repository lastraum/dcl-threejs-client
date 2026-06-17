import type { MovementCompressed as Rfc4MovementCompressed } from '@dcl/protocol/out-ts/decentraland/kernel/comms/rfc4/comms.gen'
import _m0 from 'protobufjs/minimal'
import Long from 'long'

export type EncodedMovementCompressed = {
  temporalData: number
  movementData: Long
  headSyncData: number
  pointAtData: number
}

function movementDataToBigint(value: number | Long | undefined): bigint {
  if (value == null) return 0n
  if (Long.isLong(value)) return BigInt(value.toString())
  return BigInt.asIntN(64, BigInt(value))
}

/** Decode MovementCompressed submessage — keeps int64 precision (Packet.decode truncates). */
export function decodeMovementCompressedProto(buf: Uint8Array): {
  temporalData: number
  movementData: bigint
  headSyncData: number
  pointAtData: number
} | null {
  try {
    const reader = _m0.Reader.create(buf)
    const end = reader.len
    let temporalData = 0
    let movementData = 0n
    let headSyncData = 0
    let pointAtData = 0

    while (reader.pos < end) {
      const tag = reader.uint32()
      switch (tag >>> 3) {
        case 1:
          temporalData = reader.int32()
          break
        case 2: {
          const long = reader.int64() as Long
          movementData = BigInt(long.toString())
          break
        }
        case 3:
          headSyncData = reader.int32()
          break
        case 4:
          pointAtData = reader.int32()
          break
        default:
          reader.skipType(tag & 7)
          break
      }
    }

    return { temporalData, movementData, headSyncData, pointAtData }
  } catch {
    return null
  }
}

/** Extract MovementCompressed from an RFC4 Packet without full Packet.decode. */
export function extractMovementCompressedFromRfc4Packet(buf: Uint8Array): ReturnType<
  typeof decodeMovementCompressedProto
> | null {
  try {
    const reader = _m0.Reader.create(buf)
    const end = reader.len
    while (reader.pos < end) {
      const tag = reader.uint32()
      if (tag === 98) {
        return decodeMovementCompressedProto(reader.bytes())
      }
      reader.skipType(tag & 7)
    }
  } catch {
    /* ignore */
  }
  return null
}

type DecodedMovementCompressedProto = NonNullable<ReturnType<typeof decodeMovementCompressedProto>>

function decodeMovementCompressedFields(
  packet:
    | Rfc4MovementCompressed
    | EncodedMovementCompressed
    | DecodedMovementCompressedProto
): {
  temporalData: number
  movementData: bigint
} {
  if ('movementData' in packet && typeof packet.movementData === 'bigint') {
    return { temporalData: packet.temporalData ?? 0, movementData: packet.movementData }
  }
  return {
    temporalData: packet.temporalData ?? 0,
    movementData: movementDataToBigint(packet.movementData as number | Long)
  }
}
const TAU = Math.PI * 2
const TIMESTAMP_BITS = 15
const TIMESTAMP_QUANTUM = 0.02
const TIMESTAMP_MAX = (1 << TIMESTAMP_BITS) * TIMESTAMP_QUANTUM

export type RealmBounds = {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

/** Scene base parcel — MovementCompressed uses absolute genesis coords, not scene-local. */
export type CommsSceneOrigin = {
  baseParcelX: number
  baseParcelY: number
}

export function parseCommsSceneOrigin(baseParcel: string): CommsSceneOrigin | null {
  const [xs, ys] = baseParcel.split(',')
  const baseParcelX = Number.parseInt(xs.trim(), 10)
  const baseParcelY = Number.parseInt(ys.trim(), 10)
  if (!Number.isFinite(baseParcelX) || !Number.isFinite(baseParcelY)) return null
  return { baseParcelX, baseParcelY }
}

/** MovementCompressed wire coords are genesis (world parcel) meters — convert to scene-local DCL. */
export function genesisToSceneLocal(
  x: number,
  y: number,
  z: number,
  origin: CommsSceneOrigin
): { x: number; y: number; z: number } {
  return {
    x: x - origin.baseParcelX * 16,
    y,
    z: z - origin.baseParcelY * 16
  }
}

/** Scene-local DCL → genesis meters for MovementCompressed encode. */
export function sceneLocalToGenesis(
  x: number,
  y: number,
  z: number,
  origin: CommsSceneOrigin
): { x: number; y: number; z: number } {
  return {
    x: x + origin.baseParcelX * 16,
    y,
    z: z + origin.baseParcelY * 16
  }
}

/** Scene-local DCL (+Z north) ↔ scene-local Bevy (+Z backward) for MovementCompressed. */
export function sceneLocalToMovementCompressed(
  x: number,
  y: number,
  z: number,
  velocity: { x: number; y: number; z: number }
): { x: number; y: number; z: number; velocity: { x: number; y: number; z: number } } {
  return {
    x,
    y,
    z: -z,
    velocity: { x: velocity.x, y: velocity.y, z: -velocity.z }
  }
}

/** Scene-local Bevy coords from MovementCompressed decode → scene-local DCL. */
export function movementCompressedToSceneLocal(
  x: number,
  y: number,
  z: number,
  velocity: { x: number; y: number; z: number }
): { x: number; y: number; z: number; velocity: { x: number; y: number; z: number } } {
  return {
    x,
    y,
    z: -z,
    velocity: { x: velocity.x, y: velocity.y, z: -velocity.z }
  }
}

function normalizeDegrees(deg: number): number {
  let d = deg % 360
  if (d <= -180) d += 360
  if (d > 180) d -= 360
  return d
}

/** Wrap radians to (-π, π] — used before RFC4 wire encode. */
export function normalizeAngle(rad: number): number {
  const a = ((rad % TAU) + TAU) % TAU
  return a > Math.PI ? a - TAU : a
}

/** Scene player yaw → RFC4 Movement.rotationY (Bevy `(-rotation_y).to_degrees()`). */
export function playerYawToMovementRotationDeg(yaw: number): number {
  return normalizeDegrees(((normalizeAngle(yaw) - Math.PI) * 180) / Math.PI)
}

/** MovementCompressed temporal rotation → player yaw. */
export function temporalRotationRadToPlayerYaw(rotationRad: number): number {
  return normalizeAngle(Math.PI - normalizeAngle(rotationRad))
}

/** Scene player yaw → MovementCompressed temporal rotation (Bevy MC codec). */
export function playerYawToTemporalRotationRad(yaw: number): number {
  return normalizeAngle(Math.PI - normalizeAngle(yaw))
}

/** Bevy global_crdt: `from_rotation_y(-rotation_y°)` → player/camera yaw. */
export function movementRotationDegToPlayerYaw(rotationYDeg: number): number {
  return normalizeAngle(Math.PI + (normalizeDegrees(rotationYDeg) * Math.PI) / 180)
}

export type MovementWireVelocity = { x: number; y: number; z: number }

/** Bevy global_crdt Movement decode — wire RFC4 genesis DCL → scene-local (+X east, +Z north). */
export function decodeMovementWireToScene(
  positionX: number,
  positionY: number,
  positionZ: number,
  rotationYDeg: number,
  velocity?: MovementWireVelocity
): { x: number; y: number; z: number; yaw: number; velocity?: MovementWireVelocity } {
  // Wire positions are genesis DCL (DclTranslation wire format, +Z north).
  const x = positionX
  const y = positionY
  const z = positionZ
  const yaw = movementRotationDegToPlayerYaw(rotationYDeg)
  if (!velocity) return { x, y, z, yaw }
  return { x, y, z, yaw, velocity: { x: velocity.x, y: velocity.y, z: -velocity.z } }
}

/** Unity/Bevy outbound — genesis DCL → RFC4 Movement wire fields. */
export function encodeSceneToMovementWire(
  x: number,
  y: number,
  z: number,
  yaw: number,
  velocity: MovementWireVelocity = { x: 0, y: 0, z: 0 }
): {
  positionX: number
  positionY: number
  positionZ: number
  rotationYDeg: number
  velocityX: number
  velocityY: number
  velocityZ: number
} {
  return {
    positionX: x,
    positionY: y,
    positionZ: z,
    rotationYDeg: playerYawToMovementRotationDeg(yaw),
    velocityX: velocity.x,
    velocityY: velocity.y,
    velocityZ: -velocity.z
  }
}

enum VelocityTier {
  None = 0,
  Slow = 1,
  Med = 2,
  Fast = 3
}

function readBits(value: bigint, offset: number, bits: number): number {
  const mask = (1n << BigInt(bits)) - 1n
  return Number((value >> BigInt(offset)) & mask)
}

function dequantize(compressed: number, bits: number, min: number, max: number): number {
  const maxStep = (1 << bits) - 1
  const normalized = compressed / maxStep
  return normalized * (max - min) + min
}

function quantize(value: number, bits: number, min: number, max: number): number {
  const maxStep = (1 << bits) - 1
  const normalized = (value - min) / (max - min)
  return Math.round(Math.max(0, Math.min(1, normalized)) * maxStep)
}

function decodeTemporal(temporalData: number): {
  rotationRad: number
  velocityTier: VelocityTier
} {
  const raw = BigInt(temporalData >>> 0)
  const rotationBits = readBits(raw, 24, 6)
  const velocityTier = readBits(raw, 30, 2) as VelocityTier
  const rotationRad = TAU - dequantize(rotationBits, 6, 0, TAU)
  return { rotationRad, velocityTier }
}

function encodeTemporal(rotationRad: number, velocityTier: VelocityTier, elapsedSec: number): number {
  const timestamp = quantize(elapsedSec % TIMESTAMP_MAX, 15, 0, TIMESTAMP_MAX)
  const rotationBits = quantize(((-rotationRad % TAU) + TAU) % TAU, 6, 0, TAU)
  let bits = BigInt(timestamp)
  bits |= BigInt(1) << 19n // grounded
  bits |= BigInt(rotationBits) << 24n
  bits |= BigInt(velocityTier) << 30n
  return Number(bits & 0xffffffffn)
}

function decodeMovementSlow(movementData: bigint): {
  parcelIndex: number
  relative: { x: number; y: number; z: number }
  velocity: { x: number; y: number; z: number }
} {
  const parcelIndex = readBits(movementData, 0, 17)
  const relX = dequantize(readBits(movementData, 17, 10), 10, 0, 16)
  const relZ = dequantize(readBits(movementData, 27, 10), 10, 0, 16)
  const relY = dequantize(readBits(movementData, 37, 13), 13, 0, 200)
  const velXSign = readBits(movementData, 50, 1) === 1
  const velYSign = readBits(movementData, 54, 1) === 1
  const velZSign = readBits(movementData, 58, 1) === 1
  const speed = 4
  const velX = dequantize(readBits(movementData, 51, 3), 3, 0, speed) * (velXSign ? -1 : 1)
  const velY = dequantize(readBits(movementData, 55, 3), 3, 0, speed) * (velYSign ? -1 : 1)
  const velZ = dequantize(readBits(movementData, 59, 3), 3, 0, speed) * (velZSign ? -1 : 1)
  return {
    parcelIndex,
    relative: { x: relX, y: relY, z: relZ },
    velocity: { x: velX, y: velY, z: velZ }
  }
}

function decodeMovementFast(movementData: bigint, speed: number): ReturnType<typeof decodeMovementSlow> {
  const parcelIndex = readBits(movementData, 0, 17)
  const relX = dequantize(readBits(movementData, 17, 8), 8, 0, 16)
  const relZ = dequantize(readBits(movementData, 25, 8), 8, 0, 16)
  const relY = dequantize(readBits(movementData, 33, 13), 13, 0, 200)
  const velXSign = readBits(movementData, 46, 1) === 1
  const velYSign = readBits(movementData, 52, 1) === 1
  const velZSign = readBits(movementData, 58, 1) === 1
  const velX = dequantize(readBits(movementData, 47, 5), 5, 0, speed) * (velXSign ? -1 : 1)
  const velY = dequantize(readBits(movementData, 53, 5), 5, 0, speed) * (velYSign ? -1 : 1)
  const velZ = dequantize(readBits(movementData, 59, 5), 5, 0, speed) * (velZSign ? -1 : 1)
  return {
    parcelIndex,
    relative: { x: relX, y: relY, z: relZ },
    velocity: { x: velX, y: velY, z: velZ }
  }
}

function parcelFromIndex(index: number, bounds: RealmBounds): { x: number; y: number } {
  const width = bounds.maxX - bounds.minX + 5
  const x = (index % width) + (bounds.minX - 2)
  const y = Math.floor(index / width) + (bounds.minY - 2)
  return { x, y }
}

function worldPosition(
  parcelIndex: number,
  relative: { x: number; y: number; z: number },
  bounds: RealmBounds
): { x: number; y: number; z: number } {
  const parcel = parcelFromIndex(parcelIndex, bounds)
  return {
    x: parcel.x * 16 + relative.x,
    y: relative.y,
    z: -(parcel.y * 16 + relative.z)
  }
}

/** Decode RFC4 MovementCompressed — Bevy `movement_compressed.rs::from_proto`. */
export function decodeMovementCompressedTransform(
  packet:
    | Rfc4MovementCompressed
    | EncodedMovementCompressed
    | DecodedMovementCompressedProto,
  bounds: RealmBounds | null
): {
  x: number
  y: number
  z: number
  yaw: number
  vx: number
  vy: number
  vz: number
} | null {
  if (!bounds) return null

  const { temporalData, movementData } = decodeMovementCompressedFields(packet)
  const temporal = decodeTemporal(temporalData)

  let decoded: ReturnType<typeof decodeMovementSlow>
  if (temporal.velocityTier === VelocityTier.Med) {
    decoded = decodeMovementFast(movementData, 12)
  } else if (temporal.velocityTier === VelocityTier.Fast) {
    decoded = decodeMovementFast(movementData, 50)
  } else {
    decoded = decodeMovementSlow(movementData)
  }

  const pos = worldPosition(decoded.parcelIndex, decoded.relative, bounds)
  return {
    x: pos.x,
    y: pos.y,
    z: pos.z,
    yaw: temporal.rotationRad,
    vx: decoded.velocity.x,
    vy: decoded.velocity.y,
    vz: -decoded.velocity.z
  }
}

function parcelRelativeCoord(worldAlongAxis: number): { parcel: number; relative: number } {
  let parcel = Math.floor(worldAlongAxis / 16)
  let relative = worldAlongAxis - parcel * 16
  if (relative < 0) {
    parcel -= 1
    relative += 16
  }
  return { parcel, relative }
}

/** Encode RFC4 MovementCompressed — Bevy `movement_compressed.rs::Movement::new`. */
export function encodeMovementCompressed(
  x: number,
  y: number,
  z: number,
  yaw: number,
  bounds: RealmBounds,
  elapsedSec: number,
  velocity: { x: number; y: number; z: number } = { x: 0, y: 0, z: 0 }
): EncodedMovementCompressed {
  const { parcel: parcelX, relative: relX } = parcelRelativeCoord(x)
  const { parcel: parcelY, relative: relZ } = parcelRelativeCoord(-z)
  const width = bounds.maxX - bounds.minX + 5
  const parcelIndex = Math.max(
    0,
    Math.min(
      (1 << 17) - 1,
      parcelX - (bounds.minX - 2) + (parcelY - (bounds.minY - 2)) * width
    )
  )
  const relY = y
  const velMax = Math.max(Math.abs(velocity.x), Math.abs(velocity.y), Math.abs(velocity.z))

  let velocityTier = VelocityTier.Slow
  let movementData = 0n
  const velXSign = velocity.x < 0
  const velYSign = velocity.y < 0
  const velZSign = velocity.z >= 0

  if (velMax <= 4) {
    velocityTier = VelocityTier.Slow
    movementData =
      BigInt(parcelIndex) |
      (BigInt(quantize(relX, 10, 0, 16)) << 17n) |
      (BigInt(quantize(relZ, 10, 0, 16)) << 27n) |
      (BigInt(quantize(relY, 13, 0, 200)) << 37n) |
      (BigInt(velXSign ? 1 : 0) << 50n) |
      (BigInt(quantize(Math.abs(velocity.x), 3, 0, 4)) << 51n) |
      (BigInt(velYSign ? 1 : 0) << 54n) |
      (BigInt(quantize(Math.abs(velocity.y), 3, 0, 4)) << 55n) |
      (BigInt(velZSign ? 1 : 0) << 58n) |
      (BigInt(quantize(Math.abs(velocity.z), 3, 0, 4)) << 59n)
  } else {
    const speed = velMax < 12 ? 12 : 50
    velocityTier = velMax < 12 ? VelocityTier.Med : VelocityTier.Fast
    movementData =
      BigInt(parcelIndex) |
      (BigInt(quantize(relX, 8, 0, 16)) << 17n) |
      (BigInt(quantize(relZ, 8, 0, 16)) << 25n) |
      (BigInt(quantize(relY, 13, 0, 200)) << 33n) |
      (BigInt(velXSign ? 1 : 0) << 46n) |
      (BigInt(quantize(Math.abs(velocity.x), 5, 0, speed)) << 47n) |
      (BigInt(velYSign ? 1 : 0) << 52n) |
      (BigInt(quantize(Math.abs(velocity.y), 5, 0, speed)) << 53n) |
      (BigInt(velZSign ? 1 : 0) << 58n) |
      (BigInt(quantize(Math.abs(velocity.z), 5, 0, speed)) << 59n)
  }

  return {
    temporalData: encodeTemporal(yaw, velocityTier, elapsedSec),
    movementData: Long.fromString(movementData.toString(), true),
    headSyncData: 0,
    pointAtData: 0
  }
}

export function realmBoundsFromParcels(parcels: string[]): RealmBounds | null {
  if (!parcels.length) return null
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity

  for (const parcel of parcels) {
    const [xs, ys] = parcel.split(',')
    const x = Number.parseInt(xs.trim(), 10)
    const y = Number.parseInt(ys.trim(), 10)
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue
    minX = Math.min(minX, x)
    minY = Math.min(minY, y)
    maxX = Math.max(maxX, x)
    maxY = Math.max(maxY, y)
  }

  if (!Number.isFinite(minX)) return null
  return { minX, minY, maxX, maxY }
}

/** Bevy realm bounds use a 2-parcel padding when indexing MovementCompressed parcels. */
export function expandRealmBounds(bounds: RealmBounds | null, padding = 2): RealmBounds | null {
  if (!bounds) return null
  return {
    minX: bounds.minX - padding,
    minY: bounds.minY - padding,
    maxX: bounds.maxX + padding,
    maxY: bounds.maxY + padding
  }
}
