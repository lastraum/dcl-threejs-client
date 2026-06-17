let promise: Promise<{
  version: number
  allocator: unknown
  errorCb: unknown
  foundation: unknown
}> | null = null

/** Load PhysX WASM once (ported from Hyperfy `loadPhysX.js`). */
export function loadPhysX() {
  if (!promise) {
    promise = (async () => {
      const { default: PhysXModule } = await import('./vendor/physx-js-webidl.js')
      globalThis.PHYSX = await PhysXModule()
      const version = PHYSX.PHYSICS_VERSION
      const allocator = new PHYSX.PxDefaultAllocator()
      const errorCb = new PHYSX.PxDefaultErrorCallback()
      const foundation = PHYSX.CreateFoundation(version, allocator, errorCb)
      return { version, allocator, errorCb, foundation }
    })()
  }
  return promise
}
