import * as THREE from 'three'
import { takePrimedPhysxCookStream } from './physxCookByteCache'
import { copyWasmBytes, isCookedMeshValid, pmeshFromCookStream } from './physxCookStream'

let sessionIdbHits = 0
let sessionMainThreadCooks = 0

export function getMainThreadCookStats(): { idbHits: number; mainThread: number } {
  return { idbHits: sessionIdbHits, mainThread: sessionMainThreadCooks }
}

export function resetMainThreadCookStats(): void {
  sessionIdbHits = 0
  sessionMainThreadCooks = 0
}

function safeReleasePmesh(pmesh: unknown): void {
  if (!pmesh || typeof pmesh !== 'object') return
  try {
    const mesh = pmesh as { isReleasable?: () => boolean; release?: () => void }
    if (mesh.isReleasable?.()) mesh.release?.()
  } catch {
    // ignore
  }
}

export function tryLoadPersistedCook(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  physics: any,
  storageKey: string,
  convex: boolean
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): any | null {
  const streamBytes = takePrimedPhysxCookStream(storageKey)
  if (!streamBytes) return null
  const pmesh = pmeshFromCookStream(physics, streamBytes, convex)
  if (!pmesh || !isCookedMeshValid(pmesh, convex)) {
    safeReleasePmesh(pmesh)
    return null
  }
  sessionIdbHits++
  return pmesh
}

export function pmeshFromWorkerStream(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  physics: any,
  stream: ArrayBuffer,
  convex: boolean
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): any | null {
  const pmesh = pmeshFromCookStream(physics, stream, convex)
  if (!pmesh || !isCookedMeshValid(pmesh, convex)) {
    safeReleasePmesh(pmesh)
    return null
  }
  return pmesh
}

export function cookGeometryToStream(
  cookingParams: unknown,
  geo: THREE.BufferGeometry,
  convex: boolean
): { pmesh: unknown; streamBytes: ArrayBuffer | null } {
  let position = geo.attributes.position as THREE.BufferAttribute
  const index = geo.index
  if (!position || !index || position.count < 3 || index.count < 3) {
    return { pmesh: null, streamBytes: null }
  }

  if (!(position.array instanceof Float32Array)) {
    position = new THREE.BufferAttribute(new Float32Array(position.array), position.itemSize, false)
    geo = geo.clone()
    geo.setAttribute('position', position)
  }

  const positions = position.array as Float32Array
  const floatBytes = positions.length * positions.BYTES_PER_ELEMENT
  const pointsPtr = PHYSX._webidl_malloc(floatBytes)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let desc: any = null
  const outStream = new PHYSX.PxDefaultMemoryOutputStream()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let pmesh: any = null
  let streamBytes: ArrayBuffer | null = null

  try {
    PHYSX.HEAPF32.set(positions, pointsPtr >> 2)

    if (convex) {
      desc = new PHYSX.PxConvexMeshDesc()
      desc.points.count = positions.length / 3
      desc.points.stride = 12
      desc.points.data = pointsPtr
      desc.flags.raise(PHYSX.PxConvexFlagEnum.eCOMPUTE_CONVEX)
      if (!PHYSX.CookConvexMesh(cookingParams, desc, outStream)) {
        return { pmesh: null, streamBytes: null }
      }
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
        if (!PHYSX.CookTriangleMesh(cookingParams, desc, outStream)) {
          return { pmesh: null, streamBytes: null }
        }
        pmesh = PHYSX.CreateTriangleMesh(cookingParams, desc)
      } finally {
        PHYSX._webidl_free(indexPtr)
      }
    }

    const size = outStream.getSize()
    const dataPtr = outStream.getData()
    if (size > 0 && dataPtr) {
      streamBytes = copyWasmBytes(dataPtr, size)
    }
    sessionMainThreadCooks++
  } catch {
    pmesh = null
    streamBytes = null
  } finally {
    PHYSX._webidl_free(pointsPtr)
    if (desc) PHYSX.destroy(desc)
    PHYSX.destroy(outStream)
  }

  return { pmesh, streamBytes }
}