/**
 * DPET — Decentraland Client Pet v1
 * P2P pets over RFC4 `Packet.scene` with `scene_id = dcl.client.pet`.
 * Mirrors DAV (custom VRM) — not scene-worker CRDT.
 */
import { DPET_CHUNK_DATA_SIZE, PET_MAX_BYTES } from './constants'
import { petCategoryFromWire, petCategoryToWire } from './petCategories'
import type { PetAnimState, PetCategory, PetPose } from './types'

export const DPET_SCENE_ID = 'dcl.client.pet'

const MAGIC = new Uint8Array([0x44, 0x50, 0x45, 0x54]) // DPET
const VERSION = 1

export const DpetMessageType = {
  Announce: 1,
  Clear: 2,
  FetchRequest: 3,
  FetchBegin: 4,
  FetchChunk: 5,
  FetchEnd: 6,
  FetchError: 7,
  WantAnnounce: 8,
  Pose: 9
} as const

export type DpetFetchErrorReason = 'not_found' | 'oversize' | 'busy'

// Append-only: codes 0-5 are pinned so older peers keep decoding the original
// bands. A peer on an older build maps 6/7 to idle (default arm below).
const ANIM_WIRE: Record<PetAnimState, number> = {
  idle: 0,
  walk: 1,
  run: 2,
  fly: 3,
  flyFast: 4,
  afk: 5,
  trot: 6,
  sit: 7
}

function animFromWire(code: number): PetAnimState {
  switch (code) {
    case 1:
      return 'walk'
    case 2:
      return 'run'
    case 3:
      return 'fly'
    case 4:
      return 'flyFast'
    case 5:
      return 'afk'
    case 6:
      return 'trot'
    case 7:
      return 'sit'
    default:
      return 'idle'
  }
}

export function hashHexToBytes(hex: string): Uint8Array {
  const h = hex.toLowerCase()
  if (h.length !== 64 || !/^[0-9a-f]+$/.test(h)) {
    throw new Error('DPET: invalid content hash')
  }
  const out = new Uint8Array(32)
  for (let i = 0; i < 32; i++) {
    out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16)
  }
  return out
}

export function hashBytesToHex(bytes: Uint8Array): string {
  if (bytes.length !== 32) return ''
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
}

function writeHeader(type: number, payloadLen: number): Uint8Array {
  const out = new Uint8Array(6 + payloadLen)
  out.set(MAGIC, 0)
  out[4] = VERSION
  out[5] = type
  return out
}

/** hash(32) + byteSize(u32) + category(u8) + meshYawOffsetDeg(i16) */
export function encodeDpetAnnounce(
  contentHashHex: string,
  byteSize: number,
  category: PetCategory,
  meshYawOffsetDeg = 0
): Uint8Array {
  const hash = hashHexToBytes(contentHashHex)
  const out = writeHeader(DpetMessageType.Announce, 39)
  out.set(hash, 6)
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength)
  view.setUint32(38, byteSize, true)
  out[42] = petCategoryToWire(category)
  view.setInt16(43, Math.round(meshYawOffsetDeg), true)
  return out
}

export function encodeDpetClear(): Uint8Array {
  return writeHeader(DpetMessageType.Clear, 0)
}

export function encodeDpetWantAnnounce(): Uint8Array {
  return writeHeader(DpetMessageType.WantAnnounce, 0)
}

export function encodeDpetFetchRequest(contentHashHex: string): Uint8Array {
  const hash = hashHexToBytes(contentHashHex)
  const out = writeHeader(DpetMessageType.FetchRequest, 32)
  out.set(hash, 6)
  return out
}

export function encodeDpetFetchBegin(contentHashHex: string, totalSize: number): Uint8Array {
  const hash = hashHexToBytes(contentHashHex)
  const out = writeHeader(DpetMessageType.FetchBegin, 36)
  out.set(hash, 6)
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength)
  view.setUint32(38, totalSize, true)
  return out
}

/**
 * Chunk payload: hash(32) + offset(u32) + data.
 * Must be 36 + data.length — older 40 + data.length left 4 zero pad bytes that
 * broke reassembly (gap at every chunk boundary: 6004 vs 6000 stride).
 */
export function encodeDpetFetchChunk(
  contentHashHex: string,
  offset: number,
  data: Uint8Array
): Uint8Array {
  const hash = hashHexToBytes(contentHashHex)
  const out = writeHeader(DpetMessageType.FetchChunk, 36 + data.length)
  out.set(hash, 6)
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength)
  view.setUint32(38, offset, true)
  out.set(data, 42)
  return out
}

export function encodeDpetFetchEnd(contentHashHex: string): Uint8Array {
  const hash = hashHexToBytes(contentHashHex)
  const out = writeHeader(DpetMessageType.FetchEnd, 32)
  out.set(hash, 6)
  return out
}

export function encodeDpetFetchError(
  contentHashHex: string,
  reason: DpetFetchErrorReason
): Uint8Array {
  const hash = hashHexToBytes(contentHashHex)
  const reasonCode = reason === 'oversize' ? 2 : reason === 'busy' ? 3 : 1
  const out = writeHeader(DpetMessageType.FetchError, 33)
  out.set(hash, 6)
  out[38] = reasonCode
  return out
}

