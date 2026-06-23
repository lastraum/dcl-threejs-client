/**
 * Platform motion architecture
 *
 * Two separate pipelines — do not conflate them:
 *
 * 1. **Collider pose sync** (World.syncPlayerMotionFrame)
 *    Detect mesh/transform motion → slide PhysX actor poses so colliders match the scene.
 *    May scan nearby GLTF colliders; animated props (SnoopCar) belong here only.
 *
 * 2. **Riding transfer** (PlayerSystem → PhysXWorld.applyPlatformVelocityTransfer)
 *    CCT is kinematic — when the surface *under the feet* moves, capsule += Δ before move().
 *    Δ comes ONLY from the CCT-grounded PhysX actor (lastGroundPhysEntity), via actor-root /
 *    PhysX-bounds / ground-contact probes — never from distant mesh bbox animation.
 *
 * Mesh walk-surface Δ (GltfColliderExtractor) feeds pose-sync detection only, not riding transfer.
 */

/** Ignore sub-mm PhysX/probe jitter on static floors (~8 mm). */
export const MIN_PLATFORM_TRANSFER_LEN_SQ = 6.25e-5

export function isSignificantPlatformDelta(delta: { lengthSq(): number }): boolean {
  return delta.lengthSq() >= MIN_PLATFORM_TRANSFER_LEN_SQ
}