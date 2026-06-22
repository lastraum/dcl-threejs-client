/**
 * DCM — Decentraland Chat Media v1
 * Binary scene chat images over RFC4 `Packet.scene` with `scene_id = dcl.chat.media`.
 * Chunked for LiveKit reliable data packet limits; full payload may be up to 1 MiB.
 */
import type { PreparedChatImage } from './prepareChatImage'

export const DCM_SCENE_ID = 'dcl.chat.media'
export const DCM_MAX_IMAGE_BYTES = 1_048_576
/** Payload bytes per LiveKit chunk (room for RFC4 + DCM headers). */
export const DCM_CHUNK_DATA_SIZE = 12_000

const MAGIC = new Uint8Array([0x44, 0x43, 0x4d, 0x01]) // DCM\x01
const VERSION = 1
const KIND_IMAGE = 1
const DELIVERY_INLINE = 1
const DELIVERY_CHUNK = 3

const MIME_ENC = new TextEncoder()
const MIME_DEC = new TextDecoder()

export type DecodedDcmImage = {
  messageId: string
  mime: string
  width: number
  height: number
  time: number
  bytes: Uint8Array
}

export function createDcmMessageId(): string {
  return crypto.randomUUID()
}

export function messageIdToBytes(id: string): Uint8Array {
  const hex = id.replace(/-/g, '')
  if (hex.length !== 32) throw new Error('Invalid message id')
  const out = new Uint8Array(16)
  for (let i = 0; i < 16; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return out
}

export function messageIdFromBytes(bytes: Uint8Array): string {
  if (bytes.length !== 16) return ''
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** Split prepared image into one or more DCM envelopes (chunked when needed). */
export function encodeDcmImageEnvelopes(
  image: PreparedChatImage,
  messageId: string,
  timeSec: number
): Uint8Array[] {
  const idBytes = messageIdToBytes(messageId)
  const mimeBytes = MIME_ENC.encode(image.mime)
  if (mimeBytes.length > 64) throw new Error('MIME type too long')

  if (image.bytes.length <= DCM_CHUNK_DATA_SIZE) {
    return [encodeInlineEnvelope(idBytes, mimeBytes, image, timeSec)]
  }

  const chunkPayload = DCM_CHUNK_DATA_SIZE
  const chunkCount = Math.ceil(image.bytes.length / chunkPayload)
  const envelopes: Uint8Array[] = []

  for (let i = 0; i < chunkCount; i++) {
    const start = i * chunkPayload
    const slice = image.bytes.subarray(start, Math.min(start + chunkPayload, image.bytes.length))
    envelopes.push(
      encodeChunkEnvelope(idBytes, mimeBytes, image.width, image.height, timeSec, i, chunkCount, slice)
    )
  }

  return envelopes
}

function encodeInlineEnvelope(
  idBytes: Uint8Array,
  mimeBytes: Uint8Array,
  image: PreparedChatImage,
  timeSec: number
): Uint8Array {
  const size = 4 + 1 + 1 + 1 + 16 + 1 + mimeBytes.length + 2 + 2 + 8 + 4 + image.bytes.length
  const out = new Uint8Array(size)
  const view = new DataView(out.buffer)
  let o = 0
  out.set(MAGIC, o)
  o += 4
  out[o++] = VERSION
  out[o++] = KIND_IMAGE
  out[o++] = DELIVERY_INLINE
  out.set(idBytes, o)
  o += 16
  out[o++] = mimeBytes.length
  out.set(mimeBytes, o)
  o += mimeBytes.length
  view.setUint16(o, image.width, true)
  o += 2
  view.setUint16(o, image.height, true)
  o += 2
  view.setFloat64(o, timeSec, true)
  o += 8
  view.setUint32(o, image.bytes.length, true)
  o += 4
  out.set(image.bytes, o)
  return out
}

function encodeChunkEnvelope(
  idBytes: Uint8Array,
  mimeBytes: Uint8Array,
  width: number,
  height: number,
  timeSec: number,
  chunkIndex: number,
  chunkCount: number,
  payload: Uint8Array
): Uint8Array {
  const size = 4 + 1 + 1 + 1 + 16 + 1 + mimeBytes.length + 2 + 2 + 8 + 2 + 2 + 2 + payload.length
  const out = new Uint8Array(size)
  const view = new DataView(out.buffer)
  let o = 0
  out.set(MAGIC, o)
  o += 4
  out[o++] = VERSION
  out[o++] = KIND_IMAGE
  out[o++] = DELIVERY_CHUNK
  out.set(idBytes, o)
  o += 16
  out[o++] = mimeBytes.length
  out.set(mimeBytes, o)
  o += mimeBytes.length
  view.setUint16(o, width, true)
  o += 2
  view.setUint16(o, height, true)
  o += 2
  view.setFloat64(o, timeSec, true)
  o += 8
  view.setUint16(o, chunkIndex, true)
  o += 2
  view.setUint16(o, chunkCount, true)
  o += 2
  view.setUint16(o, payload.length, true)
  o += 2
  out.set(payload, o)
  return out
}

type ParsedEnvelope =
  | {
      delivery: 'inline'
      messageId: string
      mime: string
      width: number
      height: number
      time: number
      bytes: Uint8Array
    }
  | {
      delivery: 'chunk'
      messageId: string
      mime: string
      width: number
      height: number
      time: number
      chunkIndex: number
      chunkCount: number
      bytes: Uint8Array
    }
  | null

function parseEnvelope(data: Uint8Array): ParsedEnvelope {
  if (data.length < 32) return null
  for (let i = 0; i < 4; i++) {
    if (data[i] !== MAGIC[i]) return null
  }
  if (data[4] !== VERSION || data[5] !== KIND_IMAGE) return null

  const delivery = data[6]
  const idBytes = data.subarray(7, 23)
  const messageId = messageIdFromBytes(idBytes)
  const mimeLen = data[23]!
  if (data.length < 24 + mimeLen + 12) return null
  const mime = MIME_DEC.decode(data.subarray(24, 24 + mimeLen))
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  let o = 24 + mimeLen
  const width = view.getUint16(o, true)
  o += 2
  const height = view.getUint16(o, true)
  o += 2
  const time = view.getFloat64(o, true)
  o += 8

  if (delivery === DELIVERY_INLINE) {
    if (data.length < o + 4) return null
    const len = view.getUint32(o, true)
    o += 4
    if (data.length < o + len || len > DCM_MAX_IMAGE_BYTES) return null
    return {
      delivery: 'inline',
      messageId,
      mime,
      width,
      height,
      time,
      bytes: data.subarray(o, o + len)
    }
  }

  if (delivery === DELIVERY_CHUNK) {
    if (data.length < o + 6) return null
    const chunkIndex = view.getUint16(o, true)
    o += 2
    const chunkCount = view.getUint16(o, true)
    o += 2
    const len = view.getUint16(o, true)
    o += 2
    if (chunkCount === 0 || chunkIndex >= chunkCount) return null
    if (data.length < o + len) return null
    return {
      delivery: 'chunk',
      messageId,
      mime,
      width,
      height,
      time,
      chunkIndex,
      chunkCount,
      bytes: data.subarray(o, o + len)
    }
  }

  return null
}

type PartialChunk = {
  mime: string
  width: number
  height: number
  time: number
  chunkCount: number
  chunks: (Uint8Array | null)[]
  received: number
  updatedAt: number
}

/** Reassemble chunked DCM image packets from a single sender. */
export class DcmInboundAssembler {
  private readonly partial = new Map<string, PartialChunk>()

  ingest(senderAddress: string, data: Uint8Array): DecodedDcmImage | null {
    const parsed = parseEnvelope(data)
    if (!parsed) return null

    if (parsed.delivery === 'inline') {
      if (!isAllowedChatMime(parsed.mime)) return null
      return {
        messageId: parsed.messageId,
        mime: parsed.mime,
        width: parsed.width,
        height: parsed.height,
        time: parsed.time,
        bytes: parsed.bytes
      }
    }

    const key = `${senderAddress.toLowerCase()}\0${parsed.messageId}`
    let entry = this.partial.get(key)
    if (!entry) {
      entry = {
        mime: parsed.mime,
        width: parsed.width,
        height: parsed.height,
        time: parsed.time,
        chunkCount: parsed.chunkCount,
        chunks: new Array(parsed.chunkCount).fill(null),
        received: 0,
        updatedAt: performance.now()
      }
      this.partial.set(key, entry)
    }

    if (entry.chunkCount !== parsed.chunkCount) return null
    if (entry.chunks[parsed.chunkIndex]) return null

    entry.chunks[parsed.chunkIndex] = parsed.bytes
    entry.received++
    entry.updatedAt = performance.now()

    if (entry.received < entry.chunkCount) {
      this.pruneStale()
      return null
    }

    this.partial.delete(key)
    if (!isAllowedChatMime(entry.mime)) return null

    let total = 0
    for (const c of entry.chunks) total += c?.length ?? 0
    if (total > DCM_MAX_IMAGE_BYTES) return null

    const bytes = new Uint8Array(total)
    let offset = 0
    for (const c of entry.chunks) {
      if (!c) return null
      bytes.set(c, offset)
      offset += c.length
    }

    return {
      messageId: parsed.messageId,
      mime: entry.mime,
      width: entry.width,
      height: entry.height,
      time: entry.time,
      bytes
    }
  }

  private pruneStale(): void {
    const now = performance.now()
    for (const [key, entry] of this.partial) {
      if (now - entry.updatedAt > 60_000) this.partial.delete(key)
    }
  }
}

export function isAllowedChatMime(mime: string): boolean {
  const m = mime.toLowerCase()
  return m === 'image/jpeg' || m === 'image/png' || m === 'image/webp' || m === 'image/gif'
}

export function chatMediaBlob(bytes: Uint8Array, mime: string): Blob {
  const copy = bytes.slice()
  return new Blob([copy], { type: mime })
}