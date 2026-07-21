import * as THREE from 'three'
import { isModelWearable } from './slots'
import type { WearableCategory, WearableDefinition } from './types'

type HideTarget = WearableCategory | 'head' | 'hands'

/**
 * Equipped category OR explicit hides/replaces — the official rule.
 * Measured proof (f_short_blue_jeans): the base lbody is authored WIDER than the
 * shorts fabric (x ±0.204 vs ±0.198) — base parts are meant to be hidden under
 * same-slot wearables, which carry their own AvatarSkin replacement geometry.
 * (A brief "explicit-only" experiment un-hid base parts and made them poke through
 * fabric everywhere; the waist band above a low waistband is covered visually by
 * the wearable's double-sided interior, not by base skin.)
 */
function isHiddenByWearable(
  wearable: WearableDefinition,
  target: HideTarget,
  fallbackCategories?: ReadonlySet<WearableCategory>
): boolean {
  if (target === 'head') {
    return wearable.data.hides?.includes('head') || wearable.data.replaces?.includes('head') || false
  }
  if (target === 'hands') return false
  // Same-category auto-hide applies to MERGED wearables only. A fallback attach is
  // rigid (its replacement skin can't animate), so the base part must keep rendering
  // and deforming under it — unless the wearable's metadata explicitly hides it.
  const selfHides =
    wearable.data.category === target && !fallbackCategories?.has(wearable.data.category)
  return (
    selfHides ||
    wearable.data.hides?.includes(target) ||
    wearable.data.replaces?.includes(target) ||
    false
  )
}

function isHiddenCategory(
  wearables: WearableDefinition[],
  target: HideTarget,
  fallbackCategories?: ReadonlySet<WearableCategory>
): boolean {
  return wearables.some((w) => isHiddenByWearable(w, target, fallbackCategories))
}

/** Upper-body wearables hide default hands unless `removesDefaultHiding` includes hands. */
function isHandsHidden(wearables: WearableDefinition[]): boolean {
  if (wearables.some((w) => w.data.category === 'skin')) return true
  return wearables.some((w) => {
    const isUpperBody = w.data.category === 'upper_body'
    const hidesUpperBody = w.data.hides?.includes('upper_body') ?? false
    const removesDefaultHiding = w.data.removesDefaultHiding?.includes('hands') ?? false
    return (isUpperBody || hidesUpperBody) && !removesDefaultHiding
  })
}

/**
 * True when the mesh belongs to a wearable GLB fallback-attached under a body bone.
 * Wearable roots are named `wearable:<category>` (bodyRoot itself is `wearable:body_shape`,
 * so the walk stops before reaching it).
 */
function isInsideAttachedWearable(obj: THREE.Object3D, bodyRoot: THREE.Object3D): boolean {
  for (let p: THREE.Object3D | null = obj; p && p !== bodyRoot; p = p.parent) {
    if (p.name.startsWith('wearable:')) return true
  }
  return false
}

export type BodyShapeVisibilityOptions = {
  /**
   * Categories that actually attached a mesh this compose. When set, hide basemesh for a
   * category only if it is in the set (or skin) — so a failed feet attach keeps base feet.
   */
  attachedCategories?: ReadonlySet<WearableCategory>
  /**
   * Categories attached via the rigid fallback — their slot's basemesh stays visible
   * (fallback skin can't animate; the base part must keep deforming under it) unless
   * the wearable's hides/replaces metadata says otherwise.
   */
  fallbackCategories?: ReadonlySet<WearableCategory>
  /** Categories the user force-renders despite hides (ADR-239) — keep their base shell. */
  forceRender?: readonly string[]
}

/** Hide body_shape basemesh parts when wearables cover them — ported from Forge `body.ts`. */
export function applyBodyShapeVisibility(
  bodyRoot: THREE.Object3D,
  wearables: WearableDefinition[],
  options: BodyShapeVisibilityOptions = {}
): void {
  const attached = options.attachedCategories
  // A wearable's hides (and its own-category coverage) only count once its mesh actually
  // attached — a failed feet attach must keep base feet. Texture-only categories
  // (eyes/eyebrows/mouth) and body_shape never attach as layers, so they always count.
  const effective = attached
    ? wearables.filter(
        (w) =>
          w.data.category === 'body_shape' ||
          !isModelWearable(w) ||
          attached.has(w.data.category)
      )
    : wearables
  const hasSkin = effective.some((w) => w.data.category === 'skin')
  const fallback = options.fallbackCategories
  const force = new Set(options.forceRender ?? [])
  const covered = (cat: WearableCategory) =>
    !force.has(cat) && (hasSkin || isHiddenCategory(effective, cat, fallback))

  const hideUpper = covered('upper_body')
  const hideLower = covered('lower_body')
  const hideFeet = covered('feet')
  const hideHead = hasSkin || isHiddenCategory(effective, 'head', fallback)
  const hideHands = isHandsHidden(effective)

  bodyRoot.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh)) return
    // Fallback-attached wearables parent under body bones (inside bodyRoot) and reuse the
    // `*_BaseMesh` naming convention — basemesh hides must only touch the body's own meshes,
    // and the visible reset must not resurrect their pruned junk meshes.
    if (isInsideAttachedWearable(obj, bodyRoot)) return
    obj.visible = true
    const name = obj.name.toLowerCase()
    if (name.endsWith('ubody_basemesh') && hideUpper) obj.visible = false
    if (name.endsWith('lbody_basemesh') && hideLower) obj.visible = false
    if (name.endsWith('feet_basemesh') && hideFeet) obj.visible = false
    if (name.endsWith('head') && hideHead) obj.visible = false
    if (name.endsWith('head_basemesh') && hideHead) obj.visible = false
    if (name.endsWith('mask_eyes') && hideHead) obj.visible = false
    if (name.endsWith('mask_eyebrows') && hideHead) obj.visible = false
    if (name.endsWith('mask_mouth') && hideHead) obj.visible = false
    if (name.endsWith('hands_basemesh') && hideHands) obj.visible = false
    if (name.includes('collider')) obj.visible = false
  })
}
