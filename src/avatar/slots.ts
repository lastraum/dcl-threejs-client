import type { AvatarComposeConfig, WearableCategory, WearableDefinition } from './types'
import { hasRepresentation } from './peerApi'

const categoriesHiddenBySkin: WearableCategory[] = [
  'helmet',
  'hair',
  'facial_hair',
  'mouth',
  'eyebrows',
  'eyes',
  'upper_body',
  'lower_body',
  'feet',
  'hands_wear'
]

const categoriesPriority: WearableCategory[] = [
  'skin',
  'upper_body',
  'hands_wear',
  'lower_body',
  'feet',
  'helmet',
  'hat',
  'top_head',
  'mask',
  'eyewear',
  'earring',
  'tiara',
  'hair',
  'eyebrows',
  'eyes',
  'mouth',
  'facial_hair',
  'body_shape'
]

function getHides(wearable: WearableDefinition): WearableCategory[] {
  const category = wearable.data.category
  const replaced = wearable.data.replaces ?? []
  const hidden = wearable.data.hides ?? []
  if (category === 'skin') hidden.push(...categoriesHiddenBySkin)
  return Array.from(new Set([...replaced, ...hidden])).filter((c) => c !== category) as WearableCategory[]
}

/** ADR-239 slot resolution — ported from Forge `babylon/slots.ts`. */
export function getSlots(config: {
  bodyShape: AvatarComposeConfig['bodyShape']
  wearables: WearableDefinition[]
  forceRender: string[]
}): Map<WearableCategory, WearableDefinition> {
  const slots = new Map<WearableCategory, WearableDefinition>()

  for (const wearable of config.wearables) {
    const slot = wearable.data.category
    if (hasRepresentation(wearable, config.bodyShape)) {
      slots.set(slot, wearable)
    }
  }

  const alreadyRemoved = new Set<WearableCategory>()
  for (const category of categoriesPriority) {
    const wearable = slots.get(category)
    if (!wearable || alreadyRemoved.has(category)) continue
    for (const slot of getHides(wearable)) alreadyRemoved.add(slot)
  }

  const toHide = Array.from(alreadyRemoved).filter((c) => !config.forceRender.includes(c))
  for (const category of toHide) slots.delete(category)

  return slots
}

export function isModelWearable(w: WearableDefinition): boolean {
  return w.data.category !== 'eyes' && w.data.category !== 'eyebrows' && w.data.category !== 'mouth'
}
