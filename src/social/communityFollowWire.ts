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

/**
 * Tour flag image payload — compressed data URL (`data:image/…;base64,…`).
 * Keep small (see prepareFollowFlagImage) for LiveKit reliable data limits.
 */
export type FollowFlagPayload = string

/**
 * Leader freecam snapshot for Tour Focus — followers reconstruct the same POV
 * from the leader remote-avatar feet + these params (incl FOV).
 */
export type FollowCamState = {
  /** First-person (true) vs third-person boom. */
  fp: boolean
  /** Orbit / look yaw (radians, Three freecam). */
  yaw: number
  /** Orbit elevation or FPV pitch (radians). */
  pitch: number
  /** Boom distance (0 ≈ FPV). */
  dist: number
  /** Perspective FOV degrees. */
  fov: number
}

export type FollowWireMsg =
  | {
      t: 'start'
      s: string
      l: string
      at: number
      target?: FollowTarget
      flag?: FollowFlagPayload
      /** Tour Focus active when tour starts (rare; usually toggled later). */
      focus?: boolean
    }
  | { t: 'stop'; s: string; l: string; at: number }
  | { t: 'goto'; s: string; l: string; at: number; target: FollowTarget }
  /** Heartbeat so late joiners learn an active tour + current stop (+ flag / focus). */
  | {
      t: 'hb'
      s: string
      l: string
      at: number
      target?: FollowTarget
      flag?: FollowFlagPayload
      focus?: boolean
    }
  /** Leader set / clear tour flag image (pole + banner on spine). */
  | { t: 'flag'; s: string; l: string; at: number; flag: FollowFlagPayload | null }
  /**
   * Follower joined the tour. `l` is the **follower** wallet (not the leader).
   * Leader tracks roster for Tour Options user list.
   */
  | { t: 'join'; s: string; l: string; at: number }
  /** Follower left the tour. `l` is the follower wallet. */
  | { t: 'leave'; s: string; l: string; at: number }
  /** Leader toggles Tour Focus — take over follower cameras. */
  | { t: 'focus'; s: string; l: string; at: number; on: boolean }
  /**
   * Leader freecam stream while Focus is on (~10 Hz).
   * `l` is the leader wallet.
   */
  | {
      t: 'cam'
      s: string
      l: string
      at: number
      fp: boolean
      yaw: number
      pitch: number
      dist: number
      fov: number
    }

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

function parseFollowFlag(raw: unknown): FollowFlagPayload | null | undefined {
  if (raw === null) return null
  if (typeof raw !== 'string') return undefined
  const v = raw.trim()
  if (!v) return null
  // data URL or bare base64 — cap to avoid runaway packets
  if (v.length > 80_000) return undefined
  if (v.startsWith('data:image/')) return v
  // bare base64 → assume jpeg
  if (/^[A-Za-z0-9+/=\s]+$/.test(v) && v.length > 32) {
    return `data:image/jpeg;base64,${v.replace(/\s+/g, '')}`
  }
  return undefined
}

function parseFocusFlag(raw: unknown): boolean | undefined {
  if (typeof raw === 'boolean') return raw
  if (raw === 1 || raw === '1' || raw === 'true') return true
  if (raw === 0 || raw === '0' || raw === 'false') return false
  return undefined
}

function parseCamState(o: Record<string, unknown>): FollowCamState | null {
  const yaw = Number(o.yaw)
  const pitch = Number(o.pitch)
  const dist = Number(o.dist)
  const fov = Number(o.fov)
  if (![yaw, pitch, dist, fov].every((n) => Number.isFinite(n))) return null
  const fpRaw = o.fp
  const fp =
    fpRaw === true ||
    fpRaw === 1 ||
    fpRaw === '1' ||
    fpRaw === 'true' ||
    (typeof dist === 'number' && dist <= 0.35 && fpRaw !== false && fpRaw !== 0)
  return {
    fp: Boolean(fp),
    yaw,
    pitch,
    dist: Math.max(0, dist),
    fov: Math.max(20, Math.min(140, fov))
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
    const flag = parseFollowFlag(o.flag)
    const focus = parseFocusFlag(o.focus)
    const base = target ? { t: 'start' as const, s, l, at, target } : { t: 'start' as const, s, l, at }
    const withFlag =
      flag !== undefined && flag !== null ? { ...base, flag } : base
    return focus !== undefined ? { ...withFlag, focus } : withFlag
  }
  if (t === 'stop') return { t: 'stop', s, l, at }
  if (t === 'goto') {
    const target = parseFollowTarget(o.target)
    if (!target) return null
    return { t: 'goto', s, l, at, target }
  }
  if (t === 'hb') {
    const target = parseFollowTarget(o.target)
    const flag = parseFollowFlag(o.flag)
    const focus = parseFocusFlag(o.focus)
    const base = target ? { t: 'hb' as const, s, l, at, target } : { t: 'hb' as const, s, l, at }
    const withFlag =
      flag !== undefined && flag !== null ? { ...base, flag } : base
    return focus !== undefined ? { ...withFlag, focus } : withFlag
  }
  if (t === 'flag') {
    const flag = parseFollowFlag(o.flag)
    // Explicit null clears; missing/invalid drops the message.
    if (flag === undefined) return null
    return { t: 'flag', s, l, at, flag }
  }
  if (t === 'join') return { t: 'join', s, l, at }
  if (t === 'leave') return { t: 'leave', s, l, at }
  if (t === 'focus') {
    const on = parseFocusFlag(o.on)
    if (on === undefined) return null
    return { t: 'focus', s, l, at, on }
  }
  if (t === 'cam') {
    const cam = parseCamState(o)
    if (!cam) return null
    return {
      t: 'cam',
      s,
      l,
      at,
      fp: cam.fp,
      yaw: cam.yaw,
      pitch: cam.pitch,
      dist: cam.dist,
      fov: cam.fov
    }
  }
  return null
}

/** Quantize freecam for wire (smaller JSON, stable equality). */
export function quantizeFollowCam(cam: FollowCamState): FollowCamState {
  return {
    fp: cam.fp,
    yaw: Math.round(cam.yaw * 1000) / 1000,
    pitch: Math.round(cam.pitch * 1000) / 1000,
    dist: Math.round(cam.dist * 100) / 100,
    fov: Math.round(cam.fov)
  }
}

export function followCamEqual(a: FollowCamState | null | undefined, b: FollowCamState | null | undefined): boolean {
  if (!a || !b) return a === b
  return (
    a.fp === b.fp &&
    a.yaw === b.yaw &&
    a.pitch === b.pitch &&
    a.dist === b.dist &&
    a.fov === b.fov
  )
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
