import * as THREE from 'three'

const PRIMITIVE_SEGMENTS = 24

/** DCL box face order: North, South, East, West, Top, Bottom. */
const DCL_BOX_FACE_TO_THREE = [4, 5, 0, 1, 2, 3]

/** DCL per-face corner order (LL, LR, UR, UL) → Three.js BoxGeometry vertex index. */
const DCL_BOX_CORNER_TO_THREE = [0, 1, 3, 2]

/** DCL plane north-side corners (LL, LR, UR, UL) → PlaneGeometry vertex index. */
const DCL_PLANE_NORTH_CORNER_TO_THREE = [2, 3, 1, 0]

/** DCL plane south-side corners (LR, LL, UL, UR) → spatial vertex index. */
const DCL_PLANE_SOUTH_CORNER_TO_THREE = [3, 2, 0, 1]

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
    // DCL MeshRenderer plane matches Babylon CreatePlane: vertical XY, normal +Z.
    return new THREE.PlaneGeometry(1, 1)
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

/** Sync key for MeshRenderer primitive meshes — includes custom UV data when present. */
export function primitiveMeshKey(spec: PrimitiveMeshSpec): string {
  const kind = primitiveKind(spec)
  const uvsKey = uvsFingerprint(meshRendererUvs(spec))
  return uvsKey ? `${kind}:${uvsKey}` : kind
}

/** DCL CreatePlane uses Babylon sideOrientation 2 (DOUBLE_SIDE). */
export function primitiveDoubleSided(spec: PrimitiveMeshSpec): boolean {
  return spec.mesh?.$case === 'plane'
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
    applyFaceUvs(attr, DCL_BOX_FACE_TO_THREE[dclFace] ?? dclFace, DCL_BOX_CORNER_TO_THREE, uvs, dclFace * perFace)
  }
  attr.needsUpdate = true
}

function buildPlaneGeometryWithUvs(uvs: number[]): THREE.BufferGeometry {
  const perSide = uvs.length >= 16 ? 8 : uvs.length >= 8 ? 8 : 0
  if (!perSide) return new THREE.PlaneGeometry(1, 1)

  const north = uvs.slice(0, 8)
  const south = uvs.length >= 16 ? uvs.slice(8, 16) : north

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
  geometry.setIndex([0, 2, 1, 2, 3, 1, 4, 5, 6, 4, 6, 7])
  return geometry
}
