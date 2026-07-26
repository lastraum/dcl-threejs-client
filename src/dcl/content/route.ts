/**
 * Reserved single-segment paths — not scene/world routes.
 * Keep in sync with dcl-companion `ROOT_SCENE_SEGMENT_DENY` / SPA fallback.
 */
import { addCustomWorldFavorite } from '../../network/worlds/customWorldFavorites'
import {
  formatRealmParam,
  normalizeCustomServerUrl,
  parseCustomServerWorldRef,
  parseRealmParam
} from '../../network/worlds/worldsServerConfig'

const ROUTE_SEGMENT_DENY = new Set(
  [
    'assets',
    'admin',
    'api',
    'backpack',
    'community',
    'events',
    'communities',
    'map',
    'profile',
    'gacha',
    'chat',
    'favicon.ico',
    'robots.txt',
    'sitemap.xml',
    'index.html'
  ].map((s) => s.toLowerCase())
)

const ROUTE_STATIC_ASSET_RE =
  /\.(?:ico|png|apng|jpe?g|gif|webp|avif|svg|css|js|mjs|cjs|map|json|txt|xml|wasm|woff2?|ttf|otf|html|htm)$/i

export type RouteTarget =
  | { kind: 'blank' }
  | { kind: 'map' }
  | { kind: 'events' }
  | { kind: 'communities' }
  | { kind: 'profile' }
  | { kind: 'gacha' }
  | { kind: 'editor' }
  | {
      kind: 'world'
      worldName: string
      segment: string
      /**
       * Custom worlds content server origin (`https://host`).
       * Omit / undefined = official / env default.
       * Deep link:
       *   `?realm=worlds.example.com&worldName=MyWorld.dcl.eth`
       */
      customServer?: string
    }
  | { kind: 'coords'; x: number; y: number; segment: string }

const EVENTS_ROUTE_SEGMENT = 'events'
const COMMUNITIES_ROUTE_SEGMENT = 'communities'
const MAP_ROUTE_SEGMENT = 'map'
const PROFILE_ROUTE_SEGMENT = 'profile'
const GACHA_ROUTE_SEGMENT = 'gacha'

const APP_ROUTE_SEGMENTS = new Set([
  EVENTS_ROUTE_SEGMENT,
  COMMUNITIES_ROUTE_SEGMENT,
  MAP_ROUTE_SEGMENT,
  PROFILE_ROUTE_SEGMENT,
  GACHA_ROUTE_SEGMENT
])

const EDITOR_ROUTE_SEGMENT = 'editor'

/** Default parcel when visiting `/` with no route segment (Genesis Plaza). */
export const DEFAULT_PARCEL_ROUTE: Extract<RouteTarget, { kind: 'coords' }> = {
  kind: 'coords',
  x: 0,
  y: 0,
  segment: '0,0'
}

export function readRouteSegmentFromPath(pathname = window.location.pathname): string | null {
  const path = pathname.replace(/\/$/, '') || '/'
  if (path === '/') return null

  const match = path.match(/^\/([^/]+)$/)
  if (!match?.[1]) return null

  let segment: string
  try {
    segment = decodeURIComponent(match[1])
  } catch {
    segment = match[1]
  }

  if (APP_ROUTE_SEGMENTS.has(segment.toLowerCase())) return segment
  if (ROUTE_SEGMENT_DENY.has(segment.toLowerCase())) return null
  if (ROUTE_STATIC_ASSET_RE.test(segment) && !/^-?\d+\s*,\s*-?\d+$/.test(segment)) return null

  return segment.trim()
}

/**
 * Parse `/:segment` as parcel coords (`80,-1`) or ENS world (`name.dcl.eth`).
 * Bare names (`rickroll`) normalize to `rickroll.dcl.eth`.
 * Does not read `?realm=` — use {@link resolveRouteTarget} for full URL.
 */
