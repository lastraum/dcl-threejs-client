/** Static landscape props served from `public/landscape/`. */
export const LANDSCAPE_ASSET_BASE = '/landscape/'

/** From ez-tree `public/models/grass.glb` — texture embedded in the GLB. */
export const EZ_TREE_GRASS = {
  glb: `${LANDSCAPE_ASSET_BASE}ez-tree/grass.glb`
} as const

/** Blade tint — rgb(212, 72, 49), matches empty-parcel ground read. */
export const EZ_TREE_GRASS_TINT_RGB = { r: 212, g: 72, b: 49 } as const
export const EZ_TREE_GRASS_TINT_HEX = 0xd44831