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
 * Parse `?realm=` host only (domain / origin). No `/world/` path required.
 * - `worlds.dcl-iwb.co`
 * - `https://worlds.dcl-iwb.co`
 * Also accepts Explorer composite `host/world/Name` → host only.
 */
export function parseRealmHost(raw: string): string | null {
  let text = raw.trim()
  if (!text) return null

  try {
    if (/%[0-9a-f]{2}/i.test(text)) text = decodeURIComponent(text)
  } catch {
    /* keep */
  }

  // host/world/Name → host only
  const pathWorld = /^(?:https?:\/\/)?([^/?#\s]+)\/worlds?\/([^/?#\s]+)\/?$/i.exec(text)
  if (pathWorld) {
    return normalizeCustomServerUrl(pathWorld[1])
  }

  // Full URL with path/query → origin only via URL parser
  if (/^https?:\/\//i.test(text) || text.startsWith('//')) {
    try {
      const u = new URL(text.startsWith('//') ? `https:${text}` : text)
      return normalizeCustomServerUrl(`${u.protocol}//${u.host}`)
    } catch {
      /* fall through */
    }
  }

  // Bare host (strip accidental path if present)
  const hostOnly = text.replace(/^\/+/, '').split(/[/?#]/)[0] ?? text
  return normalizeCustomServerUrl(hostOnly)
}

/**
 * Parse a free-form realm reference into custom server + world name.
 * Preferred query form: `?realm=worlds.example.com&worldName=MyWorld.dcl.eth`
 * Also accepts Explorer composite `host/world/Name` in a single string.
 */
export function parseRealmParam(raw: string, worldNameHint?: string | null): {
  customServer: string
  worldName: string
} | null {
  let text = raw.trim()
  if (!text) return null

  // Nested jump URL: extract ?realm= and ?worldName=
  try {
    const asUrl =
      /^https?:\/\//i.test(text) || text.startsWith('//')
        ? new URL(text.startsWith('//') ? `https:${text}` : text)
        : null
    if (asUrl) {
      const nestedRealm = asUrl.searchParams.get('realm')?.trim()
      const nestedWorld =
        asUrl.searchParams.get('worldName')?.trim() ||
        asUrl.searchParams.get('world')?.trim() ||
        worldNameHint?.trim() ||
        ''
      if (nestedRealm) {
        // Composite realm=host/world/Name
        const composite = parseRealmParam(nestedRealm, nestedWorld || undefined)
        if (composite) return composite
        const host = parseRealmHost(nestedRealm)
        if (host && nestedWorld) return { customServer: host, worldName: nestedWorld }
      }
      // Path form on the URL itself
      const pathHit = parseCustomServerWorldRef(text)
      if (pathHit) return pathHit
    }
  } catch {
    /* not a full URL */
  }

  try {
    if (/%[0-9a-f]{2}/i.test(text)) text = decodeURIComponent(text)
  } catch {
    /* keep raw */
  }

  // Composite host/world/Name (Explorer jump paste)
  const m = /^(?:https?:\/\/)?([^/?#\s]+)\/worlds?\/([^/?#\s]+)\/?$/i.exec(text)
  if (m) {
    const server = normalizeCustomServerUrl(m[1])
    let worldName = m[2]!
    try {
      worldName = decodeURIComponent(worldName)
    } catch {
      /* keep */
    }
    if (server && worldName) return { customServer: server, worldName }
  }

  // Host-only + separate worldName
  const host = parseRealmHost(text)
  const world = worldNameHint?.trim() || ''
  if (host && world) return { customServer: host, worldName: world }

  return parseCustomServerWorldRef(text)
}

/** Serialize server origin for `?realm=` — domain only, no `/world/` path. */
export function formatRealmParam(customServer: string, _worldName?: string): string | null {
  const base = normalizeCustomServerUrl(customServer)
  if (!base) return null
  return base.replace(/^https?:\/\//i, '').replace(/\/+$/, '')
}

/**
 * Parse a free-form travel string into custom server + world name when possible.
 * Accepts:
 * - `?realm=host&worldName=name` (preferred)
 * - Explorer composite `host/world/name`
 * - `https://host/world/my.dcl.eth`
 * - legacy `customServer=…&worldName=…`
 */
export function parseCustomServerWorldRef(raw: string): {
  customServer: string
  worldName: string
} | null {
  const text = raw.trim()
  if (!text) return null

  // Query-only: realm=…&worldName=… or customServer=…&worldName=…
  if (
    !/^https?:\/\//i.test(text) &&
    (/(?:^|[?&])realm=/i.test(text) || /customServer=/i.test(text) || /worldName=/i.test(text))
  ) {
    const qs = new URLSearchParams(text.includes('?') ? text.split('?').pop()! : text)
    const world =
      qs.get('worldName')?.trim() ||
      qs.get('world')?.trim() ||
      qs.get('name')?.trim() ||
      ''
    const realm = qs.get('realm')?.trim()
    if (realm) {
      const fromRealm = parseRealmParam(realm, world || undefined)
      if (fromRealm) return fromRealm
    }
    const server = normalizeCustomServerUrl(
      qs.get('customServer') ?? qs.get('server') ?? qs.get('worldServer')
    )
    if (server && world) return { customServer: server, worldName: world }
  }

  // Scheme-less host/world/Name (already handled by parseRealmParam; avoid recursion)
  const hostWorld = /^(?:https?:\/\/)?([^/?#\s]+)\/worlds?\/([^/?#\s]+)\/?$/i.exec(text)
  if (hostWorld && !/^https?:\/\//i.test(text)) {
    const server = normalizeCustomServerUrl(hostWorld[1])
    let worldName = hostWorld[2]!
    try {
      worldName = decodeURIComponent(worldName)
    } catch {
      /* keep */
    }
    if (server && worldName) return { customServer: server, worldName }
  }

  if (!/^https?:\/\//i.test(text)) return null

  let url: URL
  try {
    url = new URL(text)
  } catch {
    return null
  }

  const realmQ = url.searchParams.get('realm')?.trim()
  const worldQ =
    url.searchParams.get('worldName')?.trim() ||
    url.searchParams.get('world')?.trim() ||
    url.searchParams.get('name')?.trim() ||
    ''
  if (realmQ) {
    const fromRealm = parseRealmParam(realmQ, worldQ || undefined)
    if (fromRealm) return fromRealm
  }

  const serverFromQuery = normalizeCustomServerUrl(
    url.searchParams.get('customServer') ??
      url.searchParams.get('server') ??
      url.searchParams.get('worldServer')
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
