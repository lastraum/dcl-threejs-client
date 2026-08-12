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

/**
 * Parse Creator Hub / main.composite for GltfContainer + Transform only.
 * Skips Animator, MeshCollider, PointerEvents, etc.
 */
export function extractCompositeGltfPlacements(
  compositeJson: unknown,
  opts?: { skipGroundGlbs?: boolean }
): Array<{
  src: string
  position: { x: number; y: number; z: number }
  rotation: { x: number; y: number; z: number; w: number }
  scale: { x: number; y: number; z: number }
}> {
  const root = unwrap(compositeJson)
  if (!root || typeof root !== 'object') return []
  const components = (root as { components?: unknown }).components
  if (!Array.isArray(components)) return []

  const byName = new Map<string, Record<string, unknown>>()
  for (const c of components) {
    if (!c || typeof c !== 'object') continue
    const name = (c as { name?: string }).name
    const data = (c as { data?: unknown }).data
    if (typeof name === 'string' && data && typeof data === 'object') {
      byName.set(name, data as Record<string, unknown>)
    }
  }

  const gltfData = byName.get('core::GltfContainer')
  const transformData = byName.get('core::Transform')
  if (!gltfData) return []

  const out: Array<{
    src: string
    position: { x: number; y: number; z: number }
    rotation: { x: number; y: number; z: number; w: number }
    scale: { x: number; y: number; z: number }
  }> = []

  const skipGround = opts?.skipGroundGlbs === true
  for (const [entKey, rawGltf] of Object.entries(gltfData)) {
    const gltf = unwrap(rawGltf) as { src?: string } | null
    const src = typeof gltf?.src === 'string' ? gltf.src.trim() : ''
    if (!src) continue
    // Only when scene.json opts in — never strip default scene.glb by default.
    if (skipGround && isAoiSecondaryGroundSrc(src)) continue

    const rawTf = transformData?.[entKey]
    const tf = (unwrap(rawTf) ?? {}) as {
      position?: Vec3
      rotation?: Quat
      scale?: Vec3
      parent?: number
    }
    // Only root-level (parent 0 / missing) — nested trees need full hierarchy later.
    const parent = tf.parent
    if (parent !== undefined && parent !== 0 && parent !== null) continue

    const p = tf.position ?? {}
    const r = tf.rotation ?? {}
    const s = tf.scale ?? {}
    out.push({
      src,
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
      }
    })
  }
  return out
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

/** Neighbor-local Gltf placement (from composite parse or first-frame ECS snapshot). */
export type GltfPlacement = {
  src: string
  position: { x: number; y: number; z: number }
  rotation: { x: number; y: number; z: number; w: number }
  scale: { x: number; y: number; z: number }
}

/**
 * One far proxy for a neighbor (AABB of composite placements). No GLB clones.
 *
 * Placements are neighbor scene-local DCL. The group is shifted by
 * (neighborBase − primaryBase) so it sits in the primary graph.
 */
export async function buildPlacementVisualGroup(opts: {
  cache: AssetCache
  contentBaseUrl: string
  content: { file: string; hash: string }[]
  placements: GltfPlacement[]
  neighborBase: string
  primaryBase: string
  maxGltfs?: number
  groupName?: string
  /** Only when scene.json sets aoiSkipGroundGlbs — default keep all GLBs. */
  skipGroundGlbs?: boolean
}): Promise<THREE.Group> {
  const group = new THREE.Group()
  group.name = opts.groupName ?? 'aoi-placement-visuals'

  // Neighbor root origin in primary-relative DCL → Three (X reflect once on the root).
  const originOffset = neighborOriginOffset(opts.neighborBase, opts.primaryBase)
  dclToThreePos(originOffset.x, 0, originOffset.z, group.position)

  const skipGround = opts.skipGroundGlbs === true
  const pos = new THREE.Vector3()
  const box = new THREE.Box3()
  let any = false
  for (const place of opts.placements) {
    if (skipGround && isAoiSecondaryGroundSrc(place.src)) continue
    dclToThreePos(place.position.x, place.position.y, place.position.z, pos)
    const ext = Math.max(2, Math.abs(place.scale.x), Math.abs(place.scale.z)) * 2
    box.expandByPoint(pos)
    box.expandByPoint(new THREE.Vector3(pos.x + ext, pos.y + ext, pos.z + ext))
    box.expandByPoint(new THREE.Vector3(pos.x - ext, pos.y, pos.z - ext))
    any = true
  }
  if (any && !box.isEmpty()) {
    const size = new THREE.Vector3()
    const center = new THREE.Vector3()
    box.getSize(size)
    box.getCenter(center)
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(
        Math.max(8, size.x),
        Math.max(4, size.y),
        Math.max(8, size.z)
      ),
      new THREE.MeshLambertMaterial({
        color: 0x6a7a68,
        transparent: true,
        opacity: 0.45,
        depthWrite: false
      })
    )
    mesh.name = 'aoi-far-proxy'
    mesh.position.copy(center)
    mesh.castShadow = false
    mesh.receiveShadow = true
    mesh.frustumCulled = true
    mesh.updateMatrix()
    group.add(mesh)
  }

  freezeStaticGraph(group)
  group.updateMatrixWorld(true)
  return group
}

/** Neighbor shells never tween — skip per-frame matrix walks. */
function freezeStaticGraph(root: THREE.Object3D): void {
  root.traverse((node) => {
    node.matrixAutoUpdate = false
    node.updateMatrix()
  })
}

/**
 * Build a Three group from main.composite Gltf placements (render-only).
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
  const url = catalystContentAssetUrl(opts.contentBaseUrl, opts.compositeHash)
  const res = await fetch(url)
  if (!res.ok) {
    const empty = new THREE.Group()
    empty.name = 'aoi-composite-visuals'
    return empty
  }
  let json: unknown
  try {
    json = await res.json()
  } catch {
    const empty = new THREE.Group()
    empty.name = 'aoi-composite-visuals'
    return empty
  }

  return buildPlacementVisualGroup({
    cache: opts.cache,
    contentBaseUrl: opts.contentBaseUrl,
    content: opts.content,
    placements: extractCompositeGltfPlacements(json),
    neighborBase: opts.neighborBase,
    primaryBase: opts.primaryBase,
    maxGltfs: opts.maxGltfs,
    groupName: 'aoi-composite-visuals'
  })
}