export function parseRouteTarget(segment: string | null): RouteTarget {
  if (!segment) return { kind: 'blank' }

  if (segment.toLowerCase() === EDITOR_ROUTE_SEGMENT) return { kind: 'editor' }
  if (segment.toLowerCase() === EVENTS_ROUTE_SEGMENT) return { kind: 'events' }
  if (segment.toLowerCase() === COMMUNITIES_ROUTE_SEGMENT) return { kind: 'communities' }
  if (segment.toLowerCase() === MAP_ROUTE_SEGMENT) return { kind: 'map' }
  if (segment.toLowerCase() === PROFILE_ROUTE_SEGMENT) return { kind: 'profile' }
  if (segment.toLowerCase() === GACHA_ROUTE_SEGMENT) return { kind: 'gacha' }

  const coordMatch = /^(-?\d+)\s*,\s*(-?\d+)$/.exec(segment)
  if (coordMatch) {
    const x = Number(coordMatch[1])
    const y = Number(coordMatch[2])
    if (Number.isFinite(x) && Number.isFinite(y)) {
      return { kind: 'coords', x, y, segment }
    }
  }

  if (/^[a-zA-Z0-9._-]+$/.test(segment)) {
    const worldName = segment.includes('.') ? segment : `${segment}.dcl.eth`
    return { kind: 'world', worldName, segment }
  }

  return { kind: 'blank' }
}

function worldTargetFromCustom(
  customServer: string,
  worldName: string
): Extract<RouteTarget, { kind: 'world' }> {
  return {
    kind: 'world',
    worldName,
    segment: worldName,
    customServer
  }
}

/**
 * Path + query:
 * - `/?realm=worlds.dcl-iwb.co&worldName=BuilderWorld.dcl.eth` — preferred custom host
 * - `/?realm=host/world/Name` — still accepted (Explorer paste)
 * - `/?position=1,1` — parcel
 * - `/rickroll` — official worlds server
 * - legacy `?customServer=` still accepted
 */