/** Pose: x,y,z,yaw,speed (f32 LE) + anim u8 — scene-local DCL meters. */
export function encodeDpetPose(pose: PetPose): Uint8Array {
  const out = writeHeader(DpetMessageType.Pose, 21)
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength)
  view.setFloat32(6, pose.x, true)
  view.setFloat32(10, pose.y, true)
  view.setFloat32(14, pose.z, true)
  view.setFloat32(18, pose.yaw, true)
  view.setFloat32(22, pose.horizontalSpeed, true)
  out[26] = ANIM_WIRE[pose.anim] ?? 0
  return out
}

export function encodeDpetEnvelopes(message: Uint8Array): Uint8Array[] {
  if (message.length <= DPET_CHUNK_DATA_SIZE + 64) return [message]
  return [message]
}

export function encodeDpetGlbChunkStream(contentHashHex: string, bytes: ArrayBuffer): Uint8Array[] {
  const view = new Uint8Array(bytes)
  const envelopes: Uint8Array[] = [encodeDpetFetchBegin(contentHashHex, bytes.byteLength)]
  for (let offset = 0; offset < view.length; offset += DPET_CHUNK_DATA_SIZE) {
    const slice = view.subarray(offset, Math.min(offset + DPET_CHUNK_DATA_SIZE, view.length))
    envelopes.push(encodeDpetFetchChunk(contentHashHex, offset, slice))
  }
  envelopes.push(encodeDpetFetchEnd(contentHashHex))
  return envelopes
}

export type DecodedDpetMessage =
  | {
      type: typeof DpetMessageType.Announce
      hash: string
      byteSize: number
      category: PetCategory
      meshYawOffsetDeg: number
    }
  | { type: typeof DpetMessageType.Clear }
  | { type: typeof DpetMessageType.FetchRequest; hash: string }
  | { type: typeof DpetMessageType.FetchBegin; hash: string; totalSize: number }
  | { type: typeof DpetMessageType.FetchChunk; hash: string; offset: number; data: Uint8Array }
  | { type: typeof DpetMessageType.FetchEnd; hash: string }
  | { type: typeof DpetMessageType.FetchError; hash: string; reason: DpetFetchErrorReason }
  | { type: typeof DpetMessageType.WantAnnounce }
  | { type: typeof DpetMessageType.Pose; pose: PetPose }

export function tryDecodeDpetMessage(data: Uint8Array): DecodedDpetMessage | null {
  if (data.length < 6) return null
  if (data[0] !== MAGIC[0] || data[1] !== MAGIC[1] || data[2] !== MAGIC[2] || data[3] !== MAGIC[3]) {
    return null
  }
  if (data[4] !== VERSION) return null

  const type = data[5]
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)

  switch (type) {
    case DpetMessageType.Announce: {
      if (data.length < 43) return null
      const hash = hashBytesToHex(data.subarray(6, 38))
      const byteSize = view.getUint32(38, true)
      const category = petCategoryFromWire(data[42] ?? 0)
      const meshYawOffsetDeg = data.length >= 45 ? view.getInt16(43, true) : 0
      return { type, hash, byteSize, category, meshYawOffsetDeg }
    }
    case DpetMessageType.Clear:
      return { type }
    case DpetMessageType.FetchRequest: {
      if (data.length < 38) return null
      return { type, hash: hashBytesToHex(data.subarray(6, 38)) }
    }
    case DpetMessageType.FetchBegin: {
      if (data.length < 42) return null
      const totalSize = view.getUint32(38, true)
      if (totalSize <= 0 || totalSize > PET_MAX_BYTES) return null
      return { type, hash: hashBytesToHex(data.subarray(6, 38)), totalSize }
    }
    case DpetMessageType.FetchChunk: {
      if (data.length < 42) return null
      const offset = view.getUint32(38, true)
      return {
        type,
        hash: hashBytesToHex(data.subarray(6, 38)),
        offset,
        data: data.subarray(42)
      }
    }
    case DpetMessageType.FetchEnd: {
      if (data.length < 38) return null
      return { type, hash: hashBytesToHex(data.subarray(6, 38)) }
    }
    case DpetMessageType.FetchError: {
      if (data.length < 39) return null
      const code = data[38]
      const reason: DpetFetchErrorReason =
        code === 2 ? 'oversize' : code === 3 ? 'busy' : 'not_found'
      return { type, hash: hashBytesToHex(data.subarray(6, 38)), reason }
    }
    case DpetMessageType.WantAnnounce:
      return { type }
    case DpetMessageType.Pose: {
      if (data.length < 27) return null
      const pose: PetPose = {
        x: view.getFloat32(6, true),
        y: view.getFloat32(10, true),
        z: view.getFloat32(14, true),
        yaw: view.getFloat32(18, true),
        horizontalSpeed: view.getFloat32(22, true),
        anim: animFromWire(data[26] ?? 0)
      }
      return { type, pose }
    }
    default:
      return null
  }
}
