/** Shared PhysX cooked-mesh stream helpers (main thread + sim worker). */

export function copyWasmBytes(ptr: number, size: number): ArrayBuffer {
  const copy = new Uint8Array(size)
  copy.set(PHYSX.HEAPU8.subarray(ptr, ptr + size))
  return copy.buffer
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function pmeshFromCookStream(physics: any, streamBytes: ArrayBuffer, convex: boolean): any | null {
  const u8 = new Uint8Array(streamBytes)
  const ptr = PHYSX._webidl_malloc(u8.byteLength)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let input: any = null
  try {
    PHYSX.HEAPU8.set(u8, ptr)
    input = new PHYSX.PxDefaultMemoryInputData(ptr, u8.byteLength)
    return convex ? physics.createConvexMesh(input) : physics.createTriangleMesh(input)
  } catch {
    return null
  } finally {
    if (input) PHYSX.destroy(input)
    PHYSX._webidl_free(ptr)
  }
}

export function isCookedMeshValid(pmesh: unknown, convex: boolean): boolean {
  if (pmesh == null || typeof pmesh !== 'object') return false
  const mesh = pmesh as { getNbTriangles?: () => number; getNbVertices?: () => number }
  try {
    if (convex) return (mesh.getNbVertices?.() ?? 0) > 0
    return (mesh.getNbTriangles?.() ?? 0) > 0
  } catch {
    return false
  }
}