export function resolveRouteTarget(): RouteTarget {
  const params = new URLSearchParams(window.location.search)

  const worldNameQ =
    params.get('worldName')?.trim() ||
    params.get('world')?.trim() ||
    params.get('name')?.trim() ||
    ''

  // 1) `?realm=<domain>` + `?worldName=<name>` (preferred — no /world/ typing)
  const realmRaw = params.get('realm')?.trim()
  if (realmRaw) {
    const parsed = parseRealmParam(realmRaw, worldNameQ || undefined)
    if (parsed) return worldTargetFromCustom(parsed.customServer, parsed.worldName)
  }

  // 2) Path segment (official worlds / parcels / app shells)
  const fromPath = parseRouteTarget(readRouteSegmentFromPath())
  if (fromPath.kind === 'world' && realmRaw) {
    // Path world name with realm host override
    const host = normalizeCustomServerUrl(realmRaw.split(/[/?#]/)[0] ?? realmRaw)
    if (host) return worldTargetFromCustom(host, fromPath.worldName)
  }
  if (fromPath.kind !== 'blank') return fromPath

  // 3) Explorer `?position=x,y`
  const position = params.get('position')?.trim()
  if (position) {
    const t = parseRouteTarget(position)
    if (t.kind === 'coords') return t
  }

  // 4) Legacy customServer + worldName (realm host aliases)
  const legacyServer = normalizeCustomServerUrl(
    params.get('customServer') ?? params.get('server') ?? params.get('worldServer')
  )
  if (legacyServer && worldNameQ) {
    return worldTargetFromCustom(legacyServer, worldNameQ)
  }

  // 5) worldName alone → official worlds content server
  if (worldNameQ && !realmRaw) {
    const t = parseRouteTarget(worldNameQ)
    if (t.kind !== 'blank') return t
  }

  return { kind: 'blank' }
}

export function routePathForWorld(worldName: string): string {
  return `/${encodeURIComponent(worldName.trim())}`
}

export function routePathForTarget(target: RouteTarget): string {
  if (target.kind === 'blank') return '/'
  if (target.kind === 'events') return '/events'
  if (target.kind === 'communities') return '/communities'
  if (target.kind === 'map') return '/map'
  if (target.kind === 'profile') return '/profile'
  if (target.kind === 'gacha') return '/gacha'
  if (target.kind === 'editor') return '/editor'
  if (target.kind === 'coords') return `/${encodeURIComponent(`${target.x},${target.y}`)}`
  // Custom server worlds: `/` + `?realm=host&worldName=Name`.
  if (target.customServer) return '/'
  return routePathForWorld(target.worldName)
}

/** Active local editor project id from `?project=` on `/editor`. */
export function readEditorProjectIdFromUrl(url = window.location.href): string | null {
  const params = new URLSearchParams(new URL(url).search)
  const id = params.get('project')?.trim()
  return id || null
}

export function editorUrlForProject(projectId: string | null, replace = false): void {
  const url = new URL(window.location.href)
  url.pathname = '/editor'
  if (projectId) url.searchParams.set('project', projectId)
  else url.searchParams.delete('project')
  const state = { route: { kind: 'editor' as const }, editorProjectId: projectId }
  if (replace) history.replaceState(state, '', url)
  else history.pushState(state, '', url)
}

export function routeEquals(a: RouteTarget, b: RouteTarget): boolean {
  if (a.kind !== b.kind) return false
  if (
    a.kind === 'blank' ||
    a.kind === 'editor' ||
    a.kind === 'events' ||
    a.kind === 'communities' ||
    a.kind === 'map' ||
    a.kind === 'profile' ||
    a.kind === 'gacha'
  ) {
    return true
  }
  if (a.kind === 'coords' && b.kind === 'coords') return a.x === b.x && a.y === b.y
  if (a.kind === 'world' && b.kind === 'world') {
    const serverA = (a.customServer ?? '').toLowerCase()
    const serverB = (b.customServer ?? '').toLowerCase()
    return (
      a.worldName.toLowerCase() === b.worldName.toLowerCase() && serverA === serverB
    )
  }
  return false
}

/**
 * Free-text travel target: coords, official world, `host Name`,
 * `realm=host&worldName=name`, composite `host/world/name`, full URLs.
 */
export function parseTravelTarget(raw: string): RouteTarget | null {
  const text = raw.trim()
  if (!text) return null

  // Query blob or composite host/world/Name / full URL
  const realm = parseRealmParam(text)
  if (realm) {
    return worldTargetFromCustom(realm.customServer, realm.worldName)
  }

  const custom = parseCustomServerWorldRef(text)
  if (custom) {
    return worldTargetFromCustom(custom.customServer, custom.worldName)
  }

  // Two-token: `host worldName` or `https://host worldName` (preferred chat form)
  const two = /^(\S+)\s+(\S+)$/.exec(text)
  if (two) {
    const server = normalizeCustomServerUrl(two[1])
    const name = two[2]!.trim()
    if (server && name && !/^-?\d+\s*,\s*-?\d+$/.test(name)) {
      return worldTargetFromCustom(server, name)
    }
  }

  const target = parseRouteTarget(text)
  return target.kind === 'blank' ? null : target
}

/**
 * Chat `/goto` and `/changerealm` — parcel coords, world name,
 * `host worldName`, or `realm=host&worldName=name`.
 */
export function parseGotoCommand(text: string): RouteTarget | null {
  const match = /^\/(?:goto|changerealm|change-realm|realm)\s+(.+)$/i.exec(text.trim())
  if (!match?.[1]) return null
  return parseTravelTarget(match[1])
}

export function applyRouteToHistory(target: RouteTarget, replace = false): void {
  const url = new URL(window.location.href)
  url.pathname = routePathForTarget(target)

  // Clear travel-related query keys, then re-apply for custom worlds.
  url.searchParams.delete('world')
  url.searchParams.delete('worldName')
  url.searchParams.delete('name')
  url.searchParams.delete('customServer')
  url.searchParams.delete('server')
  url.searchParams.delete('worldServer')
  url.searchParams.delete('realm')
  url.searchParams.delete('position')

  if (target.kind === 'world' && target.customServer) {
    const realmHost = formatRealmParam(target.customServer)
    if (realmHost) url.searchParams.set('realm', realmHost)
    url.searchParams.set('worldName', target.worldName)
    // Persist custom worlds for Favourites tab (merged with Places profile favourites).
    addCustomWorldFavorite({
      customServer: target.customServer,
      worldName: target.worldName
    })
  }

  const state = { route: target }
  if (replace) history.replaceState(state, '', url)
  else history.pushState(state, '', url)
}
