import type { Layers, Object3D } from 'three'

/** Buildings, GLBs, terrain, MeshRenderer primitives, roads, scene props. */
export const DRAW_LAYER_WORLD = 0
/** Local + remote avatars (bodies, wearables). */
export const DRAW_LAYER_AVATAR = 1
/** AbilityManager / ShaderManager / particles / decals / fissures / bursts. */
export const DRAW_LAYER_SFX = 2

/** Bits 0+1+2 — default when a tjs camera omits `layers`. */
export const DRAW_LAYER_MASK_ALL =
  (1 << DRAW_LAYER_WORLD) | (1 << DRAW_LAYER_AVATAR) | (1 << DRAW_LAYER_SFX)

type Layered = { layers: Layers }

/** Put an object and all descendants on a single draw bit. */
export function setLayer(obj: Object3D, bit: number): void {
  obj.traverse((node) => node.layers.set(bit))
}

/** Main / preview cameras: see world + avatar + SFX. Additive — does not clear other bits. */
export function enableDrawLayers(obj: Layered): void {
  obj.layers.enable(DRAW_LAYER_WORLD)
  obj.layers.enable(DRAW_LAYER_AVATAR)
  obj.layers.enable(DRAW_LAYER_SFX)
}

/** Pointer / scene-ray picking: world + avatars, not SFX. */
export function enablePickLayers(obj: Layered): void {
  obj.layers.disableAll()
  obj.layers.enable(DRAW_LAYER_WORLD)
  obj.layers.enable(DRAW_LAYER_AVATAR)
}

/**
 * Parse tjs `layers` string. Official tokens are "0","1","2" (comma-separated).
 * Omit / empty → all three. Unknown tokens ignored. Name aliases are fallback only.
 */
export function parseDrawLayersString(raw: string | undefined | null): number {
  const s = (raw ?? '').trim()
  if (!s) return DRAW_LAYER_MASK_ALL
  let mask = 0
  let any = false
  for (const part of s.split(',')) {
    const tok = part.trim().toLowerCase()
    if (!tok) continue
    const bit = tokenToDrawBit(tok)
    if (bit < 0) continue
    mask |= 1 << bit
    any = true
  }
  return any ? mask : DRAW_LAYER_MASK_ALL
}

function tokenToDrawBit(tok: string): number {
  if (tok === '0' || tok === 'world') return DRAW_LAYER_WORLD
  if (tok === '1' || tok === 'avatar' || tok === 'avatars') return DRAW_LAYER_AVATAR
  if (tok === '2' || tok === 'sfx' || tok === 'vfx') return DRAW_LAYER_SFX
  return -1
}

/** Wall / CCTV PerspectiveCamera — apply tjs `layers` every sync. */
export function applyCameraDrawLayers(cam: Layered, raw: string | undefined | null): void {
  const mask = parseDrawLayersString(raw)
  cam.layers.disableAll()
  if (mask & (1 << DRAW_LAYER_WORLD)) cam.layers.enable(DRAW_LAYER_WORLD)
  if (mask & (1 << DRAW_LAYER_AVATAR)) cam.layers.enable(DRAW_LAYER_AVATAR)
  if (mask & (1 << DRAW_LAYER_SFX)) cam.layers.enable(DRAW_LAYER_SFX)
}
