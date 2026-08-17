/**
 * Creator Hub / sdk-commands preview websocket frames.
 *
 * Unity `LocalSceneDevelopmentController` reads binary `WsSceneMessage`
 * (`decentraland.sdk.development` proto). Bevy also accepts the older JSON
 * `{ type: "SCENE_UPDATE", payload: { sceneId } }` text frames — the preview
 * server interleaves both.
 */

export type PreviewSceneUpdate =
  | { kind: 'scene'; sceneId: string }
  | { kind: 'model'; sceneId: string; src: string; hash: string }

export function isLocalPreviewHttpUrl(raw: string | null | undefined): boolean {
  if (!raw) return false
  try {
    const url = new URL(raw)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
    const host = url.hostname.toLowerCase()
    return host === 'localhost' || host === '127.0.0.1' || host === '[::1]'
  } catch {
    return false
  }
}

export function previewWsUrlFromHttp(originOrUrl: string): string {
  const url = new URL(originOrUrl)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.pathname = '/'
  url.search = ''
  url.hash = ''
  return url.toString()
}

export function parsePreviewWsText(text: string): PreviewSceneUpdate | null {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return null
  }
  if (!value || typeof value !== 'object') return null
  const rec = value as Record<string, unknown>
  const type = String(rec.type ?? rec.Type ?? '').toUpperCase()
  const payload =
    rec.payload && typeof rec.payload === 'object'
      ? (rec.payload as Record<string, unknown>)
      : rec
  const sceneId = stringField(payload, 'sceneId', 'scene_id', 'hash')
  if (type === 'UPDATE_MODEL' || type === 'SCENE_UPDATE_MODEL') {
    if (!sceneId) return null
    return {
      kind: 'model',
      sceneId,
      src: stringField(payload, 'src', 'file') ?? '',
      hash: stringField(payload, 'hash', 'contentHash') ?? ''
    }
  }
  if (type === 'SCENE_UPDATE' || type === 'UPDATE_SCENE' || type === 'RELOAD') {
    if (!sceneId) return null
    return { kind: 'scene', sceneId }
  }
  return null
}

/** Minimal proto3 decode of `WsSceneMessage` (no codegen). */
export function parsePreviewWsBinary(buf: Uint8Array): PreviewSceneUpdate | null {
  const fields = readMessage(buf)
  const sceneMsg = fields.get(1)
  if (sceneMsg instanceof Uint8Array) {
    const sceneId = readStringField(readMessage(sceneMsg), 1)
    return sceneId ? { kind: 'scene', sceneId } : null
  }
  const modelMsg = fields.get(2)
  if (modelMsg instanceof Uint8Array) {
    const inner = readMessage(modelMsg)
    const sceneId = readStringField(inner, 1)
    if (!sceneId) return null
    return {
      kind: 'model',
      sceneId,
      src: readStringField(inner, 2) ?? '',
      hash: readStringField(inner, 3) ?? ''
    }
  }
  return null
}

function stringField(rec: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const v = rec[key]
    if (typeof v === 'string' && v.trim()) return v.trim()
  }
  return null
}

function readStringField(fields: Map<number, Uint8Array | number>, id: number): string | null {
  const v = fields.get(id)
  if (!(v instanceof Uint8Array)) return null
  try {
    const s = new TextDecoder().decode(v).trim()
    return s || null
  } catch {
    return null
  }
}

function readMessage(buf: Uint8Array): Map<number, Uint8Array | number> {
  const out = new Map<number, Uint8Array | number>()
  let i = 0
  while (i < buf.length) {
    const [tag, n] = readVarint(buf, i)
    i = n
    const field = tag >>> 3
    const wire = tag & 7
    if (wire === 0) {
      const [val, n2] = readVarint(buf, i)
      i = n2
      out.set(field, val)
    } else if (wire === 2) {
      const [len, n2] = readVarint(buf, i)
      i = n2
      out.set(field, buf.subarray(i, i + len))
      i += len
    } else {
      break
    }
  }
  return out
}

function readVarint(buf: Uint8Array, start: number): [number, number] {
  let x = 0
  let s = 0
  let i = start
  while (i < buf.length) {
    const b = buf[i]!
    i++
    x |= (b & 0x7f) << s
    if ((b & 0x80) === 0) break
    s += 7
    if (s > 28) break
  }
  return [x >>> 0, i]
}
