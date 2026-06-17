import { parseRouteTarget, type RouteTarget } from '../dcl/content/route'

/** Parcel coords in chat (`80,-1`, `-150, 2`). */
const COORD_RE = /(?<![\w.])(-?\d+)\s*,\s*(-?\d+)(?![\w.])/g

/** ENS-style world pointer in chat. */
const WORLD_DCL_ETH_RE = /\b[a-zA-Z0-9][a-zA-Z0-9._-]*\.dcl\.eth\b/gi

const HTTP_URL_RE = /\bhttps?:\/\/\S+/gi

export type ChatLinkKind = 'http' | 'nav'

export type ChatLinkMatch = {
  start: number
  end: number
  raw: string
  kind: ChatLinkKind
  target: RouteTarget | null
  href: string
}

function clipHttpUrl(raw: string): string {
  let t = raw
  while (t.length > 0 && /[.,;:!?)}\]'"\u2019\u201d]$/u.test(t)) {
    t = t.slice(0, -1)
  }
  return t.length > 0 ? t : raw
}

/** Parse Decentraland play / realm URLs into a route target. */
export function parseDecentralandPlayUrl(raw: string): RouteTarget | null {
  const url = clipHttpUrl(raw.trim())
  try {
    const u = new URL(url)
    const host = u.hostname.toLowerCase()
    if (!host.endsWith('decentraland.org') && !host.endsWith('.dcl.eth') && host !== 'dcl.eth') {
      return null
    }

    const realm = u.searchParams.get('realm')?.trim()
    if (realm) {
      const t = parseRouteTarget(realm)
      return t.kind === 'blank' ? null : t
    }

    if (host.endsWith('.dcl.eth') || host === 'dcl.eth') {
      const t = parseRouteTarget(host)
      return t.kind === 'blank' ? null : t
    }

    const seg = u.pathname
      .replace(/^\//, '')
      .split('/')
      .map((p) => p.trim())
      .filter(Boolean)[0]
    if (!seg) return null
    try {
      const t = parseRouteTarget(decodeURIComponent(seg))
      return t.kind === 'blank' ? null : t
    } catch {
      const t = parseRouteTarget(seg)
      return t.kind === 'blank' ? null : t
    }
  } catch {
    return null
  }
}

function routeTargetFromSegment(segment: string): RouteTarget | null {
  const t = parseRouteTarget(segment.trim())
  return t.kind === 'blank' ? null : t
}

const LINK_PRIORITY: Record<ChatLinkKind, number> = {
  http: 4,
  nav: 3
}

function addMatches(out: ChatLinkMatch[], text: string, re: RegExp, kind: ChatLinkKind, map: (raw: string) => RouteTarget | null): void {
  re.lastIndex = 0
  for (const m of text.matchAll(re)) {
    const raw = m[0]
    const idx = m.index ?? 0
    const clipped = kind === 'http' ? clipHttpUrl(raw) : raw
    const target = map(clipped)
    if (kind === 'nav' && !target) continue
    out.push({
      start: idx,
      end: idx + raw.length,
      raw: clipped,
      kind: target ? 'nav' : kind,
      target,
      href: kind === 'http' && !target ? clipped : '#'
    })
  }
}

/** Find clickable coords, `.dcl.eth` names, and Decentraland URLs in chat text. */
export function findChatLinks(text: string): ChatLinkMatch[] {
  const matches: ChatLinkMatch[] = []

  addMatches(matches, text, HTTP_URL_RE, 'http', (raw) => parseDecentralandPlayUrl(raw))
  addMatches(matches, text, WORLD_DCL_ETH_RE, 'nav', routeTargetFromSegment)
  addMatches(matches, text, COORD_RE, 'nav', routeTargetFromSegment)

  return mergeNonOverlapping(matches)
}

function mergeNonOverlapping(matches: ChatLinkMatch[]): ChatLinkMatch[] {
  if (!matches.length) return []
  const sorted = [...matches].sort((a, b) => {
    const lenA = a.end - a.start
    const lenB = b.end - b.start
    if (lenB !== lenA) return lenB - lenA
    if (a.start !== b.start) return a.start - b.start
    return LINK_PRIORITY[b.kind] - LINK_PRIORITY[a.kind]
  })

  const out: ChatLinkMatch[] = []
  for (const m of sorted) {
    if (out.some((o) => m.start < o.end && o.start < m.end)) continue
    out.push(m)
  }
  return out.sort((a, b) => a.start - b.start)
}
