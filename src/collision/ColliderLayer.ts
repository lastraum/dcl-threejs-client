/** DCL ColliderLayer bit flags — matches `PBMeshCollider.collisionMask`. */
export const ColliderLayer = {
  CL_NONE: 0,
  CL_POINTER: 1,
  CL_PHYSICS: 2,
  CL_PLAYER: 4,
  CL_MAIN_PLAYER: 8,
  CL_RESERVED3: 16,
  CL_RESERVED4: 32,
  CL_RESERVED5: 64,
  CL_RESERVED6: 128,
  CL_CUSTOM1: 256,
  CL_CUSTOM2: 512,
  CL_CUSTOM3: 1024,
  CL_CUSTOM4: 2048,
  CL_CUSTOM5: 4096,
  CL_CUSTOM6: 8192,
  CL_CUSTOM7: 16384,
  CL_CUSTOM8: 32768
} as const

export type ColliderLayerFlag = (typeof ColliderLayer)[keyof typeof ColliderLayer]

/** SDK default when `collisionMask` is omitted: pointer + physics. */
export const DEFAULT_COLLISION_MASK = ColliderLayer.CL_POINTER | ColliderLayer.CL_PHYSICS

export function resolveCollisionMask(mask?: number): number {
  return mask ?? DEFAULT_COLLISION_MASK
}

export function hasColliderLayer(mask: number, layer: number): boolean {
  return (mask & layer) !== 0
}
