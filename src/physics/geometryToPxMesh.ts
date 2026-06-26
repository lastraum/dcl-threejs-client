import * as THREE from 'three'
import { deinterleaveGeometry } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { isTrimeshGeometryCookable } from './bakeTrimeshGeometry'
import {
  physxCookStorageKey,
  queuePhysxCookPersist,
} from './physxCookByteCache'
import {
  cookGeometryToStream,
  getMainThreadCookStats,
  pmeshFromWorkerStream,
  resetMainThreadCookStats,
  tryLoadPersistedCook
} from './geometryMainThreadCook'
import { isCookedMeshValid } from './physxCookStream'
import { isPhysxCookWorkerEnabled, takeCompletedPhysxCookStream } from './physxCookPool'

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
let sessionWorkerStreamHits = 0

export type GeometryToPxMeshOptions = {
  /** Share cooked meshes by geometry signature. Disable for world-baked trimesh (unique placement per instance). */
  cache?: boolean
  /** PxPhysics instance — required to deserialize IndexedDB / worker cooked streams. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  physics?: any
  /** Persist successful cooks to IndexedDB — boot only; runtime must leave false. */
  persistCook?: boolean
  /** Boot warm start — try primed IndexedDB before worker (world-baked cooks). */
  preferPersistedCook?: boolean
  /** Boot authoritative path — deserialize only from main-thread cooks of live baked geometry. */
  skipWorkerStream?: boolean
  /** Worker / IDB lookup key when `cache: false` (world-baked placement signature). */
  workerStorageKey?: string
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

export function hasGeometryCookCacheEntry(signature: string): boolean {
  return cache.has(signature)
}

/** Cache key from vertex/index bytes — `BufferGeometry.uuid` is shared across GLTF clones. */
export function geometryCookCacheId(geometry: THREE.BufferGeometry, convex: boolean): string {
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
  const storageKey = physxCookStorageKey(id, convex)
  const streamLookupKey = options?.workerStorageKey
    ? physxCookStorageKey(options.workerStorageKey, convex)
    : storageKey

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

  let pmesh: unknown = null
  let streamBytes: ArrayBuffer | null = null

  const loadPersisted = (): void => {
    if (pmesh || !options?.physics) return
    const persisted = tryLoadPersistedCook(options.physics, streamLookupKey, convex)
    if (!persisted) return
    pmesh = persisted
    if (useCache) {
      const item: CachedMesh = { id, pmesh: persisted, refs: 0, shared: true }
      cache.set(id, item)
      sessionCookHits++
    }
  }

  if (options?.preferPersistedCook) loadPersisted()

  if (!pmesh && !options?.skipWorkerStream && isPhysxCookWorkerEnabled() && options?.physics) {
    const workerStream = takeCompletedPhysxCookStream(streamLookupKey)
    if (workerStream) {
      pmesh = pmeshFromWorkerStream(options.physics, workerStream, convex)
      if (pmesh && isCookedMeshValid(pmesh, convex)) {
        streamBytes = workerStream
        sessionWorkerStreamHits++
      } else {
        safeReleasePmesh(pmesh)
        pmesh = null
        streamBytes = null
      }
    }
  }

  if (!pmesh && !options?.preferPersistedCook) loadPersisted()

  if (!pmesh) {
    const cooked = cookGeometryToStream(cookingParams, geo, convex)
    pmesh = cooked.pmesh
    streamBytes = cooked.streamBytes
  }

  if (pmesh == null || !isCookedMeshValid(pmesh, convex)) {
    safeReleasePmesh(pmesh)
    return null
  }

  if (options?.persistCook === true && streamBytes) {
    queuePhysxCookPersist(streamLookupKey, streamBytes)
  }

  const item: CachedMesh = { id, pmesh, refs: 0, shared: useCache }
  if (useCache) cache.set(id, item)
  return new PMeshHandle(item)
}

export type PxMeshHandle = PMeshHandle

export function resetGeometryCookCacheStats(): void {
  sessionCookHits = 0
  sessionCookMisses = 0
  sessionWorkerStreamHits = 0
  resetMainThreadCookStats()
}

export function getGeometryCookCacheStats(): {
  hits: number
  misses: number
  idbHits: number
  mainThread: number
  worker: number
  hitRate: number
} {
  const total = sessionCookHits + sessionCookMisses
  const mainStats = getMainThreadCookStats()
  return {
    hits: sessionCookHits,
    misses: sessionCookMisses,
    idbHits: mainStats?.idbHits ?? 0,
    mainThread: mainStats?.mainThread ?? 0,
    worker: sessionWorkerStreamHits,
    hitRate: total > 0 ? sessionCookHits / total : 1
  }
}

export {
  prefetchPhysxCookStreams,
  startPhysxCookPrefetch,
  getPhysxCookPoolStats,
  resetPhysxCookPoolSession,
  disposePhysxCookPool
} from './physxCookPool'
export { buildPhysxCookPrefetchRequests, buildBootPhysxCookPrefetchRequests } from './physxCookPrefetch'

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