import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { isGltfInvisibleColliderMesh } from '../collision/gltfColliderNaming'

/**
 * Generic exporter names — safe to merge. Authored mesh names stay as pointer meshName.
 */
const GENERIC_MESH_NAME = /^(mesh|Mesh|_?mesh_?\d+|Object_\d+|)$/i

function geometryHasMorphTargets(geometry: THREE.BufferGeometry | undefined): boolean {
  if (!geometry?.morphAttributes) return false
  const ma = geometry.morphAttributes
  return !!(ma.position?.length || ma.normal?.length || ma.color?.length)
}

function materialKey(mat: THREE.Material): string {
  return mat.uuid
}

function canMergeMesh(mesh: THREE.Mesh, root: THREE.Object3D, opts: { namedOk: boolean }): boolean {
  if ((mesh as THREE.SkinnedMesh).isSkinnedMesh) return false
  if (geometryHasMorphTargets(mesh.geometry)) return false
  if (isGltfInvisibleColliderMesh(mesh, root)) return false
  if (!mesh.visible) return false
  if (Array.isArray(mesh.material)) return false
  if (!mesh.material) return false
  if (!opts.namedOk && !GENERIC_MESH_NAME.test(mesh.name ?? '')) return false
  const pos = mesh.geometry?.getAttribute('position')
  return !!(pos && pos.count >= 3)
}

/**
 * Collapse same-material static leaves into one Mesh per material.
 * Clones geometry before bake so shared template buffers stay intact.
 * @returns number of source meshes merged away.
 */
export function mergeStaticGltfLeaves(
  root: THREE.Object3D,
  opts?: { namedOk?: boolean }
): number {
  const namedOk = opts?.namedOk === true
  root.updateMatrixWorld(true)
  const rootInv = new THREE.Matrix4().copy(root.matrixWorld).invert()
  const local = new THREE.Matrix4()
  const buckets = new Map<string, THREE.Mesh[]>()
  root.traverse((node) => {
    if (!(node as THREE.Mesh).isMesh) return
    const mesh = node as THREE.Mesh
    if (!canMergeMesh(mesh, root, { namedOk })) return
    const key = materialKey(mesh.material as THREE.Material)
    let list = buckets.get(key)
    if (!list) {
      list = []
      buckets.set(key, list)
    }
    list.push(mesh)
  })

  let mergedAway = 0
  for (const meshes of buckets.values()) {
    if (meshes.length < 2) continue
    const geos: THREE.BufferGeometry[] = []
    const names: string[] = []
    for (const mesh of meshes) {
      const geo = mesh.geometry.clone()
      local.copy(mesh.matrixWorld).premultiply(rootInv)
      geo.applyMatrix4(local)
      geos.push(geo)
      if (mesh.name) names.push(mesh.name)
    }
    const merged = mergeGeometries(geos, false)
    for (const geo of geos) geo.dispose()
    if (!merged) continue
    const sample = meshes[0]!
    const out = new THREE.Mesh(merged, sample.material)
    out.name = names[0] || 'merged-static'
    out.userData.dclMergedMeshNames = names
    out.castShadow = meshes.some((m) => m.castShadow)
    out.receiveShadow = meshes.some((m) => m.receiveShadow)
    out.matrixAutoUpdate = false
    out.updateMatrix()
    root.add(out)
    for (const mesh of meshes) {
      mesh.removeFromParent()
      mergedAway++
    }
  }
  if (mergedAway > 0) root.updateMatrixWorld(true)
  return mergedAway
}
