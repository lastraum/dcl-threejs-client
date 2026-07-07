/**
 * Reserved single-segment paths — not scene/world routes.
 * Keep in sync with dcl-companion `ROOT_SCENE_SEGMENT_DENY` / SPA fallback.
 */
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
  | { kind: 'editor' }
  | { kind: 'world'; worldName: string; segment: string }
  | { kind: 'coords'; x: number; y: number; segment: string }

const EVENTS_ROUTE_SEGMENT = 'events'
const COMMUNITIES_ROUTE_SEGMENT = 'communities'
const MAP_ROUTE_SEGMENT = 'map'
const PROFILE_ROUTE_SEGMENT = 'profile'

const APP_ROUTE_SEGMENTS = new Set([
  EVENTS_ROUTE_SEGMENT,
  COMMUNITIES_ROUTE_SEGMENT,
  MAP_ROUTE_SEGMENT,
  PROFILE_ROUTE_SEGMENT
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
 */
export function parseRouteTarget(segment: string | null): RouteTarget {
  if (!segment) return { kind: 'blank' }

  if (segment.toLowerCase() === EDITOR_ROUTE_SEGMENT) return { kind: 'editor' }
  if (segment.toLowerCase() === EVENTS_ROUTE_SEGMENT) return { kind: 'events' }
  if (segment.toLowerCase() === COMMUNITIES_ROUTE_SEGMENT) return { kind: 'communities' }
  if (segment.toLowerCase() === MAP_ROUTE_SEGMENT) return { kind: 'map' }
  if (segment.toLowerCase() === PROFILE_ROUTE_SEGMENT) return { kind: 'profile' }

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

/** Path route wins; `?world=` is legacy fallback; `/` is Explorer (no scene segment). */
export function resolveRouteTarget(): RouteTarget {
  const fromPath = parseRouteTarget(readRouteSegmentFromPath())
  if (fromPath.kind !== 'blank') return fromPath

  const fromQuery = new URLSearchParams(window.location.search).get('world')?.trim()
  if (fromQuery) return parseRouteTarget(fromQuery)

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
  if (target.kind === 'editor') return '/editor'
  if (target.kind === 'coords') return `/${encodeURIComponent(`${target.x},${target.y}`)}`
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
    a.kind === 'profile'
  ) {
    return true
  }
  if (a.kind === 'coords' && b.kind === 'coords') return a.x === b.x && a.y === b.y
  if (a.kind === 'world' && b.kind === 'world') return a.worldName.toLowerCase() === b.worldName.toLowerCase()
  return false
}

/** Chat `/goto` — parcel coords, world name, or bare name → `.dcl.eth`. */
export function parseGotoCommand(text: string): RouteTarget | null {
  const match = /^\/goto\s+(.+)$/i.exec(text.trim())
  if (!match?.[1]) return null
  const target = parseRouteTarget(match[1].trim())
  return target.kind === 'blank' ? null : target
}

export function applyRouteToHistory(target: RouteTarget, replace = false): void {
  const url = new URL(window.location.href)
  url.pathname = routePathForTarget(target)
  url.searchParams.delete('world')
  const state = { route: target }
  if (replace) history.replaceState(state, '', url)
  else history.pushState(state, '', url)
}
