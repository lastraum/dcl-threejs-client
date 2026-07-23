/**
 * Community Follow / Tour control plane.
 *
 * Preferred transport: private-messages LiveKit room, **non-chat** data on topic
 * `d3js-follow:{communityId}` (room broadcast). Explorer does not treat this as
 * community chat (SFU only routes RFC4 chat/chatReaction on `community:{id}`).
 *
 * Legacy: DLE / `::d3js-follow::` RFC4 chat text still parsed if received.
 */

import type { RouteTarget } from '../dcl/content/route'

/** LiveKit data topic for follow control (PM room, not community SFU). */
export const COMMUNITY_FOLLOW_TOPIC_PREFIX = 'd3js-follow:'

/** Binary payload magic: ASCII "D3F1" */
export const COMMUNITY_FOLLOW_DATA_MAGIC = new Uint8Array([0x44, 0x33, 0x46, 0x31])

/** Legacy RFC4 chat prefixes (still accepted on receive). */
export const COMMUNITY_FOLLOW_PREFIX = '\x10d3js-follow:'
export const COMMUNITY_FOLLOW_PREFIX_LEGACY = '::d3js-follow::'

export function communityFollowTopic(communityId: string): string {
  return `${COMMUNITY_FOLLOW_TOPIC_PREFIX}${communityId.trim().toLowerCase()}`
}

export function parseCommunityFollowTopic(topic: string | undefined | null): string | null {
  const t = topic?.trim() ?? ''
  if (!t.toLowerCase().startsWith(COMMUNITY_FOLLOW_TOPIC_PREFIX)) return null
  const id = t.slice(COMMUNITY_FOLLOW_TOPIC_PREFIX.length).trim().toLowerCase()
  return id || null
}

/** Encode follow control as raw LiveKit data (not RFC4 Chat). */
export function encodeFollowDataPacket(msg: FollowWireMsg): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify(msg))
  const out = new Uint8Array(COMMUNITY_FOLLOW_DATA_MAGIC.length + json.length)
  out.set(COMMUNITY_FOLLOW_DATA_MAGIC, 0)
  out.set(json, COMMUNITY_FOLLOW_DATA_MAGIC.length)
  return out
}

export function tryParseFollowDataPacket(data: Uint8Array): FollowWireMsg | null {
  if (data.length < COMMUNITY_FOLLOW_DATA_MAGIC.length + 2) return null
  for (let i = 0; i < COMMUNITY_FOLLOW_DATA_MAGIC.length; i++) {
    if (data[i] !== COMMUNITY_FOLLOW_DATA_MAGIC[i]) return null
  }
  try {
    const json = new TextDecoder().decode(data.subarray(COMMUNITY_FOLLOW_DATA_MAGIC.length))
    return parseFollowWireObject(JSON.parse(json) as Record<string, unknown>)
  } catch {
    return null
  }
}

/** Destinations allowed for tours (v1). */
export type FollowTarget =
  | { kind: 'coords'; x: number; y: number }
  | { kind: 'world'; worldName: string }

export type FollowWireMsg =
  | { t: 'start'; s: string; l: string; at: number; target?: FollowTarget }
  | { t: 'stop'; s: string; l: string; at: number }
  | { t: 'goto'; s: string; l: string; at: number; target: FollowTarget }
  /** Heartbeat so late joiners learn an active tour + current stop. */
  | { t: 'hb'; s: string; l: string; at: number; target?: FollowTarget }

export function isCommunityFollowWireText(text: string): boolean {
  const raw = text.trimStart()
  return (
    raw.startsWith(COMMUNITY_FOLLOW_PREFIX) ||
    raw.startsWith(COMMUNITY_FOLLOW_PREFIX_LEGACY) ||
    // DLE may be stored/rendered as control picture U+2410
    raw.startsWith('\u2410d3js-follow:')
  )
}

export function encodeFollowWire(msg: FollowWireMsg): string {
  return `${COMMUNITY_FOLLOW_PREFIX}${JSON.stringify(msg)}`
}

