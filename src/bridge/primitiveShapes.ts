import * as THREE from 'three'

const PRIMITIVE_SEGMENTS = 24

/** DCL box face order: North, South, East, West, Top, Bottom. */
const DCL_BOX_FACE_TO_THREE = [4, 5, 0, 1, 2, 3]

/**
 * DCL LL, LR, UR, UL → Three.js BoxGeometry vertex index (indexed by Three face 0..5).
 * Winding differs per face — a single global map scrambles textures (180°/mirrored).
 */
const THREE_BOX_FACE_CORNER_TO_THREE: ReadonlyArray<readonly number[]> = [
  [2, 3, 1, 0], // +X east
  [3, 2, 0, 1], // -X west
  [2, 3, 1, 0], // +Y top
  [0, 1, 3, 2], // -Y bottom
  [2, 3, 1, 0], // +Z north
  [3, 2, 0, 1] // -Z south
]

/**
 * Full-tile north + south UVs for a double-sided DCL plane (no custom MeshRenderer uvs).
 *
 * Official corner order (docs.decentraland.org materials / setUVs):
 * - North: lower-left, lower-right, upper-right, upper-left  (BL, BR, TR, TL)
 * - South: lower-right, lower-left, upper-left, upper-right (BR, BL, TL, TR)
 */
const DEFAULT_DCL_PLANE_UVS = [
  // North: docs BL,BR,TR,TL — V=0 at the bottom. NftShape / TextShape / default
  // MeshRenderer planes view +Z (FrontSide). Inverting north to “fix” one
  // Billboard lookAt hung every NFT and canvas plane upside-down.
  0, 0, 1, 0, 1, 1, 0, 1,
  // South (−Z): V inverted so Three BM_ALL lookAt (−Z toward camera) reads upright.
  // Unity Billboard presents +Z/north; we present −Z/south.
  1, 1, 0, 1, 0, 0, 1, 0
]

/**
 * Spatial verts: 0=TL(−X,+Y) 1=TR(+X,+Y) 2=BL(−X,−Y) 3=BR(+X,−Y).
 *
 * DCL docs map BL,BR,TR,TL → [2,3,1,0] and BR,BL,TL,TR → [3,2,0,1].
 *
 * The client reflects DCL +X → Three −X (`dclToThreePos`). MeshRenderer atlas PNGs
 * (Genesis JUMP IN, open/interested buttons) read L–R mirrored under pure docs maps.
 * Corner maps below are docs order with L–R swapped so plane textures match Explorer.
 *
 * TextShape paints its own canvas in Three UV space — it compensates with map U flip
 * in TextShapeSync so glyphs stay L→R under the same geometry.
 *
 * Marquee atlas planes (`buildMarqueePlaneGeometry`) keep their own inward-face U flip.
 */
/** North face: BL, BR, TR, TL → verts (L–R compensated for dcl→Three X). */
const DCL_PLANE_NORTH_CORNER_TO_THREE = [3, 2, 0, 1]

/** South face: BR, BL, TL, TR → verts (L–R compensated). */
const DCL_PLANE_SOUTH_CORNER_TO_THREE = [2, 3, 1, 0]

/** Bump when plane topology/UV layout changes — busts primitiveMeshKey mesh cache. */
const PLANE_GEOMETRY_REVISION = 'v27'

/**
 * userData: marquee atlas plane. MaterialApplier: flipY=false, FrontSide only.
 * Faces inward (normal −Z) so plaza view is the front face — not a mirrored DoubleSide back.
 */
export const DCL_TEXT_ALONG_Y_BASIS = 'dclTextAlongYBasis'

export type PrimitiveMeshSpec = {
  mesh?:
    | { $case: 'box'; box?: { uvs?: number[] } }
    | { $case: 'sphere'; sphere?: Record<string, never> }
    | { $case: 'plane'; plane?: { uvs?: number[] } }
    | { $case: 'cylinder'; cylinder?: { radiusTop?: number; radiusBottom?: number } }
    | undefined
}

function meshRendererUvs(spec: PrimitiveMeshSpec): number[] | undefined {
  const mesh = spec.mesh
  if (mesh?.$case === 'box') return mesh.box?.uvs
  if (mesh?.$case === 'plane') return mesh.plane?.uvs
  return undefined
}

function uvsFingerprint(uvs?: number[]): string {
  if (!uvs?.length) return ''
  return uvs.join(',')
}

/**
 * Build a **private** geometry (caller owns dispose). Prefer {@link acquirePrimitiveGeometry}
 * for static MeshRenderers so 10k+ boards share one BufferGeometry per key.
 */
