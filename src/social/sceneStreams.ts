/**
 * Scene landing live-stream catalog (companion PublicSceneStreamPage parity, browser-only).
 * Uses the same localStorage keys as dcl-companion `browserOnlyApi` so data can share an origin.
 */
import type { RouteTarget } from '../dcl/content/route'

const KEY_SCENE_CUSTOM_STREAMS = 'dcl-companion.browserOnly.sceneCustomStreams'
const KEY_SCENE_USER_STREAMS = 'dcl-companion.browserOnly.sceneUserStreams'

export type SceneStreamKind = 'world' | 'parcel'

export type UserSceneStream = {
  id: string
  wallet: string
  displayName: string
  source: 'm3u8' | 'cast'
  m3u8Url: string | null
  castPointer: string | null
  kind: SceneStreamKind
  pointer: string
  updatedAtMs: number
}

export type JoinLiveOption =
  | { id: string; label: string; kind: 'user'; stream: UserSceneStream }
  | { id: 'custom-hls'; label: string; kind: 'custom'; m3u8Url: string }

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return fallback
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* quota / private mode */
  }
}

export function sceneStreamTargetFromRoute(
  route: Extract<RouteTarget, { kind: 'coords' } | { kind: 'world' }>
): { pointer: string; kind: SceneStreamKind } {
  if (route.kind === 'coords') {
    return { pointer: `${route.x},${route.y}`, kind: 'parcel' }
  }
  return { pointer: route.worldName.trim(), kind: 'world' }
}

function storageKey(pointer: string, kind: SceneStreamKind): string {
  return `${kind}:${pointer.trim().toLowerCase()}`
}

function normalizePointer(pointer: string, kind: SceneStreamKind): string {
  const p = pointer.trim()
  if (kind === 'parcel') return p
  return p.toLowerCase()
}

function parseUserStreamRow(row: unknown): UserSceneStream | null {
  if (!row || typeof row !== 'object') return null
  const o = row as Record<string, unknown>
  const id = typeof o.id === 'string' ? o.id.trim() : ''
  const walletRaw =
    (typeof o.wallet === 'string' && o.wallet) ||
    (typeof o.walletAddress === 'string' && o.walletAddress) ||
    ''
  const wallet = walletRaw.trim().toLowerCase()
  if (!id || !wallet) return null
  const pointer = typeof o.pointer === 'string' ? o.pointer.trim() : ''
  const kind: SceneStreamKind = o.kind === 'parcel' ? 'parcel' : 'world'
  const m3u8Url =
    typeof o.m3u8Url === 'string' && o.m3u8Url.trim() ? o.m3u8Url.trim() : null
  const castPointer =
    typeof o.castPointer === 'string' && o.castPointer.trim() ? o.castPointer.trim() : null
  const source: 'm3u8' | 'cast' =
    o.source === 'cast' || (castPointer && !m3u8Url) ? 'cast' : 'm3u8'
  if (source === 'm3u8' && !m3u8Url) return null
  if (source === 'cast' && !castPointer) return null
  const displayName =
    typeof o.displayName === 'string' && o.displayName.trim()
      ? o.displayName.trim()
      : `${wallet.slice(0, 6)}…${wallet.slice(-4)}`
  const updatedAtMs = (() => {
    if (typeof o.updatedAtMs === 'number' && Number.isFinite(o.updatedAtMs)) return o.updatedAtMs
    if (typeof o.verifiedAtMs === 'number' && Number.isFinite(o.verifiedAtMs)) return o.verifiedAtMs
    if (typeof o.updatedAt === 'string') {
      const t = Date.parse(o.updatedAt)
      if (Number.isFinite(t)) return t
    }
    return Date.now()
  })()
  return {
    id,
    wallet,
    displayName,
    source,
    m3u8Url,
    castPointer,
    kind,
    pointer: pointer || '',
    updatedAtMs
  }
}

export function listUserStreams(pointer: string, kind: SceneStreamKind): UserSceneStream[] {
  const raw = readJson<unknown>(KEY_SCENE_USER_STREAMS, [])
  if (!Array.isArray(raw)) return []
  const want = normalizePointer(pointer, kind)
  const out: UserSceneStream[] = []
  for (const row of raw) {
    const s = parseUserStreamRow(row)
    if (!s) continue
    if (s.kind !== kind) continue
    if (normalizePointer(s.pointer, s.kind) !== want) continue
    out.push(s)
  }
  return out.sort((a, b) => b.updatedAtMs - a.updatedAtMs)
}

