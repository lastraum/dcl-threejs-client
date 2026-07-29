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
  0, 0, 1, 0, 1, 1, 0, 1,
  1, 0, 0, 0, 0, 1, 1, 1
]

/**
 * Spatial verts: 0=TL(−X,+Y) 1=TR(+X,+Y) 2=BL(−X,−Y) 3=BR(+X,−Y).
 *
 * DCL docs map BL,BR,TR,TL → [2,3,1,0] (north) and BR,BL,TL,TR → [3,2,0,1] (south).
 *
 * A prior L-R corner swap (v19) tried to compensate for `dclToThree` X reflection so
 * MeshRenderer textures would match Explorer. It inverted every player-facing plane with
 * readable content: TextShape canvas labels, and MeshRenderer button/label PNGs
 * (e.g. Dead Surge BACK/NEXT pills showed as KCAB/TXEN). Entity transforms already go
 * through `dclToThreePos`/`dclToThreeQuat`; UVs stay in docs order so authored textures
 * and client-rasterized glyphs share one reading direction.
 *
 * Marquee atlas planes (`buildMarqueePlaneGeometry`) keep their own inward-face U flip.
 */
/** North face: BL, BR, TR, TL → spatial verts (DCL docs order). */
const DCL_PLANE_NORTH_CORNER_TO_THREE = [2, 3, 1, 0]

/** South face: BR, BL, TL, TR → spatial verts (DCL docs order). */
const DCL_PLANE_SOUTH_CORNER_TO_THREE = [3, 2, 0, 1]

/** Bump when plane topology/UV layout changes — busts primitiveMeshKey mesh cache. */
/** v22: south-face atlas U flip is span-relative (JUMP IN button). */
const PLANE_GEOMETRY_REVISION = 'v22'

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
 * True when atlas U (text) runs along plane local Y (plaza LED marquees).
 * UVs must already be docs-ordered (BL,BR,TR,TL). Require a full axis swap:
 * bottom edge (BL→BR / local +X) is mostly V, and left edge (BL→TL / local +Y)
 * is mostly U.
 *
 * Flipbook sprites (fishing splash sheets, campfire) often use the same axis
 * swap for a near-square cell — those must stay on the in-place UV path. Full
 * mesh rebuild every frame clears materials and makes splash look intermittent.
 * Marquees are long thin strips (U along Y >> V along X).
 */
function planeUvsMapTextAlongLocalY(uvs: readonly number[]): boolean {
  // BL→BR (local +X)
  const duX = Math.abs((uvs[2] ?? 0) - (uvs[0] ?? 0))
  const dvX = Math.abs((uvs[3] ?? 0) - (uvs[1] ?? 0))
  // BL→TL (local +Y) — docs packing TL is indices 6,7
  const duY = Math.abs((uvs[6] ?? 0) - (uvs[0] ?? 0))
  const dvY = Math.abs((uvs[7] ?? 0) - (uvs[1] ?? 0))
  // Axis swap: V along local X, U along local Y
  if (!(dvX > duX + 1e-5 && duY > dvY + 1e-5)) return false
  // Long text strip vs square flipbook cell (stepU ≈ stepV ≈ 1/N)
  const textSpan = duY
  const rowThickness = dvX
  return textSpan > rowThickness * 2.5 + 1e-5
}

/**
 * Build south-face UVs (BR, BL, TL, TR) from north (BL, BR, TR, TL) with U mirrored
 * **within the north U span**.
 *
 * Full-tile north (0–1) → south 1,0, 0,0, 0,1, 1,1 (DEFAULT_DCL_PLANE_UVS).
 * Atlas sub-rects (JUMP IN `jump_in_btn.png` in a sheet) must NOT use absolute `1−u`
 * — that samples the opposite side of the atlas (solid “bg” + mirrored glyphs).
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
  const umin = Math.min(blU, brU, trU, tlU)
  const umax = Math.max(blU, brU, trU, tlU)
  const flipU = (u: number) => umin + umax - u
  // South corner order BR, BL, TL, TR — U mirrored in-span so both faces read L→R.
  return [
    flipU(blU),
    blV,
    flipU(brU),
    brV,
    flipU(trU),
    trV,
    flipU(tlU),
    tlV
  ]
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

  const geometry = new THREE.PlaneGeometry(1, 1)
  const normals = geometry.getAttribute('normal')
  const uv = geometry.getAttribute('uv')
  if (!(normals instanceof THREE.BufferAttribute) || !(uv instanceof THREE.BufferAttribute)) {
    return geometry
  }

  // Inward front face (toward plaza / camera).
  for (let i = 0; i < normals.count; i++) normals.setXYZ(i, 0, 0, -1)
  normals.needsUpdate = true
  // CCW when viewed from −Z (front).
  geometry.setIndex([0, 1, 2, 1, 3, 2])

  // From −Z, local +X is screen-left → text start (u0) on +X (TR/BR).
  uv.setXY(0, u1, vTop) // TL −X
  uv.setXY(1, u0, vTop) // TR +X
  uv.setXY(2, u1, vBot) // BL −X
  uv.setXY(3, u0, vBot) // BR +X
  uv.needsUpdate = true

  geometry.userData[DCL_TEXT_ALONG_Y_BASIS] = true
  return geometry
}

function buildPlaneGeometryWithUvs(uvs: number[]): THREE.BufferGeometry {
  const perSide = uvs.length >= 16 ? 8 : uvs.length >= 8 ? 8 : 0
  if (!perSide) return buildPlaneGeometryWithUvs(DEFAULT_DCL_PLANE_UVS)

  const north = normalizeNorthPlaneUvs(uvs.slice(0, 8))
  if (planeUvsMapTextAlongLocalY(north)) {
    return buildMarqueePlaneGeometry(north)
  }

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
 * In-place UV update for sprite planes only.
 * Marquee always returns false → force full mesh rebuild.
 */
export function updatePlaneGeometryUvs(geometry: THREE.BufferGeometry, uvs: number[]): boolean {
  const perSide = uvs.length >= 16 ? 8 : uvs.length >= 8 ? 8 : 0
  if (!perSide) return false

  const north = normalizeNorthPlaneUvs(uvs.slice(0, 8))
  if (planeUvsMapTextAlongLocalY(north) || geometry.userData[DCL_TEXT_ALONG_Y_BASIS]) {
    return false
  }

  const attr = geometry.getAttribute('uv')
  if (!(attr instanceof THREE.BufferAttribute) || attr.count < 8) return false

  const south =
    uvs.length >= 16
      ? northStyleToSouthPacking(normalizeNorthPlaneUvs(uvs.slice(8, 16)))
      : mirrorSouthPlaneUvs(north)
  applyFaceUvs(attr, 0, DCL_PLANE_NORTH_CORNER_TO_THREE, north)
  applyFaceUvs(attr, 1, DCL_PLANE_SOUTH_CORNER_TO_THREE, south)
  attr.needsUpdate = true
  return true
}
