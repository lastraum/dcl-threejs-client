/**
 * Platform motion architecture — Explorer-parity law
 * (see docs/RIDING_TRANSFER_LAW.md, docs/COLLIDER_MOTION_POLICY.md)
 *
 * Two pipelines only — do not add a third “recovery” path:
 *
 * 1. **Collider pose sync** (World.syncPlayerMotionFrame)
 *    Transform dirty (ROOT, including collider-bearing descendants) or Animator PART
 *    → PhysX actors match scene colliders the same frame.
 *
 * 2. **Riding transfer** (PlayerSystem → applyPlatformVelocityTransfer)
 *    CCT is kinematic. When the *grounded* PhysX actor moves, capsule += that actor’s
 *    world Δ **once** before move(). Δ is measured from that actor only (pose before/after
 *    ROOT slide, or one PART walk-surface probe). Never sticky multi-frame Δ, never
 *    stacked mesh/actor-root/bounds probes, never post-move pull-down.
 *
 * Scenes expose gaps in this law; they are not special cases.
 */

/** Feet may be this far above animated tread to start PhysX shape sync (step onto bobbing prop). */
export const STAND_SURFACE_MAX_VERT_GAP = 1.4
/** Feet may be this far below tread while a bobbing surface rises (prevents fall-through before CCT grounds). */
export const STAND_SURFACE_MAX_BELOW_TREAD = 1.4
/** Feet must be on/near tread top — not walking on floor far below a bobbing mesh overhead. */
export const STAND_SURFACE_CONTACT_TOLERANCE = 0.08
/** Max horizontal riding Δ per frame. */
export const MAX_RIDING_DELTA_HORIZ = 0.45

/** Ignore sub-mm PhysX/probe jitter on static floors (~8 mm). */
export const MIN_PLATFORM_TRANSFER_LEN_SQ = 6.25e-5

export function isSignificantPlatformDelta(delta: { lengthSq(): number }): boolean {
  return delta.lengthSq() >= MIN_PLATFORM_TRANSFER_LEN_SQ
}
