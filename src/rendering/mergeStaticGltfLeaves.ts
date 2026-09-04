import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { isGltfInvisibleColliderMesh } from '../collision/gltfColliderNaming'
import { disposeOwnedObject3D } from './sharedAsset'

/**
 * Generic exporter names — always safe to merge.
 * Authored names are GltfNodeModifiers.path / pointer meshName targets; only merge
 * those when the caller passes namedOk (entity has no named modifier paths).
 */
const GENERIC_MESH_NAME = /^(mesh|Mesh|_?mesh_?\d+|Object_\d+|)$/i

const MERGED_IN_PLACE_KEY = 'dclMergedInPlace'
const UNMERGED_ROOT_KEY = 'dclUnmergedRoot'
const MERGED_AWAY_KEY = 'dclMergedAway'

function geometryHasMorphTargets(geometry: THREE.BufferGeometry | undefined): boolean {
  if (!geometry?.morphAttributes) return false
  const ma = geometry.morphAttributes
  return !!(ma.position?.length || ma.normal?.length || ma.color?.length)
}

function texId(tex: THREE.Texture | null | undefined): string {
  return tex ? tex.uuid : ''
}

function colorId(c: THREE.Color | undefined): string {
  return c ? c.getHexString() : ''
}

/**
 * Content signature for static merge. Creator Hub often emits one glTF material
 * index per brick with identical PBR (Antenna HQ: 1464 default whites) — uuid
 * would keep 1:1 draw calls. Custom onBeforeCompile shaders stay unique.
 */
export function materialMergeKey(mat: THREE.Material): string {
  const std = mat as THREE.MeshStandardMaterial
  const phys = mat as THREE.MeshPhysicalMaterial
  return [
    mat.type,
    mat.side,
    mat.blending,
    Number(mat.transparent),
    Number(mat.depthWrite),
    Number(mat.depthTest),
    Number(mat.vertexColors),
    mat.alphaTest.toFixed(3),
    mat.opacity.toFixed(3),
    colorId(std.color),
    colorId(std.emissive),
    (std.emissiveIntensity ?? 0).toFixed(3),
    (std.metalness ?? 0).toFixed(3),
    (std.roughness ?? 1).toFixed(3),
    (std.aoMapIntensity ?? 1).toFixed(3),
    (phys.clearcoat ?? 0).toFixed(3),
    (phys.transmission ?? 0).toFixed(3),
    texId(std.map),
    texId(std.emissiveMap),
    texId(std.normalMap),
    texId(std.roughnessMap),
    texId(std.metalnessMap),
    texId(std.aoMap),
    texId(std.alphaMap),
    texId(std.lightMap),
    texId(std.bumpMap)
  ].join('|')
}

function canMergeMesh(mesh: THREE.Mesh, root: THREE.Object3D, opts: { namedOk: boolean }): boolean {
  if ((mesh as THREE.SkinnedMesh).isSkinnedMesh) return false
  if ((mesh as THREE.BatchedMesh).isBatchedMesh) return false
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
    const key = materialMergeKey(mesh.material as THREE.Material)
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
    const sample = meshes[0]!
    // Named building kits (shack bricks, stadium chairs): one Mesh per material so
    // the instancer gets BufferGeometry leaves and frustum culls as a unit.
    // Generic exporter names keep BatchedMesh (tiny plaza props).
    const batched = namedOk
      ? null
      : tryMakeBatchedStatic(meshes, rootInv, sample.material as THREE.Material)
    if (batched) {
      batched.name = names[0] || 'batched-static'
      batched.userData.dclMergedMeshNames = names
      batched.userData.dclDrawStatic = true
      batched.castShadow = meshes.some((m) => m.castShadow)
      batched.receiveShadow = meshes.some((m) => m.receiveShadow)
      batched.matrixAutoUpdate = false
      batched.updateMatrix()
      root.add(batched)
      for (const mesh of meshes) {
        mesh.removeFromParent()
        mergedAway++
      }
      continue
    }
    const merged = mergeGeometries(geos, false)
    for (const geo of geos) geo.dispose()
    if (!merged) continue
    const out = new THREE.Mesh(merged, sample.material)
    out.name = names[0] || 'merged-static'
    out.userData.dclMergedMeshNames = names
    out.userData.dclDrawStatic = true
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

/**
 * One merged render copy per AssetCache template. Original named graph stays
 * intact for Animator / GltfNodeModifiers.path. Collider-named leaves are not
 * merged (see canMergeMesh) so PhysX still sees `_collider` hulls.
 */
function countRenderMeshes(root: THREE.Object3D): number {
  let n = 0
  root.traverse((node) => {
    if ((node as THREE.Mesh).isMesh) n++
  })
  return n
}

/**
 * Fold same-material leaves on the cached GLB itself so every attach path
 * (instance, clone, idle queue) sees the reduced graph. Keeps an unmerged
 * backup for GltfNodeModifiers.path / Animator.
 */
export function mergeStaticGltfInPlace(templateRoot: THREE.Group): number {
  if (templateRoot.userData[MERGED_IN_PLACE_KEY]) {
    return (templateRoot.userData[MERGED_AWAY_KEY] as number) ?? 0
  }
  const before = countRenderMeshes(templateRoot)
  const backup = templateRoot.clone(true) as THREE.Group
  const mergedAway = mergeStaticGltfLeaves(templateRoot, { namedOk: true })
  const after = countRenderMeshes(templateRoot)
  templateRoot.userData[MERGED_IN_PLACE_KEY] = true
  templateRoot.userData[MERGED_AWAY_KEY] = mergedAway
  if (mergedAway > 0 && after < before) {
    backup.userData.dclUnmergedBackup = true
    templateRoot.userData[UNMERGED_ROOT_KEY] = backup
    templateRoot.userData.dclMergedStatic = true
  } else {
    disposeOwnedObject3D(backup)
  }
  return mergedAway
}

/** Cached template after {@link mergeStaticGltfInPlace} (the reduced graph). */
export function ensureMergedStaticGltfRoot(templateRoot: THREE.Group): THREE.Group {
  mergeStaticGltfInPlace(templateRoot)
  return templateRoot
}

/** Pre-merge graph for named GltfNodeModifiers.path / clip targets. */
export function staticGltfUnmergedRoot(templateRoot: THREE.Group): THREE.Group {
  const backup = templateRoot.userData[UNMERGED_ROOT_KEY]
  return backup instanceof THREE.Group ? backup : templateRoot
}

function tryMakeBatchedStatic(
  meshes: THREE.Mesh[],
  rootInv: THREE.Matrix4,
  material: THREE.Material
): THREE.BatchedMesh | null {
  if (typeof THREE.BatchedMesh !== 'function') return null
  let verts = 0
  let indices = 0
  for (const mesh of meshes) {
    const pos = mesh.geometry.getAttribute('position')
    if (!pos) return null
    verts += pos.count
    const idx = mesh.geometry.getIndex()
    indices += idx ? idx.count : pos.count
  }
  if (verts > 250_000) return null
  const local = new THREE.Matrix4()
  try {
    const batched = new THREE.BatchedMesh(meshes.length, verts, indices, material)
    batched.frustumCulled = false
    for (const mesh of meshes) {
      const geoId = batched.addGeometry(mesh.geometry)
      const instId = batched.addInstance(geoId)
      local.copy(mesh.matrixWorld).premultiply(rootInv)
      batched.setMatrixAt(instId, local)
    }
    return batched
  } catch {
    return null
  }
}
