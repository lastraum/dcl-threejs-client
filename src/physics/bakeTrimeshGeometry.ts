import * as THREE from 'three'
import { deinterleaveGeometry, mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js'

const MIN_TRIANGLE_AREA_SQ = 1e-12

/** Lightweight pre-cook check — skip NaN/degenerate meshes before PhysX cook. */
export function isTrimeshGeometryCookable(geometry: THREE.BufferGeometry): boolean {
  const position = geometry.attributes.position as THREE.BufferAttribute | undefined
  const index = geometry.index
  if (!position || !index || position.count < 3 || index.count < 3) return false

  const pos = position.array as ArrayLike<number>
  for (let i = 0; i < position.count * 3; i++) {
    const v = pos[i]
    if (v !== v || !Number.isFinite(v)) return false
  }

  const indices = index.array as ArrayLike<number>
  const vertCount = position.count
  for (let i = 0; i < index.count; i++) {
    if (indices[i]! < 0 || indices[i]! >= vertCount) return false
  }

  for (let i = 0; i < index.count; i += 3) {
    const i0 = indices[i]! * 3
    const i1 = indices[i + 1]! * 3
    const i2 = indices[i + 2]! * 3
    const ax = pos[i1]! - pos[i0]!, ay = pos[i1 + 1]! - pos[i0 + 1]!, az = pos[i1 + 2]! - pos[i0 + 2]!
    const bx = pos[i2]! - pos[i0]!, by = pos[i2 + 1]! - pos[i0 + 1]!, bz = pos[i2 + 2]! - pos[i0 + 2]!
    const cx = ay * bz - az * by
    const cy = az * bx - ax * bz
    const cz = ax * by - ay * bx
    if (cx * cx + cy * cy + cz * cz > MIN_TRIANGLE_AREA_SQ) return true
  }
  return false
}

/** Bake mesh world matrix into vertices — exact placement for PhysX triangle meshes. */
export function bakeTrimeshGeometry(geometry: THREE.BufferGeometry, matrix: THREE.Matrix4): THREE.BufferGeometry {
  let geo = geometry.clone()
  if (geo.attributes.position instanceof THREE.InterleavedBufferAttribute) {
    deinterleaveGeometry(geo)
  }

  const position = geo.attributes.position
  if (!position || position.count < 3) {
    throw new Error('bakeTrimeshGeometry: missing or insufficient position attribute')
  }

  geo.applyMatrix4(matrix)
  if (matrix.determinant() < 0) flipTriangleWinding(geo)
  try {
    geo = mergeVertices(geo)
  } catch {
    // merge is optional optimization for PhysX cook
  }
  return geo
}

function flipTriangleWinding(geo: THREE.BufferGeometry): void {
  const index = geo.index
  if (!index) return
  const arr = index.array as Uint16Array | Uint32Array
  for (let i = 0; i < arr.length; i += 3) {
    const b = arr[i + 1]
    arr[i + 1] = arr[i + 2]
    arr[i + 2] = b
  }
  index.needsUpdate = true
}
