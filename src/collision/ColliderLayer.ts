/** DCL ColliderLayer bit flags — matches `PBMeshCollider.collisionMask`. */
export const ColliderLayer = {
  CL_NONE: 0,
  CL_POINTER: 1,
  CL_PHYSICS: 2,
  CL_PLAYER: 4,
  CL_MAIN_PLAYER: 8
} as const

export type ColliderLayerFlag = (typeof ColliderLayer)[keyof typeof ColliderLayer]

/** SDK default when `collisionMask` is omitted: pointer + physics. */
export const DEFAULT_COLLISION_MASK = ColliderLayer.CL_POINTER | ColliderLayer.CL_PHYSICS

export function resolveCollisionMask(mask?: number): number {
  return mask ?? DEFAULT_COLLISION_MASK
}

export function hasColliderLayer(mask: number, layer: ColliderLayerFlag): boolean {
  return (mask & layer) !== 0
}
