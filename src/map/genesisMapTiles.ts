/** Genesis City map tile constants — aligned with dcl-neurolink/server/decentraland. */
export const GENESIS_TILE_PAD = 30
export const GENESIS_MAX_ZOOM = 6
/**
 * Zoomed tile JPG base URL (`{base}/{z}/{tx},{ty}.jpg`).
 *
 * Prefer GitHub LFS media: `genesis.city` is often deployed on Netlify with a
 * cert CN of `*.netlify.app` only → browsers throw ERR_CERT_COMMON_NAME_INVALID.
 * Override with `VITE_GENESIS_TILE_BASE_URL` when their TLS is fixed or you self-host.
 */
export const GENESIS_TILE_BASE_URL = (
  import.meta.env.VITE_GENESIS_TILE_BASE_URL?.trim() ||
  'https://media.githubusercontent.com/media/genesis-city/genesis.city/master/map/latest'
).replace(/\/+$/, '')
export const MAP_TILE_FETCH_ZOOM = 4
export const TILE_DISPLAY_PX = 160
