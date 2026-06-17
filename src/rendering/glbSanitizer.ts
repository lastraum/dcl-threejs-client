const GLB_MAGIC = 0x46546c67 // 'glTF'
const JSON_CHUNK_TYPE = 0x4e4f534a // 'JSON'

const loggedNonGlb = new Set<string>()

/** Log once per content hash when Catalyst returns non-GLB bytes (JSON metadata, PNG, etc.). */
export function logNonGlbOnce(key: string): void {
  if (loggedNonGlb.has(key)) return
  loggedNonGlb.add(key)
  console.debug('[glb] not GLB bytes', key.slice(0, 20))
}

export function isGlbBuffer(buffer: ArrayBuffer): boolean {
  return buffer.byteLength >= 4 && new DataView(buffer).getUint32(0, true) === GLB_MAGIC
}

/** Walk chunk table — rejects truncated or misaligned GLBs (common from bad IDB writes). */
export function validateGlbBuffer(buffer: ArrayBuffer): boolean {
  if (buffer.byteLength < 12) return false
  const view = new DataView(buffer)
  if (view.getUint32(0, true) !== GLB_MAGIC) return false
  const totalLength = view.getUint32(8, true)
  if (totalLength !== buffer.byteLength) return false

  let offset = 12
  while (offset + 8 <= totalLength) {
    const chunkLength = view.getUint32(offset, true)
    if (chunkLength % 4 !== 0) return false
    if (offset + 8 + chunkLength > totalLength) return false
    offset += 8 + chunkLength
  }
  return offset === totalLength
}

/** Sanitize JSON padding then verify GLB magic + chunk table (ignores Content-Type). */
export function prepareGlbBytes(buffer: ArrayBuffer): ArrayBuffer | null {
  if (!buffer?.byteLength) return null
  const sanitized = sanitizeGlbJsonPadding(buffer)
  if (!isGlbBuffer(sanitized) || !validateGlbBuffer(sanitized)) return null
  return sanitized
}

function padChunkData(data: Uint8Array, chunkType: number): Uint8Array {
  const pad = (4 - (data.byteLength % 4)) % 4
  if (pad === 0) return data
  const out = new Uint8Array(data.byteLength + pad)
  out.set(data)
  if (chunkType === JSON_CHUNK_TYPE) out.fill(0x20, data.byteLength)
  return out
}

/** Trim null padding from GLB JSON chunks (common in UnityGLTF exports). */
export function sanitizeGlbJsonPadding(buffer: ArrayBuffer): ArrayBuffer {
  if (buffer.byteLength < 12) return buffer

  const view = new DataView(buffer)
  if (view.getUint32(0, true) !== GLB_MAGIC) return buffer

  const src = new Uint8Array(buffer)
  const totalLength = view.getUint32(8, true)
  const chunks: Array<{ type: number; data: Uint8Array }> = []

  let offset = 12
  let changed = false

  while (offset + 8 <= totalLength) {
    const chunkLength = view.getUint32(offset, true)
    const chunkType = view.getUint32(offset + 4, true)
    const chunkData = src.subarray(offset + 8, offset + 8 + chunkLength)

    let data = chunkData
    if (chunkType === JSON_CHUNK_TYPE) {
      let end = chunkLength
      while (end > 0 && chunkData[end - 1] === 0) end--
      if (end !== chunkLength) {
        data = chunkData.subarray(0, end)
        changed = true
      }
    }

    chunks.push({ type: chunkType, data: padChunkData(data, chunkType) })
    offset += 8 + chunkLength
  }

  if (!changed) return buffer

  const bodyLength = chunks.reduce((sum, chunk) => sum + 8 + chunk.data.byteLength, 0)
  const out = new Uint8Array(12 + bodyLength)
  new DataView(out.buffer).setUint32(0, GLB_MAGIC, true)
  new DataView(out.buffer).setUint32(4, view.getUint32(4, true), true)
  new DataView(out.buffer).setUint32(8, 12 + bodyLength, true)

  let write = 12
  for (const chunk of chunks) {
    new DataView(out.buffer).setUint32(write, chunk.data.byteLength, true)
    new DataView(out.buffer).setUint32(write + 4, chunk.type, true)
    out.set(chunk.data, write + 8)
    write += 8 + chunk.data.byteLength
  }

  return out.buffer
}
