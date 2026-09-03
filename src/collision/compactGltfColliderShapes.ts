import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { bakeTrimeshGeometry, isTrimeshGeometryCookable } from '../physics/bakeTrimeshGeometry'
import { ensureIndexedForCook } from '../physics/colliderGeometryPrep'
import type { PhysicsColliderShapeDesc } from '../physics/PhysXWorld'

/** Local-space pre-cook check — zero-area triangles stay zero after affine bake. */
export function isSourceTrimeshCookable(geometry: THREE.BufferGeometry | undefined): boolean {
  if (!geometry) return false
  const indexed = ensureIndexedForCook(geometry)
  try {
    return isTrimeshGeometryCookable(indexed)
  } finally {
    if (indexed !== geometry) indexed.dispose()
  }
}

function classFromFingerprint(fp: string): 'vis' | 'inv' | 'other' {
  if (fp.includes(':inv:')) return 'inv'
  if (fp.includes(':vis:')) return 'vis'
  return 'other'
}

function attrLayoutKey(geometry: THREE.BufferGeometry): string {
  const names = Object.keys(geometry.attributes).sort()
  return names.map((name) => `${name}:${geometry.getAttribute(name)?.itemSize ?? 0}`).join('|')
}

function compactClass(kind: 'vis' | 'inv', list: PhysicsColliderShapeDesc[]): PhysicsColliderShapeDesc[] {
  if (list.length <= 1) return list
  const buckets = new Map<string, PhysicsColliderShapeDesc[]>()
  for (const shape of list) {
    const geo = shape.geometry
    if (!geo) continue
    const key = attrLayoutKey(geo)
    let bucket = buckets.get(key)
    if (!bucket) {
      bucket = []
      buckets.set(key, bucket)
    }
    bucket.push(shape)
  }
  const out: PhysicsColliderShapeDesc[] = []
  let bucketIndex = 0
  for (const bucket of buckets.values()) {
    const slot = bucketIndex++
    if (bucket.length === 1) {
      out.push(bucket[0]!)
      continue
    }
    const baked: THREE.BufferGeometry[] = []
    for (const shape of bucket) {
      const geo = shape.geometry
      if (!geo) continue
      const indexed = ensureIndexedForCook(geo)
      const world = bakeTrimeshGeometry(indexed, shape.localMatrix)
      if (indexed !== geo) indexed.dispose()
      if (!isTrimeshGeometryCookable(world)) {
        world.dispose()
        continue
      }
      baked.push(world)
    }
    if (baked.length === 0) continue
    if (baked.length === 1) {
      const geo = baked[0]!
      const pos = geo.getAttribute('position')
      out.push({
        fingerprint: `gltf:${kind}:compact:${slot}:${pos?.count ?? 0}:${geo.index?.count ?? 0}`,
        geometry: geo,
        localMatrix: new THREE.Matrix4()
      })
      continue
    }
    const merged = mergeGeometries(baked, false)
    for (const geo of baked) geo.dispose()
    if (!merged) {
      // Incompatible buffers — keep original per-mesh hulls for this layout.
      out.push(...bucket)
      continue
    }
    const pos = merged.getAttribute('position')
    out.push({
      fingerprint: `gltf:${kind}:compact:${slot}:${pos?.count ?? 0}:${merged.index?.count ?? 0}`,
      geometry: merged,
      localMatrix: new THREE.Matrix4()
    })
  }
  return out
}

/**
 * Drop uncookable (zero-area) hulls. When `compact` is true, fold remaining vis/inv
 * static trimeshes into one hull per class+layout so CCT gets one RigidStatic, not N.
 * Animator PART must pass compact=false — per-mesh locals still slide with clips.
 */
export function filterAndMaybeCompactGltfColliderShapes(
  _entity: number,
  shapes: PhysicsColliderShapeDesc[],
  compact: boolean
): PhysicsColliderShapeDesc[] {
  const cookable: PhysicsColliderShapeDesc[] = []
  for (const shape of shapes) {
    if (!isSourceTrimeshCookable(shape.geometry)) continue
    cookable.push(shape)
  }
  if (!compact || cookable.length <= 1) return cookable

  const vis: PhysicsColliderShapeDesc[] = []
  const inv: PhysicsColliderShapeDesc[] = []
  const other: PhysicsColliderShapeDesc[] = []
  for (const shape of cookable) {
    const kind = classFromFingerprint(shape.fingerprint)
    if (kind === 'vis') vis.push(shape)
    else if (kind === 'inv') inv.push(shape)
    else other.push(shape)
  }
  return [...compactClass('vis', vis), ...compactClass('inv', inv), ...other]
}