export function buildPrimitiveGeometry(spec: PrimitiveMeshSpec): THREE.BufferGeometry {
  const kind = spec.mesh?.$case ?? 'box'

  if (kind === 'sphere') {
    return new THREE.SphereGeometry(0.5, PRIMITIVE_SEGMENTS, PRIMITIVE_SEGMENTS)
  }

  if (kind === 'plane') {
    const uvs = spec.mesh?.$case === 'plane' ? spec.mesh.plane?.uvs : undefined
    if (uvs?.length) return buildPlaneGeometryWithUvs(uvs)
    // DCL planes are double-sided with distinct back-face UVs (not Three.js PlaneGeometry + DoubleSide).
    return buildPlaneGeometryWithUvs(DEFAULT_DCL_PLANE_UVS)
  }

  if (kind === 'cylinder') {
    const cyl = spec.mesh?.$case === 'cylinder' ? spec.mesh.cylinder : undefined
    const radiusTop = cyl?.radiusTop ?? 0.5
    const radiusBottom = cyl?.radiusBottom ?? 0.5
    return new THREE.CylinderGeometry(radiusTop, radiusBottom, 1, PRIMITIVE_SEGMENTS)
  }

  const geometry = new THREE.BoxGeometry(1, 1, 1)
  const uvs = spec.mesh?.$case === 'box' ? spec.mesh.box?.uvs : undefined
  if (uvs?.length) applyBoxUvs(geometry, uvs)
  return geometry
}

const PRIMITIVE_GEO_POOL_KEY = 'dclPrimitiveGeoPoolKey'
const primitiveGeoPool = new Map<string, { geo: THREE.BufferGeometry; refs: number }>()

/**
 * Shared geometry for static MeshRenderers with stable UVs.
 * Animated UV sprites (flipbooks) always get a private geo — they mutate UV attrs in place.
 */
export function acquirePrimitiveGeometry(spec: PrimitiveMeshSpec): THREE.BufferGeometry {
  // In-place UV animation must not share geometry across entities.
  if (hasAnimatedPlaneUvs(spec)) {
    const geo = buildPrimitiveGeometry(spec)
    geo.userData[PRIMITIVE_GEO_POOL_KEY] = ''
    return geo
  }
  const key = primitiveMeshKey(spec)
  let entry = primitiveGeoPool.get(key)
  if (!entry) {
    const geo = buildPrimitiveGeometry(spec)
    geo.userData[PRIMITIVE_GEO_POOL_KEY] = key
    entry = { geo, refs: 0 }
    primitiveGeoPool.set(key, entry)
  }
  entry.refs++
  return entry.geo
}

/** Release a geometry from {@link acquirePrimitiveGeometry}. No-op-safe for foreign geos. */
export function releasePrimitiveGeometry(geometry: THREE.BufferGeometry | null | undefined): void {
  if (!geometry) return
  const key = geometry.userData[PRIMITIVE_GEO_POOL_KEY] as string | undefined
  if (key === undefined) {
    geometry.dispose()
    return
  }
  // Private non-pooled (animated UV): marked with empty key.
  if (key === '') {
    geometry.dispose()
    return
  }
  const entry = primitiveGeoPool.get(key)
  if (!entry || entry.geo !== geometry) {
    geometry.dispose()
    return
  }
  entry.refs = Math.max(0, entry.refs - 1)
  if (entry.refs === 0) {
    primitiveGeoPool.delete(key)
    entry.geo.dispose()
  }
}

/** Plane with custom MeshRenderer UVs — campfire sprite pool + billboards. */
export function hasAnimatedPlaneUvs(spec: PrimitiveMeshSpec): boolean {
  const uvs = spec.mesh?.$case === 'plane' ? spec.mesh.plane?.uvs : undefined
  return (uvs?.length ?? 0) >= 8
}

export function primitiveMeshKey(spec: PrimitiveMeshSpec): string {
  const kind = primitiveKind(spec)
  const uvsKey = uvsFingerprint(meshRendererUvs(spec))
  if (kind === 'plane') {
    return uvsKey ? `${kind}:${uvsKey}:${PLANE_GEOMETRY_REVISION}` : `${kind}:${PLANE_GEOMETRY_REVISION}`
  }
  return uvsKey ? `${kind}:${uvsKey}` : kind
}

/** Planes use true double-sided geometry (north + south faces) — material stays FrontSide. */
export function primitiveDoubleSided(_spec: PrimitiveMeshSpec): boolean {
  return false
}

