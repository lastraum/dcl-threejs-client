import * as THREE from 'three'
import type { AssetCache } from '../../rendering/AssetCache'
import { dclToThreePos, dclToThreeQuat } from '../../bridge/dclTransform'
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
export function extractCompositeGltfPlacements(compositeJson: unknown): Array<{
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

  for (const [entKey, rawGltf] of Object.entries(gltfData)) {
    const gltf = unwrap(rawGltf) as { src?: string } | null
    const src = typeof gltf?.src === 'string' ? gltf.src.trim() : ''
    if (!src) continue

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

function hideColliderMeshes(root: THREE.Object3D): void {
  root.traverse((node) => {
    if (node instanceof THREE.Mesh && /collider/i.test(node.name)) {
      node.visible = false
    }
  })
}

/** Neighbor-local Gltf placement (from composite parse or first-frame ECS snapshot). */
export type GltfPlacement = {
  src: string
  position: { x: number; y: number; z: number }
  rotation: { x: number; y: number; z: number; w: number }
  scale: { x: number; y: number; z: number }
}

/**
 * Build a Three group of cloned GLBs for a neighbor scene (render-only).
 *
 * Placements are **neighbor scene-local DCL** (same space as a primary load of that
 * scene). The whole group is shifted by (neighborBase − primaryBase) so it sits
 * correctly in the primary's scene graph.
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
}): Promise<THREE.Group> {
  const group = new THREE.Group()
  group.name = opts.groupName ?? 'aoi-placement-visuals'

  // Neighbor root origin in primary-relative DCL → Three (X reflect once on the root).
  const originOffset = neighborOriginOffset(opts.neighborBase, opts.primaryBase)
  dclToThreePos(originOffset.x, 0, originOffset.z, group.position)

  const max = opts.maxGltfs ?? 80
  const slice = opts.placements.slice(0, max)

  const quat = new THREE.Quaternion()
  const pos = new THREE.Vector3()

  await Promise.all(
    slice.map(async (place) => {
      const resolved = resolveContentUrl(place.src, opts.content, opts.contentBaseUrl)
      if (!resolved) return
      try {
        const { root } = await opts.cache.load(resolved.url, resolved.hash)
        const clone = root.clone(true)
        hideColliderMeshes(clone)
        // Local to neighbor base (already world-within-neighbor after hierarchy bake).
        dclToThreePos(place.position.x, place.position.y, place.position.z, pos)
        clone.position.copy(pos)
        dclToThreeQuat(
          place.rotation.x,
          place.rotation.y,
          place.rotation.z,
          place.rotation.w,
          quat
        )
        clone.quaternion.copy(quat)
        clone.scale.set(place.scale.x, place.scale.y, place.scale.z)
        clone.name = `aoi-gltf:${place.src.split('/').pop() ?? 'mesh'}`
        group.add(clone)
      } catch {
        /* missing glb */
      }
    })
  )

  return group
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

