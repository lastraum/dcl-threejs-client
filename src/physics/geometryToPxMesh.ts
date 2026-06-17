import * as THREE from 'three'
import { deinterleaveGeometry } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { isTrimeshGeometryCookable } from './bakeTrimeshGeometry'

type CachedMesh = {
  id: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  pmesh: any
  refs: number
  /** When false, mesh is owned by a single handle and not stored in the global cache. */
  shared: boolean
}

const cache = new Map<string, CachedMesh>()
let nocacheSeq = 0
let sessionCookHits = 0
let sessionCookMisses = 0

export type GeometryToPxMeshOptions = {
  /** Share cooked meshes by geometry signature. Disable for world-baked trimesh (unique placement per instance). */
  cache?: boolean
}

class PMeshHandle {
  readonly item: CachedMesh
  released = false
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  value: any = null

  constructor(item: CachedMesh) {
    this.item = item
    this.value = item.pmesh
    item.refs++
  }

  release(): void {
    if (this.released) return
    this.item.refs--
    if (this.item.refs === 0) {
      try {
        if (this.item.pmesh?.isReleasable?.()) {
          this.item.pmesh.release()
        }
      } catch (err) {
        console.warn('[geometryToPxMesh] pmesh release failed', err)
      }
      if (this.item.shared) cache.delete(this.item.id)
    }
    this.released = true
    this.value = null
  }
}

function safeReleasePmesh(pmesh: unknown): void {
  if (!pmesh || typeof pmesh !== 'object') return
  try {
    const mesh = pmesh as { isReleasable?: () => boolean; release?: () => void }
    if (mesh.isReleasable?.()) mesh.release?.()
  } catch {
    // invalid wasm handle after degenerate cook — never touch again
  }
}

function isCookedMeshValid(pmesh: unknown, convex: boolean): boolean {
  if (pmesh == null || typeof pmesh !== 'object') return false
  const mesh = pmesh as { getNbTriangles?: () => number; getNbVertices?: () => number }
  try {
    if (convex) return (mesh.getNbVertices?.() ?? 0) > 0
    return (mesh.getNbTriangles?.() ?? 0) > 0
  } catch {
    return false
  }
}

/** Cache key from vertex/index bytes — `BufferGeometry.uuid` is shared across GLTF clones. */
function geometryCookCacheId(geometry: THREE.BufferGeometry, convex: boolean): string {
  const pos = geometry.attributes.position as THREE.BufferAttribute | undefined
  const index = geometry.index
  if (!pos?.array || !index?.array) {
    return `${geometry.uuid}_${convex ? 'convex' : 'triangles'}`
  }
  const p = pos.array as ArrayLike<number>
  const ix = index.array as ArrayLike<number>
  const pc = pos.count
  const ic = index.count
  const mid = Math.max(0, Math.floor(pc / 2)) * 3
  const last = Math.max(0, pc - 1) * 3
  const sig = [
    pc,
    ic,
    p[0],
    p[1],
    p[2],
    p[mid],
    p[mid + 1],
    p[mid + 2],
    p[last],
    p[last + 1],
    p[last + 2],
    ix[0],
    ix[ic - 1] ?? 0
  ].join(',')
  return `${sig}_${convex ? 'convex' : 'triangles'}`
}