export function primitiveKind(spec: PrimitiveMeshSpec): string {
  const mesh = spec.mesh
  if (!mesh || mesh.$case === 'box' || mesh.$case === 'sphere' || mesh.$case === 'plane') {
    return mesh?.$case ?? 'box'
  }
  const { radiusTop = 0.5, radiusBottom = 0.5 } = mesh.cylinder ?? {}
  return `cylinder:${radiusTop}:${radiusBottom}`
}

function applyFaceUvs(
  attr: THREE.BufferAttribute,
  faceIndex: number,
  cornerMap: readonly number[],
  uvs: readonly number[],
  srcOffset = 0
): void {
  const base = faceIndex * 4
  for (let corner = 0; corner < 4; corner++) {
    const vert = cornerMap[corner] ?? corner
    attr.setXY(base + vert, uvs[srcOffset + corner * 2] ?? 0, uvs[srcOffset + corner * 2 + 1] ?? 0)
  }
}

function applyBoxUvs(geometry: THREE.BufferGeometry, uvs: number[]): void {
  const perFace = uvs.length >= 96 ? 16 : uvs.length >= 48 ? 8 : 0
  if (!perFace) return

  const attr = geometry.getAttribute('uv')
  if (!(attr instanceof THREE.BufferAttribute) || attr.count < 24) return

  for (let dclFace = 0; dclFace < 6; dclFace++) {
    const threeFace = DCL_BOX_FACE_TO_THREE[dclFace] ?? dclFace
    const cornerMap = THREE_BOX_FACE_CORNER_TO_THREE[threeFace] ?? THREE_BOX_FACE_CORNER_TO_THREE[4]!
    applyFaceUvs(attr, threeFace, cornerMap, uvs, dclFace * perFace)
  }
  attr.needsUpdate = true
}

/**
 * DCL double-sided plane (north +Z, south -Z) scaled to world units.
 * Shared by MeshRenderer planes, TextShape canvas, NFT frames, etc. — docs UV order.
 */
export function buildDclPlaneGeometry(width = 1, height = 1): THREE.BufferGeometry {
  const geometry = buildPlaneGeometryWithUvs(DEFAULT_DCL_PLANE_UVS)
  if (width !== 1 || height !== 1) {
    geometry.scale(width, height, 1)
  }
  return geometry
}

/** @deprecated Use {@link buildDclPlaneGeometry} — same docs-order dual-face plane. */
export function buildTextShapePlaneGeometry(width = 1, height = 1): THREE.BufferGeometry {
  return buildDclPlaneGeometry(width, height)
}

/**
 * Docs north packing is BL, BR, TR, TL (first edge horizontal in UV).
 * Flipbook sprites (Genesis firepit, etc.) often emit BL, TL, TR, BR (first edge
 * vertical). Without reordering, corner maps scramble atlas frames and marquee
 * detection false-positives (rewrites fire as inward text planes).
 */
function normalizeNorthPlaneUvs(uvs: readonly number[]): number[] {
  if (uvs.length < 8) return Array.from(uvs)
  const du01 = Math.abs((uvs[2] ?? 0) - (uvs[0] ?? 0))
  const dv01 = Math.abs((uvs[3] ?? 0) - (uvs[1] ?? 0))
  if (dv01 <= du01 + 1e-5) {
    return [uvs[0]!, uvs[1]!, uvs[2]!, uvs[3]!, uvs[4]!, uvs[5]!, uvs[6]!, uvs[7]!]
  }
  // BL,TL,TR,BR → BL,BR,TR,TL
  return [uvs[0]!, uvs[1]!, uvs[6]!, uvs[7]!, uvs[4]!, uvs[5]!, uvs[2]!, uvs[3]!]
}

/**
 * True when MeshRenderer UVs are a plaza LED marquee slice (uvAnimWords).
 *
 * Must run on **raw** scene UVs — never after {@link normalizeNorthPlaneUvs}.
 * Marquees author docs BL,BR,TR,TL with UV axis swap (U/text along local Y, V along X).
 * `normalizeNorthPlaneUvs` treats the vertical first edge as flipbook packing and
 * destroys the axis swap → dual-face path → classic “split + mirrored” LED text.
 *
 * Discrimination vs flipbooks / atlas buttons (M4e JUMP IN):
 * - Axis swap on north (V along BL→BR, U along BL→TL)
 * - Full 16 UV floats with south U ≈ 1 − north U at each corner (same V)
 * Flipbooks are usually 8 UVs; atlas buttons use different south packing (not 1−U).
 * UV cell aspect alone fails: plaza LED segments are short (U span ~0.15 < V ~0.21).
 */