export function getCustomHlsUrl(pointer: string, kind: SceneStreamKind): string | null {
  const map = readJson<Record<string, unknown>>(KEY_SCENE_CUSTOM_STREAMS, {})
  const v = map[storageKey(pointer, kind)]
  return typeof v === 'string' && v.trim() ? v.trim() : null
}

export function setCustomHlsUrl(
  pointer: string,
  kind: SceneStreamKind,
  streamUrl: string
): string | null {
  const map = readJson<Record<string, unknown>>(KEY_SCENE_CUSTOM_STREAMS, {})
  const key = storageKey(pointer, kind)
  const url = streamUrl.trim()
  if (!url) delete map[key]
  else map[key] = url
  writeJson(KEY_SCENE_CUSTOM_STREAMS, map)
  return url || null
}

function randomId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}_${Date.now().toString(36)}`
}

export function registerUserM3u8Stream(input: {
  pointer: string
  kind: SceneStreamKind
  wallet: string
  displayName?: string
  m3u8Url: string
}): UserSceneStream {
  const m3u8Url = input.m3u8Url.trim()
  if (!/^https:\/\//i.test(m3u8Url) || !/\.m3u8(\?|#|$)/i.test(m3u8Url)) {
    throw new Error('Enter a full HTTPS .m3u8 URL')
  }
  const wallet = input.wallet.trim().toLowerCase()
  const pointer = input.pointer.trim()
  const kind = input.kind
  const raw = readJson<unknown[]>(KEY_SCENE_USER_STREAMS, [])
  const rows = Array.isArray(raw) ? [...raw] : []
  // One active listing per wallet+pointer
  const filtered = rows.filter((row) => {
    const s = parseUserStreamRow(row)
    if (!s) return true
    if (s.wallet !== wallet) return true
    if (s.kind !== kind) return true
    return normalizePointer(s.pointer, s.kind) !== normalizePointer(pointer, kind)
  })
  const stream: UserSceneStream = {
    id: randomId('ustream'),
    wallet,
    displayName:
      input.displayName?.trim() || `${wallet.slice(0, 6)}…${wallet.slice(-4)}`,
    source: 'm3u8',
    m3u8Url,
    castPointer: null,
    kind,
    pointer,
    updatedAtMs: Date.now()
  }
  filtered.unshift({
    id: stream.id,
    wallet,
    walletAddress: wallet,
    displayName: stream.displayName,
    source: 'm3u8',
    m3u8Url,
    castPointer: null,
    kind,
    pointer,
    updatedAtMs: stream.updatedAtMs,
    updatedAt: new Date(stream.updatedAtMs).toISOString()
  })
  writeJson(KEY_SCENE_USER_STREAMS, filtered)
  return stream
}

export function removeUserStream(streamId: string): void {
  const id = streamId.trim()
  if (!id) return
  const raw = readJson<unknown[]>(KEY_SCENE_USER_STREAMS, [])
  if (!Array.isArray(raw)) return
  writeJson(
    KEY_SCENE_USER_STREAMS,
    raw.filter((row) => {
      const s = parseUserStreamRow(row)
      return !s || s.id !== id
    })
  )
}

/** Options for the Join live menu on scene landing. */
export function listJoinLiveOptions(pointer: string, kind: SceneStreamKind): JoinLiveOption[] {
  const options: JoinLiveOption[] = []
  for (const stream of listUserStreams(pointer, kind)) {
    if (stream.source === 'm3u8' && stream.m3u8Url) {
      options.push({
        id: stream.id,
        label: `Live: ${stream.displayName}`,
        kind: 'user',
        stream
      })
    } else if (stream.source === 'cast' && stream.castPointer) {
      options.push({
        id: stream.id,
        label: `Live: ${stream.displayName} — Cast (${stream.castPointer})`,
        kind: 'user',
        stream
      })
    }
  }
  const custom = getCustomHlsUrl(pointer, kind)
  if (custom) {
    options.push({
      id: 'custom-hls',
      label: 'Owner saved m3u8',
      kind: 'custom',
      m3u8Url: custom
    })
  }
  return options
}

export function isHttpsM3u8(url: string): boolean {
  const u = url.trim()
  return /^https:\/\//i.test(u) && /\.m3u8(\?|#|$)/i.test(u)
}
