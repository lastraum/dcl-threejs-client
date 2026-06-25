/**
 * DAV — Decentraland Avatar VRM v1
 * P2P custom VRM over RFC4 `Packet.scene` with `scene_id = dcl.client.avatar`.
 * Chunked for LiveKit reliable SCTP limits; sent on reliable data (not lossy). RAM-only on receivers.
 */
import { VRM_MAX_BYTES } from './constants'

export const DAV_SCENE_ID = 'dcl.client.avatar'
/** Payload bytes per LiveKit chunk (room for RFC4 + DAV headers). */
export const DAV_CHUNK_DATA_SIZE = 12_000

const MAGIC = new Uint8Array([0x44, 0x41, 0x56, 0x01])
const VERSION = 1

export const DavMessageType = {
  Announce: 1,
  Clear: 2,
  FetchRequest: 3,
  FetchBegin: 4,
  FetchChunk: 5,
  FetchEnd: 6,
  FetchError: 7
} as const

export type DavFetchErrorReason = 'not_found' | 'oversize' | 'busy'

export function hashHexToBytes(hex: string): Uint8Array {
  const h = hex.toLowerCase()
  if (h.length !== 64 || !/^[0-9a-f]+$/.test(h)) {
    throw new Error('DAV: invalid content hash')
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

export function encodeDavAnnounce(contentHashHex: string, byteSize: number): Uint8Array {
  const hash = hashHexToBytes(contentHashHex)
  const out = writeHeader(DavMessageType.Announce, 36)
  out.set(hash, 6)
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength)
  view.setUint32(38, byteSize, true)
  return out
}

export function encodeDavClear(): Uint8Array {
  return writeHeader(DavMessageType.Clear, 0)
}

export function encodeDavFetchRequest(contentHashHex: string): Uint8Array {
  const hash = hashHexToBytes(contentHashHex)
  const out = writeHeader(DavMessageType.FetchRequest, 32)
  out.set(hash, 6)
  return out
}

export function encodeDavFetchBegin(contentHashHex: string, totalSize: number): Uint8Array {
  const hash = hashHexToBytes(contentHashHex)
  const out = writeHeader(DavMessageType.FetchBegin, 36)
  out.set(hash, 6)
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength)
  view.setUint32(38, totalSize, true)
  return out
}

export function encodeDavFetchChunk(
  contentHashHex: string,
  offset: number,
  data: Uint8Array
): Uint8Array {
  const hash = hashHexToBytes(contentHashHex)
  const out = writeHeader(DavMessageType.FetchChunk, 40 + data.length)
  out.set(hash, 6)
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength)
  view.setUint32(38, offset, true)
  out.set(data, 42)
  return out
}

export function encodeDavFetchEnd(contentHashHex: string): Uint8Array {
  const hash = hashHexToBytes(contentHashHex)
  const out = writeHeader(DavMessageType.FetchEnd, 32)
  out.set(hash, 6)
  return out
}

export function encodeDavFetchError(contentHashHex: string, reason: DavFetchErrorReason): Uint8Array {
  const hash = hashHexToBytes(contentHashHex)
  const reasonCode = reason === 'oversize' ? 2 : reason === 'busy' ? 3 : 1
  const out = writeHeader(DavMessageType.FetchError, 33)
  out.set(hash, 6)
  out[38] = reasonCode
  return out
}

/** Split a large DAV message into transport-sized envelopes when needed. */
export function encodeDavEnvelopes(message: Uint8Array): Uint8Array[] {
  if (message.length <= DAV_CHUNK_DATA_SIZE + 64) return [message]
  return [message]
}

/** Chunk full VRM bytes into FETCH_CHUNK envelopes. */
export function encodeDavVrmChunkStream(contentHashHex: string, bytes: ArrayBuffer): Uint8Array[] {
  const view = new Uint8Array(bytes)
  const envelopes: Uint8Array[] = [encodeDavFetchBegin(contentHashHex, bytes.byteLength)]
  for (let offset = 0; offset < view.length; offset += DAV_CHUNK_DATA_SIZE) {
    const slice = view.subarray(offset, Math.min(offset + DAV_CHUNK_DATA_SIZE, view.length))
    envelopes.push(encodeDavFetchChunk(contentHashHex, offset, slice))
  }
  envelopes.push(encodeDavFetchEnd(contentHashHex))
  return envelopes
}

export type DecodedDavMessage =
  | { type: typeof DavMessageType.Announce; hash: string; byteSize: number }
  | { type: typeof DavMessageType.Clear }
  | { type: typeof DavMessageType.FetchRequest; hash: string }
  | { type: typeof DavMessageType.FetchBegin; hash: string; totalSize: number }
  | { type: typeof DavMessageType.FetchChunk; hash: string; offset: number; data: Uint8Array }
  | { type: typeof DavMessageType.FetchEnd; hash: string }
  | { type: typeof DavMessageType.FetchError; hash: string; reason: DavFetchErrorReason }

export function tryDecodeDavMessage(data: Uint8Array): DecodedDavMessage | null {
  if (data.length < 6) return null
  if (data[0] !== MAGIC[0] || data[1] !== MAGIC[1] || data[2] !== MAGIC[2] || data[3] !== MAGIC[3]) {
    return null
  }
  if (data[4] !== VERSION) return null

  const type = data[5]
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)

  switch (type) {
    case DavMessageType.Announce: {
      if (data.length < 42) return null
      const hash = hashBytesToHex(data.subarray(6, 38))
      const byteSize = view.getUint32(38, true)
      return { type, hash, byteSize }
    }
    case DavMessageType.Clear:
      return { type }
    case DavMessageType.FetchRequest: {
      if (data.length < 38) return null
      return { type, hash: hashBytesToHex(data.subarray(6, 38)) }
    }
    case DavMessageType.FetchBegin: {
      if (data.length < 42) return null
      const totalSize = view.getUint32(38, true)
      if (totalSize <= 0 || totalSize > VRM_MAX_BYTES) return null
      return { type, hash: hashBytesToHex(data.subarray(6, 38)), totalSize }
    }
    case DavMessageType.FetchChunk: {
      if (data.length < 42) return null
      const offset = view.getUint32(38, true)
      return {
        type,
        hash: hashBytesToHex(data.subarray(6, 38)),
        offset,
        data: data.subarray(42)
      }
    }
    case DavMessageType.FetchEnd: {
      if (data.length < 38) return null
      return { type, hash: hashBytesToHex(data.subarray(6, 38)) }
    }
    case DavMessageType.FetchError: {
      if (data.length < 39) return null
      const code = data[38]
      const reason: DavFetchErrorReason =
        code === 2 ? 'oversize' : code === 3 ? 'busy' : 'not_found'
      return { type, hash: hashBytesToHex(data.subarray(6, 38)), reason }
    }
    default:
      return null
  }
}