function planeUvsMapTextAlongLocalY(rawUvs: readonly number[]): boolean {
  if (rawUvs.length < 8) return false
  const n = rawUvs
  // BL→BR (local +X)
  const duX = Math.abs((n[2] ?? 0) - (n[0] ?? 0))
  const dvX = Math.abs((n[3] ?? 0) - (n[1] ?? 0))
  // BL→TL (local +Y) — docs packing TL is indices 6,7
  const duY = Math.abs((n[6] ?? 0) - (n[0] ?? 0))
  const dvY = Math.abs((n[7] ?? 0) - (n[1] ?? 0))
  // Axis swap: V along local X, U along local Y
  if (!(dvX > duX + 1e-5 && duY > dvY + 1e-5)) return false

  // Marquee dual-face: south mirrors north in U only (Genesis uvAnimWords).
  if (rawUvs.length < 16) return false
  for (let i = 0; i < 8; i += 2) {
    const nU = n[i] ?? 0
    const nV = n[i + 1] ?? 0
    const sU = rawUvs[8 + i] ?? 0
    const sV = rawUvs[8 + i + 1] ?? 0
    if (Math.abs(sU - (1 - nU)) > 0.02) return false
    if (Math.abs(sV - nV) > 0.02) return false
  }
  return true
}

/**
 * Build south-face UVs (BR, BL, TL, TR) from north (BL, BR, TR, TL) with U mirrored.
 * Matches docs south packing (BR, BL, TL, TR) with U mirrored so both faces read L→R.
 * Default full-tile south (16-float DEFAULT) also inverts V for BM_ALL lookAt.
 */
function mirrorSouthPlaneUvs(north: readonly number[]): number[] {
  const blU = north[0] ?? 0
  const blV = north[1] ?? 0
  const brU = north[2] ?? 0
  const brV = north[3] ?? 0
  const trU = north[4] ?? 0
  const trV = north[5] ?? 0
  const tlU = north[6] ?? 0
  const tlV = north[7] ?? 0
  // South corner order BR, BL, TL, TR — U mirrored so both faces read correctly.
  return [1 - blU, blV, 1 - brU, brV, 1 - trU, trV, 1 - tlU, tlV]
}

/**
 * Marquee / text-along-Y plane.
 *
 * Scene north UVs (BL,BR,TR,TL): U (text) along local Y, V along local X.
 * We rewrite to standard: U along X, V along Y.
 *
 * Plaza panels mount with local +Z *outward*. Camera is inside the plaza, so it sees the
 * **back** of a +Z plane. DoubleSide then shows a mirrored back face → “split + mirrored”.
 *
 * Fix: face **inward** (normal −Z, winding for that front) + FrontSide only + U flip so
 * text still reads left→right when viewed from the plaza.
 *
 * PlaneGeometry verts: 0=TL (−X,+Y) 1=TR (+X,+Y) 2=BL (−X,−Y) 3=BR (+X,−Y).
 */
function buildMarqueePlaneGeometry(north: readonly number[]): THREE.BufferGeometry {
  const u0 = north[0] ?? 0 // text start
  const vA = north[1] ?? 0
  const vB = north[3] ?? 0
  const u1 = north[6] ?? 0 // text end
  const vTop = Math.min(vA, vB)
  const vBot = Math.max(vA, vB)

  // Dual-face (Explorer MeshRenderer plane). Single inward FrontSide vanished
  // when a facade's +Z already faced the street (Updates / uvAnimWords).
  // −Z inward + +Z outward, U flipped on +X so both sides read L→R.
  const positions = new Float32Array([
    -0.5, 0.5, 0, 0.5, 0.5, 0, -0.5, -0.5, 0, 0.5, -0.5, 0,
    -0.5, 0.5, 0, 0.5, 0.5, 0, -0.5, -0.5, 0, 0.5, -0.5, 0
  ])
  const normals = new Float32Array([
    0, 0, -1, 0, 0, -1, 0, 0, -1, 0, 0, -1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1
  ])
  const uvs = new Float32Array([
    u1, vTop, u0, vTop, u1, vBot, u0, vBot,
    u0, vTop, u1, vTop, u0, vBot, u1, vBot
  ])
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3))
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2))
  geometry.setIndex([0, 1, 2, 1, 3, 2, 4, 6, 5, 5, 6, 7])
  geometry.userData[DCL_TEXT_ALONG_Y_BASIS] = true
  return geometry
}

