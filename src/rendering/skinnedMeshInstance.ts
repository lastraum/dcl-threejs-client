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
 * Ensure morphTargetInfluences exists when geometry has morph targets.
 * Missing array → Three.js setProgram crash: `objectInfluences.length` on undefined
 * (shared/instanced morph geometry, bad clones).
 */
export function ensureMorphTargetInfluences(root: THREE.Object3D): void {
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh
    if (!mesh.isMesh || !mesh.geometry) return
    const ma = mesh.geometry.morphAttributes
    if (!ma) return
    const targets = ma.position ?? ma.normal ?? ma.color
    if (!targets?.length) return
    if (!mesh.morphTargetInfluences || mesh.morphTargetInfluences.length !== targets.length) {
      mesh.morphTargetInfluences = new Array(targets.length).fill(0)
    }
    if (!mesh.morphTargetDictionary) {
      mesh.morphTargetDictionary = {}
      for (let i = 0; i < targets.length; i++) {
        mesh.morphTargetDictionary[`morphTarget${i}`] = i
      }
    }
  })
}

/**
 * Clone a cached GLTF root for a new scene instance.
 * SkeletonUtils.clone rebinds skinned meshes to cloned bones while sharing geometry/materials.
 */
function normalizeBoneKey(name: string): string {
  return name.replace(/^Avatar_/i, '').replace(/[\s_\-.]/g, '').toLowerCase()
}

function skeletonScore(skeleton: THREE.Skeleton): number {
  let score = skeleton.bones.length
  for (const bone of skeleton.bones) {
    const n = bone.name.toLowerCase()
    if (n.includes('hips') || n === 'hip') score += 100
    if (n.includes('head')) score += 50
  }
  return score
}

/**
 * Same bind pass desktop gets from worker inflateGltf — without ImageBitmap flatten.
 * parseAsync / SkeletonUtils.clone can leave head/face meshes on a second Skeleton whose
 * bones are not the mixer-driven ones. Point every skinned mesh at the primary skeleton.
 */
export function unifySkinnedMeshesToPrimarySkeleton(root: THREE.Object3D): void {
  const meshes: THREE.SkinnedMesh[] = []
  root.traverse((obj) => {
    if (obj instanceof THREE.SkinnedMesh && obj.skeleton?.bones.length) meshes.push(obj)
  })
  if (meshes.length < 2) return

  let primary = meshes[0]!.skeleton
  let best = skeletonScore(primary)
  for (const mesh of meshes) {
    const score = skeletonScore(mesh.skeleton)
    if (score > best) {
      best = score
      primary = mesh.skeleton
    }
  }

  const primaryByName = new Map<string, number>()
  primary.bones.forEach((bone, i) => {
    primaryByName.set(bone.name, i)
    primaryByName.set(normalizeBoneKey(bone.name), i)
  })

  for (const mesh of meshes) {
    if (mesh.skeleton === primary) continue
    const src = mesh.skeleton
    if (src.bones.every((bone, i) => bone === primary.bones[i]) && src.bones.length === primary.bones.length) {
      mesh.bind(primary, mesh.bindMatrix.clone())
      continue
    }
    if (src.bones.every((bone) => primary.bones.includes(bone))) {
      mesh.bind(primary, mesh.bindMatrix.clone())
      continue
    }

    const indexMap = src.bones.map((bone) => {
      const byRef = primary.bones.indexOf(bone)
      if (byRef >= 0) return byRef
      return primaryByName.get(normalizeBoneKey(bone.name)) ?? primaryByName.get(bone.name) ?? 0
    })

    const geo = mesh.geometry.clone()
    const attr = geo.attributes.skinIndex as THREE.BufferAttribute | undefined
    if (attr) {
      for (let i = 0; i < attr.count; i++) {
        for (let j = 0; j < 4; j++) {
          const srcIdx = attr.getComponent(i, j)
          const dst = srcIdx < indexMap.length ? indexMap[srcIdx]! : 0
          attr.setComponent(i, j, dst)
        }
      }
      attr.needsUpdate = true
    }
    mesh.geometry = geo
    mesh.bind(primary, mesh.bindMatrix.clone())
    repairSkinnedMesh(mesh)
  }
}

export function cloneGltfInstance(root: THREE.Group): THREE.Group {
  const clone = cloneSkinnedRoot(root) as THREE.Group
  ensureMorphTargetInfluences(clone)
  // Desktop inflate already shares one bone graph; clone + main-thread parse may not.
  unifySkinnedMeshesToPrimarySkeleton(clone)
  return clone
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

/**
 * Avatar / wearable skinned mesh hygiene.
 * Fixed generous bounds + frustumCulled so off-screen remotes can skip draw
 * without relying on expensive (and often broken) bone-derived spheres.
 *
 * Radius must cover outstretched hands / headwear — r≈2.6 was tight enough that
 * close freecam often frustum-culled faces and hands (bind-pose sphere vs animated pose).
 */
export function repairSkinnedMesh(mesh: THREE.SkinnedMesh): void {
  if (!mesh.boundingSphere) mesh.boundingSphere = new THREE.Sphere()
  // Center mid-torso; r covers T-pose reach + hats / props (local mesh space).
  mesh.boundingSphere.set(new THREE.Vector3(0, 1.1, 0), 4.25)
  if (!mesh.geometry.boundingSphere) mesh.geometry.boundingSphere = new THREE.Sphere()
  mesh.geometry.boundingSphere.copy(mesh.boundingSphere)
  // Head / hands / face: never cull — close zoom + animation stretch is a common false-out.
  const n = (mesh.name ?? '').toLowerCase()
  const faceOrHands =
    n.includes('head') ||
    n.includes('hand') ||
    n.includes('face') ||
    n.includes('mask_') ||
    n.includes('eye') ||
    n.includes('mouth') ||
    n.includes('hair') ||
    n.includes('visor') ||
    n.includes('hat') ||
    n.includes('cylinder')
  mesh.frustumCulled = !faceOrHands
  repairSkinWeights(mesh.geometry)
}

export function stabilizeSkinnedMeshes(root: THREE.Object3D): void {
  root.traverse((obj) => {
    if (obj instanceof THREE.SkinnedMesh) repairSkinnedMesh(obj)
  })
}

installSkinnedMeshSafetyPatch()
