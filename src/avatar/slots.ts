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

/** Minimal shape needed to resolve hides — full definitions and backpack metadata both fit. */
export type HideSource = {
  category: WearableCategory | 'unknown'
  hides?: string[]
  replaces?: string[]
}

function getHides(entry: HideSource): WearableCategory[] {
  const category = entry.category
  const replaced = entry.replaces ?? []
  // Copy before extending — pushing onto wearable.data.hides mutated cached definitions.
  const hidden = [...(entry.hides ?? [])]
  if (category === 'skin') hidden.push(...categoriesHiddenBySkin)
  return Array.from(new Set([...replaced, ...hidden])).filter((c) => c !== category) as WearableCategory[]
}

/**
 * ADR-239 hide resolution: walk categories by priority; an equipped wearable hides its
 * declared categories unless a higher-priority wearable already hid the wearer itself.
 * Returns hidden category → the category that hid it (first hider by priority wins).
 * forceRender is NOT applied here — callers decide whether an override un-hides, so the
 * backpack UI can still show WHO hides a force-rendered slot.
 */
export function computeHiddenBy(
  equipped: Iterable<HideSource>
): Map<WearableCategory, WearableCategory> {
  const byCategory = new Map<WearableCategory, HideSource>()
  for (const entry of equipped) {
    if (entry.category !== 'unknown') byCategory.set(entry.category, entry)
  }

  const hiddenBy = new Map<WearableCategory, WearableCategory>()
  for (const category of categoriesPriority) {
    const entry = byCategory.get(category)
    if (!entry || hiddenBy.has(category)) continue
    for (const slot of getHides(entry)) {
      if (!hiddenBy.has(slot)) hiddenBy.set(slot, category)
    }
  }
  return hiddenBy
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

  const hiddenBy = computeHiddenBy(
    Array.from(slots.entries()).map(([category, w]) => ({
      category,
      hides: w.data.hides,
      replaces: w.data.replaces
    }))
  )

  for (const category of hiddenBy.keys()) {
    if (!config.forceRender.includes(category)) slots.delete(category)
  }

  return slots
}

export function isModelWearable(w: WearableDefinition): boolean {
  return w.data.category !== 'eyes' && w.data.category !== 'eyebrows' && w.data.category !== 'mouth'
}