function buildPlaneGeometryWithUvs(uvs: number[]): THREE.BufferGeometry {
  const perSide = uvs.length >= 16 ? 8 : uvs.length >= 8 ? 8 : 0
  if (!perSide) return buildPlaneGeometryWithUvs(DEFAULT_DCL_PLANE_UVS)

  // Marquee: classify on raw UVs before normalize (normalize destroys axis swap).
  if (planeUvsMapTextAlongLocalY(uvs)) {
    return buildMarqueePlaneGeometry(uvs.slice(0, 8))
  }

  const north = normalizeNorthPlaneUvs(uvs.slice(0, 8))

  // Flipbook sprites usually send 8 UVs (north only); south is mirrored.
  // When 16 are authored, normalize the second face the same way then pack as south.
  const south =
    uvs.length >= 16
      ? northStyleToSouthPacking(normalizeNorthPlaneUvs(uvs.slice(8, 16)))
      : mirrorSouthPlaneUvs(north)

  const positions = new Float32Array([
    -0.5, 0.5, 0, 0.5, 0.5, 0, -0.5, -0.5, 0, 0.5, -0.5, 0,
    -0.5, 0.5, 0, 0.5, 0.5, 0, -0.5, -0.5, 0, 0.5, -0.5, 0
  ])
  const normals = new Float32Array([
    0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, -1, 0, 0, -1, 0, 0, -1, 0, 0, -1
  ])
  const uvAttr = new THREE.BufferAttribute(new Float32Array(16), 2)
  applyFaceUvs(uvAttr, 0, DCL_PLANE_NORTH_CORNER_TO_THREE, north)
  applyFaceUvs(uvAttr, 1, DCL_PLANE_SOUTH_CORNER_TO_THREE, south)

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3))
  geometry.setAttribute('uv', uvAttr)
  geometry.setIndex([0, 2, 1, 2, 3, 1, 4, 5, 6, 5, 7, 6])
  return geometry
}

/** Docs north BL,BR,TR,TL → south BR,BL,TL,TR (same corners, south winding). */
function northStyleToSouthPacking(north: readonly number[]): number[] {
  return [
    north[2]!,
    north[3]!,
    north[0]!,
    north[1]!,
    north[6]!,
    north[7]!,
    north[4]!,
    north[5]!
  ]
}

/**
 * In-place UV update for sprite / flipbook planes.
 * Marquee single-face atlas: update the 4 UVs in place (same remap as build).
 */
export function updatePlaneGeometryUvs(geometry: THREE.BufferGeometry, uvs: number[]): boolean {
  const perSide = uvs.length >= 16 ? 8 : uvs.length >= 8 ? 8 : 0
  if (!perSide) return false

  const attr = geometry.getAttribute('uv')
  if (!(attr instanceof THREE.BufferAttribute)) return false

  // Marquee single-face (4 verts) — keep materials, only rewrite atlas window.
  if (geometry.userData[DCL_TEXT_ALONG_Y_BASIS] || planeUvsMapTextAlongLocalY(uvs)) {
    if (attr.count < 4) return false
    const north = uvs.slice(0, 8)
    const u0 = north[0] ?? 0
    const vA = north[1] ?? 0
    const vB = north[3] ?? 0
    const u1 = north[6] ?? 0
    const vTop = Math.min(vA, vB)
    const vBot = Math.max(vA, vB)
    attr.setXY(0, u1, vTop) // −Z TL
    attr.setXY(1, u0, vTop)
    attr.setXY(2, u1, vBot)
    attr.setXY(3, u0, vBot)
    if (attr.count >= 8) {
      attr.setXY(4, u0, vTop) // +Z TL (U flipped)
      attr.setXY(5, u1, vTop)
      attr.setXY(6, u0, vBot)
      attr.setXY(7, u1, vBot)
    }
    attr.needsUpdate = true
    geometry.userData[DCL_TEXT_ALONG_Y_BASIS] = true
    return true
  }

  if (attr.count < 8) return false

  const north = normalizeNorthPlaneUvs(uvs.slice(0, 8))
  const south =
    uvs.length >= 16
      ? northStyleToSouthPacking(normalizeNorthPlaneUvs(uvs.slice(8, 16)))
      : mirrorSouthPlaneUvs(north)
  applyFaceUvs(attr, 0, DCL_PLANE_NORTH_CORNER_TO_THREE, north)
  applyFaceUvs(attr, 1, DCL_PLANE_SOUTH_CORNER_TO_THREE, south)
  attr.needsUpdate = true
  return true
}
