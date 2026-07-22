/**
 * Worlds content server base URLs — official default + custom (self-hosted) servers.
 *
 * Official Explorer is tied to known hosts + asset-bundle-registry; this client loads
 * raw content hashes, so custom servers only need a compatible `/world/{name}/about`
 * + `/contents/{hash}` surface.
 */

export const OFFICIAL_WORLDS_CONTENT_SERVER = 'https://worlds-content-server.decentraland.org'

/** Env override for default server (still overridable per-route via `customServer`). */
export function defaultWorldsContentServer(): string {
  const fromEnv =
    typeof import.meta !== 'undefined'
      ? (import.meta.env?.VITE_WORLDS_CONTENT_SERVER as string | undefined)?.trim()
      : undefined
  return normalizeCustomServerUrl(fromEnv) ?? OFFICIAL_WORLDS_CONTENT_SERVER
}

/**
 * Normalize a user/server string to an origin-style base without trailing slash.
 * Accepts `https://host`, `host`, `host/path` (path stripped to origin for host-only),
 * rejects non-http(s).
 */
export function normalizeCustomServerUrl(raw: string | null | undefined): string | null {
  const value = String(raw ?? '').trim()
  if (!value) return null

  let candidate = value
  if (!/^https?:\/\//i.test(candidate)) {
    // Bare host → https
    candidate = `https://${candidate.replace(/^\/+/, '')}`
  }

  let url: URL
  try {
    url = new URL(candidate)
  } catch {
    return null
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
  // Worlds content servers are origin-rooted (…/world/…, …/contents/…).
  // Drop path/query/hash so `https://host/foo` and `https://host` both mean the server root.
  const base = `${url.protocol}//${url.host}`.replace(/\/+$/, '')
  return base || null
}

export function isOfficialWorldsServer(base: string | null | undefined): boolean {
  const n = normalizeCustomServerUrl(base) ?? ''
  const official = normalizeCustomServerUrl(OFFICIAL_WORLDS_CONTENT_SERVER) ?? ''
  return n.toLowerCase() === official.toLowerCase()
}

/** Effective content server for a world route (custom or default). */
export function worldsContentBase(customServer?: string | null): string {
  return normalizeCustomServerUrl(customServer) ?? defaultWorldsContentServer()
}

export function worldsAboutUrl(contentServerBase: string, worldName: string): string {
  const base = worldsContentBase(contentServerBase)
  return `${base}/world/${encodeURIComponent(worldName)}/about`
}

export function worldsContentsUrl(contentServerBase: string, hash: string): string {
  const base = worldsContentBase(contentServerBase)
  return `${base}/contents/${encodeURIComponent(hash)}`
}

/** Entity CID from `urn:decentraland:entity:{cid}?=&baseUrl=…`. */
export function entityIdFromScenesUrn(urn: string): string | null {
  const prefix = 'urn:decentraland:entity:'
  const trimmed = urn.trim()
  if (!trimmed.toLowerCase().startsWith(prefix)) {
    const m = /(?:urn:decentraland:(?:offchain:|)entity:)?(bafy[a-z0-9]+)/i.exec(trimmed)
    return m?.[1] ?? null
  }
  return trimmed.slice(prefix.length).split(/[?&#]/)[0]?.trim() || null
}

/** Optional content base embedded in scenesUrn query (`baseUrl=`). */
export function contentBaseFromScenesUrn(urn: string): string | null {
  try {
    // URN may be `urn:…?=&baseUrl=https://…/contents/` — URL parser needs a fake origin.
    const asUrl = new URL(urn.includes('://') ? urn : `urn:placeholder:${urn}`)
    const baseUrl = asUrl.searchParams.get('baseUrl')?.trim()
    if (!baseUrl) return null
    // baseUrl is usually `https://host/contents/` — keep path for contents root.
    const u = new URL(baseUrl)
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null
    return baseUrl.replace(/\/+$/, '')
  } catch {
    return null
  }
}

/**
 * Parse a free-form travel string into custom server + world name when possible.
 * Accepts:
 * - `https://host` + separate world (caller supplies world)
 * - `https://host/world/my.dcl.eth`
 * - `https://host/?customServer=…&worldName=…` (redundant but ok)
 * - `https://host/?worldName=foo`
 * - query fragment `customServer=https://…&worldName=foo`
 */
export function parseCustomServerWorldRef(raw: string): {
  customServer: string
  worldName: string
} | null {
  const text = raw.trim()
  if (!text) return null

  // Query-only: customServer=…&worldName=…
  if (!/^https?:\/\//i.test(text) && /customServer=/i.test(text)) {
    const qs = new URLSearchParams(text.includes('?') ? text.split('?').pop()! : text)
    const server = normalizeCustomServerUrl(qs.get('customServer') ?? qs.get('server'))
    const world =
      qs.get('worldName')?.trim() ||
      qs.get('world')?.trim() ||
      qs.get('name')?.trim() ||
      ''
    if (server && world) return { customServer: server, worldName: world }
  }

  if (!/^https?:\/\//i.test(text)) return null

  let url: URL
  try {
    url = new URL(text)
  } catch {
    return null
  }

  const serverFromQuery = normalizeCustomServerUrl(
    url.searchParams.get('customServer') ?? url.searchParams.get('server')
  )
  const worldFromQuery =
    url.searchParams.get('worldName')?.trim() ||
    url.searchParams.get('world')?.trim() ||
    url.searchParams.get('name')?.trim() ||
    ''

  const server = serverFromQuery ?? `${url.protocol}//${url.host}`.replace(/\/+$/, '')

  // Path: /world/{name} or /worlds/{name}
  const pathMatch = url.pathname.match(/\/worlds?\/([^/]+)\/?/i)
  let worldName = worldFromQuery
  if (!worldName && pathMatch?.[1]) {
    try {
      worldName = decodeURIComponent(pathMatch[1])
    } catch {
      worldName = pathMatch[1]
    }
  }

  // Path: /{name} single segment (not empty)
  if (!worldName) {
    const segs = url.pathname.replace(/\/+$/, '').split('/').filter(Boolean)
    if (segs.length === 1) {
      try {
        worldName = decodeURIComponent(segs[0]!)
      } catch {
        worldName = segs[0]!
      }
    }
  }

  if (!server || !worldName) return null
  return { customServer: server, worldName }
}
