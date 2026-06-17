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

/** Hide body_shape basemesh parts when wearables cover them — ported from Forge `body.ts`. */
export function applyBodyShapeVisibility(bodyRoot: THREE.Object3D, wearables: WearableDefinition[]): void {
  const hasSkin = wearables.some((w) => w.data.category === 'skin')
  const hideUpper = hasSkin || isHiddenCategory(wearables, 'upper_body')
  const hideLower = hasSkin || isHiddenCategory(wearables, 'lower_body')
  const hideFeet = hasSkin || isHiddenCategory(wearables, 'feet')
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