/** Cook Three.js geometry to a PhysX triangle/convex mesh (Hyperfy `geometryToPxMesh.js`). */
export function geometryToPxMesh(
  cookingParams: unknown,
  geometry: THREE.BufferGeometry,
  convex = false,
  options?: GeometryToPxMeshOptions
): PMeshHandle | null {
  const useCache = options?.cache !== false
  const id = useCache
    ? geometryCookCacheId(geometry, convex)
    : `nocache_${nocacheSeq++}_${geometryCookCacheId(geometry, convex)}`

  if (useCache) {
    const cached = cache.get(id)
    if (cached) {
      sessionCookHits++
      return new PMeshHandle(cached)
    }
  }

  let geo = geometry
  if (geo.attributes.position instanceof THREE.InterleavedBufferAttribute) {
    geo = geo.clone()
    deinterleaveGeometry(geo)
  }

  if (!isTrimeshGeometryCookable(geo)) return null

  if (useCache) sessionCookMisses++

  let position = geo.attributes.position as THREE.BufferAttribute
  const index = geo.index
  if (!position || !index || position.count < 3 || index.count < 3) return null

  if (!(position.array instanceof Float32Array)) {
    position = new THREE.BufferAttribute(new Float32Array(position.array), position.itemSize, false)
    geo = geo.clone()
    geo.setAttribute('position', position)
  }

  const positions = position.array as Float32Array
  const floatBytes = positions.length * positions.BYTES_PER_ELEMENT
  const pointsPtr = PHYSX._webidl_malloc(floatBytes)
  PHYSX.HEAPF32.set(positions, pointsPtr >> 2)

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let desc: any = null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let pmesh: any = null

  try {
    if (convex) {
      desc = new PHYSX.PxConvexMeshDesc()
      desc.points.count = positions.length / 3
      desc.points.stride = 12
      desc.points.data = pointsPtr
      desc.flags.raise(PHYSX.PxConvexFlagEnum.eCOMPUTE_CONVEX)
      pmesh = PHYSX.CreateConvexMesh(cookingParams, desc)
    } else {
      desc = new PHYSX.PxTriangleMeshDesc()
      desc.points.count = positions.length / 3
      desc.points.stride = 12
      desc.points.data = pointsPtr

      let indices = index.array as Uint16Array | Uint32Array | Uint8Array
      if (indices instanceof Uint8Array) {
        const u16 = new Uint16Array(indices.length)
        for (let i = 0; i < indices.length; i++) u16[i] = indices[i]
        indices = u16
      }

      const indexBytes = indices.length * indices.BYTES_PER_ELEMENT
      const indexPtr = PHYSX._webidl_malloc(indexBytes)
      try {
        if (indices instanceof Uint16Array) {
          PHYSX.HEAPU16.set(indices, indexPtr >> 1)
          desc.triangles.stride = 6
          desc.flags.raise(PHYSX.PxTriangleMeshFlagEnum.e16_BIT_INDICES)
        } else {
          PHYSX.HEAPU32.set(indices as Uint32Array, indexPtr >> 2)
          desc.triangles.stride = 12
        }
        desc.triangles.count = indices.length / 3
        desc.triangles.data = indexPtr
        pmesh = PHYSX.CreateTriangleMesh(cookingParams, desc)
      } finally {
        PHYSX._webidl_free(indexPtr)
      }
    }
  } catch {
    pmesh = null
  } finally {
    PHYSX._webidl_free(pointsPtr)
    if (desc) PHYSX.destroy(desc)
  }

  if (pmesh == null || !isCookedMeshValid(pmesh, convex)) {
    safeReleasePmesh(pmesh)
    return null
  }

  const item: CachedMesh = { id, pmesh, refs: 0, shared: useCache }
  if (useCache) cache.set(id, item)
  return new PMeshHandle(item)
}

export type PxMeshHandle = PMeshHandle

export function resetGeometryCookCacheStats(): void {
  sessionCookHits = 0
  sessionCookMisses = 0
}

export function getGeometryCookCacheStats(): { hits: number; misses: number; hitRate: number } {
  const total = sessionCookHits + sessionCookMisses
  return {
    hits: sessionCookHits,
    misses: sessionCookMisses,
    hitRate: total > 0 ? sessionCookHits / total : 1
  }
}

/** Release all shared cooked meshes — call when tearing down a World. */
export function clearGeometryCookCache(): void {
  for (const item of cache.values()) {
    try {
      if (item.pmesh?.isReleasable?.()) item.pmesh.release()
    } catch {
      // stale wasm handle
    }
  }
  cache.clear()
}
