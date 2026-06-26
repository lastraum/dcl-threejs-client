import * as THREE from 'three'
import { deinterleaveGeometry } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { isTrimeshGeometryCookable } from './bakeTrimeshGeometry'

export type PhysxCookMeshPayload = {
  positions: Float32Array
  indices: Uint16Array | Uint32Array
  use16BitIndices: boolean
}

const MIN_TRIANGLE_AREA_SQ = 1e-12

/** Flat-buffer pre-cook check — mirrors `isTrimeshGeometryCookable` for worker payloads. */
export function isPhysxCookPayloadCookable(payload: PhysxCookMeshPayload): boolean {
  const positions = payload.positions
  const indices = payload.indices
  if (!positions?.length || positions.length < 9 || positions.length % 3 !== 0) return false
  if (!indices?.length || indices.length < 3 || indices.length % 3 !== 0) return false

  const vertCount = positions.length / 3
  for (let i = 0; i < positions.length; i++) {
    const v = positions[i]!
    if (v !== v || !Number.isFinite(v)) return false
  }
  for (let i = 0; i < indices.length; i++) {
    const idx = indices[i]!
    if (idx < 0 || idx >= vertCount) return false
  }

  for (let i = 0; i < indices.length; i += 3) {
    const i0 = indices[i]! * 3
    const i1 = indices[i + 1]! * 3
    const i2 = indices[i + 2]! * 3
    const ax = positions[i1]! - positions[i0]!
    const ay = positions[i1 + 1]! - positions[i0 + 1]!
    const az = positions[i1 + 2]! - positions[i0 + 2]!
    const bx = positions[i2]! - positions[i0]!
    const by = positions[i2 + 1]! - positions[i0 + 1]!
    const bz = positions[i2 + 2]! - positions[i0 + 2]!
    const cx = ay * bz - az * by
    const cy = az * bx - ax * bz
    const cz = ax * by - ay * bx
    if (cx * cx + cy * cy + cz * cz > MIN_TRIANGLE_AREA_SQ) return true
  }
  return false
}

/** Flat buffers for worker CookTriangleMesh — mirrors main-thread cook input prep. */
export function buildPhysxCookMeshPayload(geometry: THREE.BufferGeometry): PhysxCookMeshPayload | null {
  let geo = geometry
  if (geo.attributes.position instanceof THREE.InterleavedBufferAttribute) {
    geo = geo.clone()
    deinterleaveGeometry(geo)
  }
  if (!isTrimeshGeometryCookable(geo)) return null

  let position = geo.attributes.position as THREE.BufferAttribute
  const index = geo.index
  if (!position || !index || position.count < 3 || index.count < 3) return null

  if (!(position.array instanceof Float32Array)) {
    position = new THREE.BufferAttribute(new Float32Array(position.array), position.itemSize, false)
  }

  let indices = index.array as Uint16Array | Uint32Array | Uint8Array
  if (indices instanceof Uint8Array) {
    const u16 = new Uint16Array(indices.length)
    for (let i = 0; i < indices.length; i++) u16[i] = indices[i]!
    indices = u16
  }

  const use16BitIndices = indices instanceof Uint16Array
  return {
    positions: position.array as Float32Array,
    indices: use16BitIndices ? indices : (indices as Uint32Array),
    use16BitIndices
  }
}