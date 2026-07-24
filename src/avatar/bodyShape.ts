import * as THREE from 'three'
import { isModelWearable } from './slots'
import type { WearableCategory, WearableDefinition } from './types'

type HideTarget = WearableCategory | 'head' | 'hands'

/**
 * Equipped category OR explicit hides/replaces — Explorer / Forge rule.
 * Same-category auto-hide applies so base underwear is covered under jeans, etc.
 */
function isHiddenByWearable(wearable: WearableDefinition, target: HideTarget): boolean {
  if (target === 'head') {
    return wearable.data.hides?.includes('head') || wearable.data.replaces?.includes('head') || false
  }
  if (target === 'hands') return false
  return (
    wearable.data.category === target ||
    wearable.data.hides?.includes(target) ||
    wearable.data.replaces?.includes(target) ||
    false
  )
}

function isHiddenCategory(wearables: WearableDefinition[], target: HideTarget): boolean {
  return wearables.some((w) => isHiddenByWearable(w, target))
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
 * True when the mesh belongs to a wearable GLB parented under bodyRoot
 * (`wearable:<category>` roots). Basemesh hide rules must not touch those meshes —
 * DCL wearables often reuse `*_BaseMesh` naming.
 */
function isInsideAttachedWearable(obj: THREE.Object3D, bodyRoot: THREE.Object3D): boolean {
  for (let p: THREE.Object3D | null = obj; p && p !== bodyRoot; p = p.parent) {
    if (p.name.startsWith('wearable:')) return true
  }
  return false
}

export type BodyShapeVisibilityOptions = {
  /**
   * Categories that actually attached a mesh this compose. When set, a wearable's
   * hides/replaces (and own-slot coverage) only count if it attached — so a failed
   * feet attach keeps base feet. Texture-only categories always count.
   */
  attachedCategories?: ReadonlySet<WearableCategory>
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
  // Hides only count once mesh attached. body_shape + texture slots (eyes/brows/mouth)
  // never attach as model layers — always keep them in the effective set.
  const effective = attached
    ? wearables.filter(
        (w) =>
          w.data.category === 'body_shape' ||
          !isModelWearable(w) ||
          attached.has(w.data.category)
      )
    : wearables
  const hasSkin = effective.some((w) => w.data.category === 'skin')
  const force = new Set(options.forceRender ?? [])

  const covered = (cat: WearableCategory) =>
    !force.has(cat) && (hasSkin || isHiddenCategory(effective, cat))

  const hideUpper = covered('upper_body')
  const hideLower = covered('lower_body')
  const hideFeet = covered('feet')
  const hideHead = hasSkin || isHiddenCategory(effective, 'head')
  const hideHands = isHandsHidden(effective)

  bodyRoot.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh)) return
    // Wearable layers under bodyRoot can share basemesh names — never hide/reset them here.
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
