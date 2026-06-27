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
 * Mesh walk-surface Δ does not drive either pipeline.
 *
 * 3. **Animator mesh deformation** (SnoopCar, lift tread, etc.)
 *    PhysX shape locals sync only when the capsule column overlaps that tread (stand surface).
 *    Distant animated props stay at rest pose — no camera / bystander jitter.
 */

/** Feet may be this far above animated tread to start PhysX shape sync (step onto bobbing prop). */
export const STAND_SURFACE_MAX_VERT_GAP = 1.4
/** Feet may be this far below tread while a bobbing surface rises (prevents fall-through before CCT grounds). */
export const STAND_SURFACE_MAX_BELOW_TREAD = 1.4
/** Feet must be on/near tread top — not walking on floor far below a bobbing mesh overhead. */
export const STAND_SURFACE_CONTACT_TOLERANCE = 0.08
/** Max horizontal riding Δ per frame — bobbing Animator treads; wider pose-sync limits stay separate. */
export const MAX_RIDING_DELTA_HORIZ = 0.45

/** Ignore sub-mm PhysX/probe jitter on static floors (~8 mm). */
export const MIN_PLATFORM_TRANSFER_LEN_SQ = 6.25e-5

export function isSignificantPlatformDelta(delta: { lengthSq(): number }): boolean {
  return delta.lengthSq() >= MIN_PLATFORM_TRANSFER_LEN_SQ
}