export function tryParseFollowWire(text: string): FollowWireMsg | null {
  const raw = text.trim()
  let json: string | null = null
  if (raw.startsWith(COMMUNITY_FOLLOW_PREFIX)) {
    json = raw.slice(COMMUNITY_FOLLOW_PREFIX.length).trim()
  } else if (raw.startsWith(COMMUNITY_FOLLOW_PREFIX_LEGACY)) {
    json = raw.slice(COMMUNITY_FOLLOW_PREFIX_LEGACY.length).trim()
  } else if (raw.startsWith('\u2410d3js-follow:')) {
    json = raw.slice('\u2410d3js-follow:'.length).trim()
  }
  if (!json) return null
  try {
    return parseFollowWireObject(JSON.parse(json) as Record<string, unknown>)
  } catch {
    return null
  }
}

function parseFollowWireObject(o: Record<string, unknown>): FollowWireMsg | null {
  if (!o || typeof o !== 'object') return null
  const t = o.t
  const s = typeof o.s === 'string' ? o.s.trim() : ''
  const l = typeof o.l === 'string' ? o.l.trim().toLowerCase() : ''
  const at = typeof o.at === 'number' && Number.isFinite(o.at) ? o.at : Date.now()
  if (!s || !l || !ADDR_RE.test(l)) return null

  if (t === 'start') {
    const target = parseFollowTarget(o.target)
    return target ? { t: 'start', s, l, at, target } : { t: 'start', s, l, at }
  }
  if (t === 'stop') return { t: 'stop', s, l, at }
  if (t === 'goto') {
    const target = parseFollowTarget(o.target)
    if (!target) return null
    return { t: 'goto', s, l, at, target }
  }
  if (t === 'hb') {
    const target = parseFollowTarget(o.target)
    return target ? { t: 'hb', s, l, at, target } : { t: 'hb', s, l, at }
  }
  return null
}

const ADDR_RE = /^0x[a-f0-9]{40}$/

function parseFollowTarget(raw: unknown): FollowTarget | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  if (o.kind === 'coords') {
    const x = Number(o.x)
    const y = Number(o.y)
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null
    return { kind: 'coords', x: Math.round(x), y: Math.round(y) }
  }
  if (o.kind === 'world') {
    const worldName = typeof o.worldName === 'string' ? o.worldName.trim() : ''
    if (!worldName) return null
    return { kind: 'world', worldName }
  }
  return null
}

export function routeToFollowTarget(route: RouteTarget | null | undefined): FollowTarget | null {
  if (!route) return null
  if (route.kind === 'coords') return { kind: 'coords', x: route.x, y: route.y }
  if (route.kind === 'world') return { kind: 'world', worldName: route.worldName.trim() }
  return null
}

export function followTargetToRoute(target: FollowTarget): Extract<RouteTarget, { kind: 'coords' } | { kind: 'world' }> {
  if (target.kind === 'coords') {
    return {
      kind: 'coords',
      x: target.x,
      y: target.y,
      segment: `${target.x},${target.y}`
    }
  }
  const worldName = target.worldName.trim()
  return {
    kind: 'world',
    worldName,
    segment: worldName
  }
}

export function followTargetLabel(target: FollowTarget | null | undefined): string {
  if (!target) return ''
  if (target.kind === 'coords') return `${target.x},${target.y}`
  return target.worldName
}

export function followTargetsEqual(a: FollowTarget | null | undefined, b: FollowTarget | null | undefined): boolean {
  if (!a || !b) return a === b
  if (a.kind !== b.kind) return false
  if (a.kind === 'coords' && b.kind === 'coords') return a.x === b.x && a.y === b.y
  if (a.kind === 'world' && b.kind === 'world') {
    return a.worldName.trim().toLowerCase() === b.worldName.trim().toLowerCase()
  }
  return false
}

export function newFollowSessionId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}
