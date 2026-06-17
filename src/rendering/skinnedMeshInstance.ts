import * as THREE from 'three'
import { clone as cloneSkinnedRoot } from 'three/examples/jsm/utils/SkeletonUtils.js'

let safetyPatchInstalled = false

function fallbackBoundingSphere(mesh: THREE.SkinnedMesh): void {
  if (!mesh.boundingSphere) mesh.boundingSphere = new THREE.Sphere()
  mesh.boundingSphere.set(new THREE.Vector3(), 2)
}

/**
 * Guard frustum-cull bounding-sphere recompute only — do NOT rewrite bones or skin indices
 * (that corrupts GPU skinning and explodes meshes).
 */
export function installSkinnedMeshSafetyPatch(): void {
  if (safetyPatchInstalled) return
  safetyPatchInstalled = true

  const proto = THREE.SkinnedMesh.prototype
  const originalComputeBoundingSphere = proto.computeBoundingSphere
  proto.computeBoundingSphere = function (this: THREE.SkinnedMesh): void {
    try {
      originalComputeBoundingSphere.call(this)
    } catch {
      fallbackBoundingSphere(this)
    }
  }

  const originalComputeBoundingBox = proto.computeBoundingBox
  proto.computeBoundingBox = function (this: THREE.SkinnedMesh): void {
    try {
      originalComputeBoundingBox.call(this)
    } catch {
      if (!this.boundingBox) this.boundingBox = new THREE.Box3()
      this.boundingBox.setFromCenterAndSize(new THREE.Vector3(), new THREE.Vector3(2, 2, 2))
    }
  }
}

/**
 * Clone a cached GLTF root for a new scene instance.
 * SkeletonUtils.clone rebinds skinned meshes to cloned bones while sharing geometry/materials.
 */
export function cloneGltfInstance(root: THREE.Group): THREE.Group {
  return cloneSkinnedRoot(root) as THREE.Group
}

/**
 * Repair degenerate skin weights that explode a mesh into a giant sheet through the scene.
 *
 * The GPU skinning shader blends a vertex by its 4 (boneIndex, weight) pairs. If a vertex's
 * weights are all zero (or NaN — bad export, failed Draco decode, broken rig retarget), its
 * skinning matrix is the zero matrix and the vertex collapses to the origin (0,0,0) while its
 * triangle's other vertices stay on the body — stretching one triangle across the whole view
 * (the "huge white plane that breaks the scene", white when the wearable texture also failed).
 *
 * Fix: any vertex with no finite influence is pinned fully to its first bone (so it tracks the
 * body instead of the origin); near-unnormalized weights are renormalized. Idempotent and a
 * no-op on healthy meshes (so existing avatars are unchanged), guarded per-geometry.
 */
function repairSkinWeights(geometry: THREE.BufferGeometry): void {
  const weights = geometry.attributes.skinWeight as THREE.BufferAttribute | undefined
  if (!weights) return
  const flags = geometry.userData as { dclSkinWeightsRepaired?: boolean }
  if (flags.dclSkinWeightsRepaired) return
  flags.dclSkinWeightsRepaired = true

  let changed = false
  for (let i = 0; i < weights.count; i++) {
    let x = weights.getX(i)
    let y = weights.getY(i)
    let z = weights.getZ(i)
    let w = weights.getW(i)
    if (!Number.isFinite(x)) x = 0
    if (!Number.isFinite(y)) y = 0
    if (!Number.isFinite(z)) z = 0
    if (!Number.isFinite(w)) w = 0
    const sum = x + y + z + w
    if (sum <= 1e-6) {
      // No influence → pin to this vertex's first bone so it follows the body, not the origin.
      weights.setXYZW(i, 1, 0, 0, 0)
      changed = true
    } else if (Math.abs(sum - 1) > 1e-3) {
      weights.setXYZW(i, x / sum, y / sum, z / sum, w / sum)
      changed = true
    }
  }
  if (changed) weights.needsUpdate = true
}

/** Keep skinned meshes out of the bounding-sphere frustum-cull path (avatars / wearables only). */
export function repairSkinnedMesh(mesh: THREE.SkinnedMesh): void {
  mesh.frustumCulled = false
  fallbackBoundingSphere(mesh)
  repairSkinWeights(mesh.geometry)
}

export function stabilizeSkinnedMeshes(root: THREE.Object3D): void {
  root.traverse((obj) => {
    if (obj instanceof THREE.SkinnedMesh) repairSkinnedMesh(obj)
  })
}

installSkinnedMeshSafetyPatch()
