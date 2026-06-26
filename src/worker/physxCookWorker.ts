/**
 * Offloads PhysX trimesh/convex **cooking** (CookTriangleMesh / CookConvexMesh) from the main thread.
 * Returns cooked binary streams — main deserializes via PxPhysics.createTriangleMesh.
 */
import { isPhysxCookPayloadCookable, type PhysxCookMeshPayload } from '../physics/physxCookPayload'

type CookRequest = {
  type: 'cook'
  id: number
  convex: boolean
  positions: Float32Array
  indices: Uint16Array | Uint32Array
  use16BitIndices: boolean
}

type CookDone = { type: 'cook-done'; id: number; stream: ArrayBuffer }
type CookError = { type: 'cook-error'; id: number; message: string }
type CookEmpty = { type: 'cook-empty'; id: number }

type WorkerInbound = CookRequest

const ctx = self as unknown as DedicatedWorkerGlobalScope

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let cookingParams: any = null
let initPromise: Promise<void> | null = null
// Keep bootstrap objects alive — PhysX cooking depends on Foundation allocation.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let physxBootstrap: { allocator: any; errorCb: any; foundation: any; physics: any; tolerances: any } | null =
  null

let cookChain: Promise<void> = Promise.resolve()

async function ensurePhysxCooking(): Promise<void> {
  if (cookingParams) return
  if (!initPromise) {
    initPromise = (async () => {
      const { default: PhysXModule } = await import('../physics/vendor/physx-js-webidl.js')
      globalThis.PHYSX = await PhysXModule()
      const version = PHYSX.PHYSICS_VERSION
      const allocator = new PHYSX.PxDefaultAllocator()
      const errorCb = new PHYSX.PxDefaultErrorCallback()
      const foundation = PHYSX.CreateFoundation(version, allocator, errorCb)
      const tolerances = new PHYSX.PxTolerancesScale()
      cookingParams = new PHYSX.PxCookingParams(tolerances)
      const physics = PHYSX.CreatePhysics(version, foundation, tolerances)
      PHYSX.PxTopLevelFunctions.prototype.InitExtensions(physics)
      physxBootstrap = { allocator, errorCb, foundation, physics, tolerances }
      if (!physxBootstrap.foundation || !physxBootstrap.physics) {
        throw new Error('PhysX cook worker bootstrap incomplete')
      }
    })()
  }
  await initPromise
}

function copyStreamBytes(outStream: { getSize: () => number; getData: () => number }): ArrayBuffer | null {
  const size = outStream.getSize()
  const dataPtr = outStream.getData()
  if (size <= 0 || !dataPtr) return null
  const heapEnd = dataPtr + size
  if (heapEnd > PHYSX.HEAPU8.length) return null
  const copy = new Uint8Array(size)
  copy.set(PHYSX.HEAPU8.subarray(dataPtr, heapEnd))
  return copy.buffer
}

function cookPayloadToStream(payload: PhysxCookMeshPayload, convex: boolean): ArrayBuffer | null {
  if (!isPhysxCookPayloadCookable(payload)) return null

  const positions = payload.positions
  const floatBytes = positions.length * positions.BYTES_PER_ELEMENT
  const pointsPtr = PHYSX._webidl_malloc(floatBytes)
  if (!pointsPtr) return null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let desc: any = null
  const outStream = new PHYSX.PxDefaultMemoryOutputStream()
  let streamBytes: ArrayBuffer | null = null

  try {
    PHYSX.HEAPF32.set(positions, pointsPtr >> 2)

    if (convex) {
      desc = new PHYSX.PxConvexMeshDesc()
      desc.points.count = positions.length / 3
      desc.points.stride = 12
      desc.points.data = pointsPtr
      desc.flags.raise(PHYSX.PxConvexFlagEnum.eCOMPUTE_CONVEX)
      if (!PHYSX.CookConvexMesh(cookingParams, desc, outStream)) return null
    } else {
      desc = new PHYSX.PxTriangleMeshDesc()
      desc.points.count = positions.length / 3
      desc.points.stride = 12
      desc.points.data = pointsPtr

      const indices = payload.indices
      const indexBytes = indices.length * indices.BYTES_PER_ELEMENT
      const indexPtr = PHYSX._webidl_malloc(indexBytes)
      if (!indexPtr) return null
      try {
        if (payload.use16BitIndices) {
          PHYSX.HEAPU16.set(indices as Uint16Array, indexPtr >> 1)
          desc.triangles.stride = 6
          desc.flags.raise(PHYSX.PxTriangleMeshFlagEnum.e16_BIT_INDICES)
        } else {
          PHYSX.HEAPU32.set(indices as Uint32Array, indexPtr >> 2)
          desc.triangles.stride = 12
        }
        desc.triangles.count = indices.length / 3
        desc.triangles.data = indexPtr
        if (!PHYSX.CookTriangleMesh(cookingParams, desc, outStream)) return null
      } finally {
        PHYSX._webidl_free(indexPtr)
      }
    }

    streamBytes = copyStreamBytes(outStream)
    return streamBytes
  } catch {
    return null
  } finally {
    PHYSX._webidl_free(pointsPtr)
    if (desc) PHYSX.destroy(desc)
    PHYSX.destroy(outStream)
  }
}

function handleCook(msg: CookRequest): Promise<void> {
  return ensurePhysxCooking().then(() => {
    const payload: PhysxCookMeshPayload = {
      positions: msg.positions,
      indices: msg.indices,
      use16BitIndices: msg.use16BitIndices
    }
    const stream = cookPayloadToStream(payload, msg.convex)
    if (!stream?.byteLength) {
      ctx.postMessage({ type: 'cook-empty', id: msg.id } satisfies CookEmpty)
      return
    }
    ctx.postMessage({ type: 'cook-done', id: msg.id, stream } satisfies CookDone, [stream])
  })
}

ctx.onmessage = (ev: MessageEvent<WorkerInbound>) => {
  const msg = ev.data
  if (msg.type !== 'cook') return

  cookChain = cookChain
    .then(() => handleCook(msg))
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err)
      ctx.postMessage({ type: 'cook-error', id: msg.id, message } satisfies CookError)
    })
}