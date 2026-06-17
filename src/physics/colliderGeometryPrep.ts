import * as THREE from 'three'

/**
 * Ensure indexed triangles for PhysX cook. Returns the source geometry when already indexed;
 * otherwise a one-off clone with a flat index buffer. Caller must dispose when !== source.
 */
export function ensureIndexedForCook(geometry: THREE.BufferGeometry): THREE.BufferGeometry {
  if (geometry.index) return geometry

  const posAttr = geometry.getAttribute('position')
  if (!posAttr || posAttr.count < 3) return geometry

  const geo = geometry.clone()
  const count = posAttr.count
  const indices = count > 65535 ? new Uint32Array(count) : new Uint16Array(count)
  for (let i = 0; i < count; i++) indices[i] = i
  geo.setIndex(new THREE.BufferAttribute(indices, 1))
  return geo
}
