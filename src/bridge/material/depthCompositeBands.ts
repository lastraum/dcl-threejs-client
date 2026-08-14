/**
 * Platform depth / transparent composite bands (client-wide).
 *
 * Three.js `renderOrder` is local within the transparent or opaque pass.
 * Bands are material-mode laws — never scene-name forks.
 *
 * @see docs/FRAME_PIPELINE_COD.md § depth composite
 */

/** Opaque / alpha-test solids (default). */
export const DEPTH_BAND_OPAQUE_SOLID = 0

/**
 * ALPHA_BLEND surfaces that still occlude (fog covers, tinted planes, glass-ish boards).
 * Drawn after opaques; depthWrite policy is mode-stable (see MaterialApplier).
 */
export const DEPTH_BAND_BLEND_SURFACE = 10

/**
 * Map-less high-emissive markers (click rings, selection discs).
 * depthWrite=false; must paint after blend covers.
 */
export const DEPTH_BAND_MARKER_GLOW = 50

/**
 * Polygon offset for small coplanar MeshRenderer plates (not large cover tiles).
 * Values match long-standing ThreeBridge bias (stable under top-down VC).
 */
export const PLANE_POLYGON_OFFSET_FACTOR = 1
export const PLANE_POLYGON_OFFSET_UNITS = 1
