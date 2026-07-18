import * as THREE from 'three'
import type { WearableCategory, WearableDefinition } from './types'

type HideTarget = WearableCategory | 'head' | 'hands'

/** Forge `isHidden` — equipped category OR explicit hides/replaces. */
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

export type BodyShapeVisibilityOptions = {
  /**
   * Categories that actually attached a mesh this compose. When set, hide basemesh for a
   * category only if it is in the set (or skin) — so a failed feet attach keeps base feet.
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
  const hasSkin = wearables.some((w) => w.data.category === 'skin')
  const attached = options.attachedCategories
  const force = new Set(options.forceRender ?? [])
  // A category hidden by ANOTHER wearable's hides/replaces hides the base shell even
  // though nothing attached in that slot (e.g. Skeleton Legs hides:["feet"] with no
  // feet equipped). The attach gate below only protects the equipped-but-failed case.
  const hiddenByOthers = (cat: WearableCategory) =>
    !force.has(cat) &&
    wearables.some(
      (w) =>
        w.data.category !== cat &&
        ((w.data.hides?.includes(cat) ?? false) || (w.data.replaces?.includes(cat) ?? false))
    )
  const covered = (cat: WearableCategory) =>
    hasSkin ||
    hiddenByOthers(cat) ||
    (attached ? attached.has(cat) || attached.has('skin') : isHiddenCategory(wearables, cat))

  const hideUpper = covered('upper_body')
  const hideLower = covered('lower_body')
  const hideFeet = covered('feet')
  const hideHead = hasSkin || isHiddenCategory(wearables, 'head')
  const hideHands = isHandsHidden(wearables)

  bodyRoot.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh)) return
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
