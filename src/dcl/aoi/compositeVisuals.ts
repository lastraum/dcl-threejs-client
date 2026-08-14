import * as THREE from 'three'
import type { AssetCache } from '../../rendering/AssetCache'
import { dclToThreePos } from '../../bridge/dclTransform'
import { parseParcelKey } from '../content/parseParcel'
import { PARCEL_SIZE } from '../content/types'
import { catalystContentAssetUrl } from '../../network/catalyst/CatalystClient'

type Vec3 = { x?: number; y?: number; z?: number }
type Quat = { x?: number; y?: number; z?: number; w?: number }

function unwrap(value: unknown): unknown {
  if (value && typeof value === 'object' && 'json' in (value as object)) {
    const j = (value as { json: unknown }).json
    return unwrap(j)
  }
  return value
}

function num(v: unknown, fallback = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

function parentIdOf(parent: unknown): string | null {
  if (parent === undefined || parent === null || parent === 0 || parent === '0' || parent === '') {
    return null
  }
  const id = String(parent)
  return id.length ? id : null
}

function readTransform(raw: unknown): {
  position: { x: number; y: number; z: number }
  rotation: { x: number; y: number; z: number; w: number }
  scale: { x: number; y: number; z: number }
  parentId: string | null
} {
  const tf = (unwrap(raw) ?? {}) as {
    position?: Vec3
    rotation?: Quat
    scale?: Vec3
    parent?: unknown
  }
  const p = tf.position ?? {}
  const r = tf.rotation ?? {}
  const s = tf.scale ?? {}
  return {
    position: { x: num(p.x), y: num(p.y), z: num(p.z) },
    rotation: {
      x: num(r.x),
      y: num(r.y),
      z: num(r.z),
      w: r.w === undefined ? 1 : num(r.w, 1)
    },
    scale: {
      x: s.x === undefined ? 1 : num(s.x, 1),
      y: s.y === undefined ? 1 : num(s.y, 1),
      z: s.z === undefined ? 1 : num(s.z, 1)
    },
    parentId: parentIdOf(tf.parent)
  }
}

function componentDataByName(compositeJson: unknown): Map<string, Record<string, unknown>> {
  const root = unwrap(compositeJson)
  const byName = new Map<string, Record<string, unknown>>()
  if (!root || typeof root !== 'object') return byName
  const components = (root as { components?: unknown }).components
  if (!Array.isArray(components)) return byName
  for (const c of components) {
    if (!c || typeof c !== 'object') continue
    const name = (c as { name?: string }).name
    const data = (c as { data?: unknown }).data
    if (typeof name === 'string' && data && typeof data === 'object') {
      byName.set(name, data as Record<string, unknown>)
    }
  }
  return byName
}

export type CompositeTransform = {
  entityId: string
  parentId: string | null
  position: { x: number; y: number; z: number }
  rotation: { x: number; y: number; z: number; w: number }
  scale: { x: number; y: number; z: number }
}

/** Neighbor-local Gltf placement (composite parse; local TRS + parent). */
export type CompositeGltfPlacement = CompositeTransform & {
  src: string
}

/** @deprecated Use CompositeGltfPlacement. */
export type GltfPlacement = CompositeGltfPlacement

/** Height-weighted silhouette: largest axis scale × max(1, |py|). */
export function compositeSilhouetteKey(
  scale: { x: number; y: number; z: number },
  positionY: number
): number {
  return (
    Math.max(Math.abs(scale.x), Math.abs(scale.y), Math.abs(scale.z)) * Math.max(1, Math.abs(positionY))
  )
}

/** Every Transform entity (pivots included) — parent-walk, no skip. */
export function extractCompositeTransforms(compositeJson: unknown): CompositeTransform[] {
  const transformData = componentDataByName(compositeJson).get('core::Transform')
  if (!transformData) return []
  const out: CompositeTransform[] = []
  for (const [entKey, rawTf] of Object.entries(transformData)) {
    const entityId = String(entKey)
    if (!entityId) continue
    const tf = readTransform(rawTf)
    out.push({
      entityId,
      parentId: tf.parentId === entityId ? null : tf.parentId,
      position: tf.position,
      rotation: tf.rotation,
      scale: tf.scale
    })
  }
  return out
}

/**
 * Parse Creator Hub / main.composite for GltfContainer + Transform.
 * Includes nested entities (`parent`); does not flatten or skip the tree.
 */
export function extractCompositeGltfPlacements(
  compositeJson: unknown,
  opts?: { skipGroundGlbs?: boolean }
): CompositeGltfPlacement[] {
  const byName = componentDataByName(compositeJson)
  const gltfData = byName.get('core::GltfContainer')
  const transformData = byName.get('core::Transform')
  if (!gltfData) return []

  const skipGround = opts?.skipGroundGlbs === true
  const out: CompositeGltfPlacement[] = []
  for (const [entKey, rawGltf] of Object.entries(gltfData)) {
    const gltf = unwrap(rawGltf) as { src?: string } | null
    const src = typeof gltf?.src === 'string' ? gltf.src.trim() : ''
    if (!src) continue
    if (skipGround && isAoiSecondaryGroundSrc(src)) continue

    const entityId = String(entKey)
    const tf = readTransform(transformData?.[entKey])
    out.push({
      src,
      entityId,
      parentId: tf.parentId === entityId ? null : tf.parentId,
      position: tf.position,
      rotation: tf.rotation,
      scale: tf.scale
    })
  }
  return out
}

export function planCompositeShell(
  json: unknown,
  opts?: { maxGltfs?: number; skipGroundGlbs?: boolean }
): { placements: CompositeGltfPlacement[] } {
  const placements = extractCompositeGltfPlacements(json, {
    skipGroundGlbs: opts?.skipGroundGlbs
  })
  placements.sort(
    (a, b) =>
      compositeSilhouetteKey(b.scale, b.position.y) - compositeSilhouetteKey(a.scale, a.position.y)
  )
  const cap = opts?.maxGltfs
  if (cap === undefined) return { placements }
  if (cap <= 0) return { placements: [] }
  return { placements: placements.slice(0, cap) }
}

export async function fetchCompositeJson(
  contentBaseUrl: string,
  compositeHash: string
): Promise<unknown | null> {
  try {
    const url = catalystContentAssetUrl(contentBaseUrl, compositeHash)
    const res = await fetch(url)
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}

/**
 * Ground / floor GLBs that may be skipped under AOI secondary footprints when
 * the scene opts in (blank empty-land tiles already cover the parcel).
 *
 * Never matches Creator Hub default `scene.glb` — that is authored content.
 * Callers must only skip when scene.json explicitly allows (see
 * {@link shouldSkipAoiSecondaryGroundGlbs}).
 */
export function isAoiSecondaryGroundSrc(src: string): boolean {
  const base = (src.split('/').pop() ?? src).trim().toLowerCase()
  const file = base.replace(/\.(glb|gltf)$/i, '')
  if (!file) return false
  // Never strip the Creator Hub default scene model.
  if (file === 'scene') return false
  // Exact empty-land / builder floor packs only (not props named *playground* etc.)
  if (
    file === 'floor' ||
    file === 'floors' ||
    file === 'ground' ||
    file === 'groundtile' ||
    file === 'ground_tile' ||
    file === 'groundplane' ||
    file === 'ground_plane' ||
    file === 'floorbase' ||
    file === 'floor_base' ||
    file === 'base_floor' ||
    file === 'basefloor' ||
    file === 'empty' ||
    file === 'empty_parcel' ||
    file === 'emptyparcel'
  ) {
    return true
  }
  if (
    file.startsWith('floorbase') ||
    file.startsWith('floor_base') ||
    file.startsWith('floor_tile') ||
    file.startsWith('floortile') ||
    file.includes('floorbase') ||
    file.includes('empty_parcel') ||
    file.includes('emptyland') ||
    file.includes('empty_land')
  ) {
    return true
  }
  if (/^(floor|ground)([_\-.]|$)/i.test(file)) return true
  if (/[_\-.](floor|ground)([_\-.]|$)/i.test(file) && !/play|under|above|roof/i.test(file)) {
    return true
  }
  return false
}

/**
 * Opt-in: only strip empty floor GLBs from AOI secondaries when scene.json asks.
 * Default is keep all GLBs (including default scene.glb / floors).
 *
 * scene.json:
 *   "featureToggles": { "aoiSkipGroundGlbs": "enabled" }
 *   // or top-level
 *   "aoiSkipGroundGlbs": true
 */
export function shouldSkipAoiSecondaryGroundGlbs(metadata?: {
  featureToggles?: Record<string, unknown>
  aoiSkipGroundGlbs?: unknown
} | null): boolean {
  if (!metadata) return false
  const top = metadata.aoiSkipGroundGlbs
  if (top === true || top === 'enabled' || top === 'true') return true
  if (top === false || top === 'disabled' || top === 'false') return false
  const toggle = metadata.featureToggles?.aoiSkipGroundGlbs
  if (typeof toggle === 'string') {
    const t = toggle.trim().toLowerCase()
    if (t === 'enabled' || t === 'true' || t === '1') return true
    if (t === 'disabled' || t === 'false' || t === '0') return false
  }
  if (toggle === true) return true
  return false
}

export function resolveContentUrl(
  src: string,
  content: { file: string; hash: string }[],
  contentBaseUrl: string
): { url: string; hash: string } | null {
  const trimmed = src.trim()
  if (/^https?:\/\//i.test(trimmed)) return { url: trimmed, hash: trimmed }
  if (/^(bafy|bafkre|Qm)/i.test(trimmed)) {
    return { url: catalystContentAssetUrl(contentBaseUrl, trimmed), hash: trimmed }
  }
  const hit =
    content.find((c) => c.file === trimmed) ??
    content.find((c) => c.file.endsWith(`/${trimmed}`)) ??
    content.find((c) => c.file.endsWith(trimmed))
  if (!hit) return null
  return { url: catalystContentAssetUrl(contentBaseUrl, hit.hash), hash: hit.hash }
}

/** DCL meters: neighbor SW − primary SW (scene-local of primary). */
export function neighborOriginOffset(
  neighborBase: string,
  primaryBase: string
): { x: number; z: number } {
  const nBase = parseParcelKey(neighborBase)
  const pBase = parseParcelKey(primaryBase)
  return {
    x: (nBase.x - pBase.x) * PARCEL_SIZE,
    z: (nBase.y - pBase.y) * PARCEL_SIZE
  }
}

/**
 * Fetch-only wrapper. Clone attach lives in the AOI drain (1/`cache.load` per turn).
 * Unused on the hot path — kept for callers that only need the JSON group stub.
 */
export async function buildCompositeVisualGroup(opts: {
  cache: AssetCache
  contentBaseUrl: string
  content: { file: string; hash: string }[]
  compositeHash: string
  neighborBase: string
  primaryBase: string
  maxGltfs?: number
}): Promise<THREE.Group> {
  const group = new THREE.Group()
  group.name = 'aoi-composite-visuals'
  const json = await fetchCompositeJson(opts.contentBaseUrl, opts.compositeHash)
  if (!json) return group
  const planned = planCompositeShell(json, { maxGltfs: opts.maxGltfs })
  group.userData.pendingSrcs = planned.placements.map((p) => p.src)
  const originOffset = neighborOriginOffset(opts.neighborBase, opts.primaryBase)
  dclToThreePos(originOffset.x, 0, originOffset.z, group.position)
  return group
}
