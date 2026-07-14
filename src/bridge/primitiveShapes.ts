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

/** North face: BL, BR, TR, TL → spatial vertex index. */
const DCL_PLANE_NORTH_CORNER_TO_THREE = [2, 3, 1, 0]

/** South face: BR, BL, TL, TR → spatial vertex index (docs order, not north mirrored). */
const DCL_PLANE_SOUTH_CORNER_TO_THREE = [3, 2, 0, 1]

/** Bump when plane topology/UV layout changes — busts primitiveMeshKey mesh cache. */
const PLANE_GEOMETRY_REVISION = 'v5'

/** userData key: plane re-based so atlas U (text) runs along local +X. */
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

/** DCL double-sided plane (north +Z, south -Z) scaled to world units. */
export function buildDclPlaneGeometry(width = 1, height = 1): THREE.BufferGeometry {
  const geometry = buildPlaneGeometryWithUvs(DEFAULT_DCL_PLANE_UVS)
  if (width !== 1 || height !== 1) {
    geometry.scale(width, height, 1)
  }
  return geometry
}

/**
 * True when atlas U (text) runs along plane local Y (BL→TL), not local X (BL→BR).
 * Genesis Plaza LED marquees author UVs this way while entity local Y is world-up, so
 * without a basis fix text is sideways and TextureMove Y crawls horizontally.
 */
function planeUvsMapTextAlongLocalY(uvs: readonly number[]): boolean {
  const du = Math.abs((uvs[2] ?? 0) - (uvs[0] ?? 0))
  const dv = Math.abs((uvs[3] ?? 0) - (uvs[1] ?? 0))
  return dv > du + 1e-5
}

/** (x,y)→(y,-x): local +Y (atlas U / text) becomes local +X (horizontal on upright planes). */
function applyTextAlongYPlaneBasis(geometry: THREE.BufferGeometry): void {
  const pos = geometry.getAttribute('position')
  if (!(pos instanceof THREE.BufferAttribute)) return
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i)
    const y = pos.getY(i)
    pos.setXY(i, y, -x)
  }
  pos.needsUpdate = true
  geometry.computeBoundingBox()
  geometry.computeBoundingSphere()
  geometry.userData[DCL_TEXT_ALONG_Y_BASIS] = true
}

function buildPlaneGeometryWithUvs(uvs: number[]): THREE.BufferGeometry {
  const perSide = uvs.length >= 16 ? 8 : uvs.length >= 8 ? 8 : 0
  if (!perSide) return buildPlaneGeometryWithUvs(DEFAULT_DCL_PLANE_UVS)

  const north = uvs.slice(0, 8)
  const south = uvs.length >= 16 ? uvs.slice(8, 16) : mirrorSouthPlaneUvs(north)

  const positions = new Float32Array([
    -0.5, 0.5, 0,
    0.5, 0.5, 0,
    -0.5, -0.5, 0,
    0.5, -0.5, 0,
    -0.5, 0.5, 0,
    0.5, 0.5, 0,
    -0.5, -0.5, 0,
    0.5, -0.5, 0
  ])
  const normals = new Float32Array([
    0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1,
    0, 0, -1, 0, 0, -1, 0, 0, -1, 0, 0, -1
  ])
  const uvAttr = new THREE.BufferAttribute(new Float32Array(16), 2)
  applyFaceUvs(uvAttr, 0, DCL_PLANE_NORTH_CORNER_TO_THREE, north)
  applyFaceUvs(uvAttr, 1, DCL_PLANE_SOUTH_CORNER_TO_THREE, south)

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3))
  geometry.setAttribute('uv', uvAttr)
  // North (+Z): CCW from +Z. South (-Z): opposite winding so both sides render with FrontSide.
  geometry.setIndex([0, 2, 1, 2, 3, 1, 4, 5, 6, 5, 7, 6])

  // Custom atlas UVs with text along local Y (plaza marquees) → re-basis so text is horizontal.
  // Default full-quad UVs (video, etc.) keep the standard XY plane.
  if (planeUvsMapTextAlongLocalY(north)) {
    applyTextAlongYPlaneBasis(geometry)
  }

  return geometry
}

/** Update an existing double-sided plane geometry in place (sprite UV animation). */
export function updatePlaneGeometryUvs(geometry: THREE.BufferGeometry, uvs: number[]): boolean {
  const perSide = uvs.length >= 16 ? 8 : uvs.length >= 8 ? 8 : 0
  if (!perSide) return false

  const attr = geometry.getAttribute('uv')
  if (!(attr instanceof THREE.BufferAttribute) || attr.count < 8) return false

  const north = uvs.slice(0, 8)
  const south = uvs.length >= 16 ? uvs.slice(8, 16) : mirrorSouthPlaneUvs(north)
  applyFaceUvs(attr, 0, DCL_PLANE_NORTH_CORNER_TO_THREE, north)
  applyFaceUvs(attr, 1, DCL_PLANE_SOUTH_CORNER_TO_THREE, south)
  attr.needsUpdate = true
  return true
}

/**
 * Build south-face UVs (BR, BL, TL, TR) from north (BL, BR, TR, TL) with U mirrored.
 * Matches DEFAULT_DCL_PLANE_UVS south packing and Explorer setUVs helpers.
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
  return [
    1 - brU, brV,
    1 - blU, blV,
    1 - tlU, tlV,
    1 - trU, trV
  ]
}
