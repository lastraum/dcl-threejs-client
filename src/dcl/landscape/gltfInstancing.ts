import * as THREE from 'three'
import type { AssetCache } from '../../rendering/AssetCache'
import type { ParcelCoord } from '../content/parseParcel'
import { catalystAssetUrl, PROP_Y_SINK } from './Data/EmptyLandCatalog'
import {
  classifyLandscapeMesh,
  isFoliageMaterial,
  prepareFoliageWindMaterial,
  type LandscapeMeshPart
} from './foliageWind'
import { dclSceneToLandscapeThree, EMPTY_LAND_GROUND_OFFSET } from './Utils/SceneSpace'

export type MeshTemplate = {
  geometry: THREE.BufferGeometry
  material: THREE.Material | THREE.Material[]
  localMatrix: THREE.Matrix4
  part: LandscapeMeshPart
  meshName: string
}

function isColliderMesh(node: THREE.Object3D): boolean {
  return /collider/i.test(node.name)
}

/** Collect renderable mesh leaves relative to the GLB root (for InstancedMesh transforms). */
export function collectMeshTemplates(root: THREE.Object3D): MeshTemplate[] {
  const out: MeshTemplate[] = []
  root.updateMatrixWorld(true)
  const rootInverse = new THREE.Matrix4().copy(root.matrixWorld).invert()

  root.traverse((node) => {
    if (!(node instanceof THREE.Mesh) || !node.geometry) return
    if (isColliderMesh(node)) return

    const localMatrix = new THREE.Matrix4().multiplyMatrices(rootInverse, node.matrixWorld)
    out.push({
      geometry: node.geometry.clone(),
      material: node.material,
      localMatrix,
      part: classifyLandscapeMesh(node),
      meshName: node.name
    })
  })

  return out
}

export async function loadMeshTemplates(
  cache: AssetCache,
  hash: string
): Promise<MeshTemplate[]> {
  const { root } = await cache.load(catalystAssetUrl(hash), hash)
  return collectMeshTemplates(root)
}

export type TilePlacement = {
  x: number
  z: number
}

/** Instanced ground tiles — one draw call per mesh leaf in the source GLB. */
export async function buildInstancedGroundTiles(
  cache: AssetCache,
  groundHash: string,
  tiles: TilePlacement[],
  name: string,
  base?: ParcelCoord
): Promise<THREE.Group> {
  const group = new THREE.Group()
  group.name = name

  const templates = await loadMeshTemplates(cache, groundHash)
  if (!templates.length) return group

  const dummy = new THREE.Object3D()
  const instanceMatrix = new THREE.Matrix4()
  const offset = new THREE.Matrix4().makeTranslation(
    EMPTY_LAND_GROUND_OFFSET.x,
    EMPTY_LAND_GROUND_OFFSET.y,
    EMPTY_LAND_GROUND_OFFSET.z
  )

  for (let t = 0; t < templates.length; t++) {
    const template = templates[t]!
    const mesh = new THREE.InstancedMesh(template.geometry, template.material, tiles.length)
    mesh.name = `${name}:mesh${t}`
    mesh.castShadow = false
    mesh.receiveShadow = true

    for (let i = 0; i < tiles.length; i++) {
      const tile = tiles[i]!
      if (base) {
        const p = dclSceneToLandscapeThree(tile.x, tile.z, base)
        dummy.position.set(p.x, 0, p.z)
      } else {
        dummy.position.set(tile.x, 0, tile.z)
      }
      dummy.rotation.set(0, 0, 0)
      dummy.scale.set(1, 1, 1)
      dummy.updateMatrix()
      instanceMatrix.identity()
      instanceMatrix.multiply(dummy.matrix)
      instanceMatrix.multiply(offset)
      instanceMatrix.multiply(template.localMatrix)
      mesh.setMatrixAt(i, instanceMatrix)
    }
    mesh.instanceMatrix.needsUpdate = true
    mesh.computeBoundingSphere()
    group.add(mesh)
  }

  return group
}

export type ScatterInstance = {
  x: number
  z: number
  rotY: number
  scale: number
}

export async function buildInstancedScatter(
  cache: AssetCache,
  hash: string,
  instances: ScatterInstance[],
  name: string,
  base?: ParcelCoord
): Promise<THREE.Group | null> {
  if (!instances.length) return null

  const templates = await loadMeshTemplates(cache, hash)
  if (!templates.length) return null

  const group = new THREE.Group()
  group.name = name

  const dummy = new THREE.Object3D()
  const instanceMatrix = new THREE.Matrix4()
  const alignY = await measureBaseOffset(cache, hash)

  for (let t = 0; t < templates.length; t++) {
    const template = templates[t]!
    const templateMat = Array.isArray(template.material) ? template.material[0] : template.material
    const needsWind = template.part === 'foliage' || isFoliageMaterial(templateMat)
    const material = needsWind
      ? prepareFoliageWindMaterial(template.material, true)
      : template.material
    const mesh = new THREE.InstancedMesh(template.geometry, material, instances.length)
    mesh.name =
      template.part === 'foliage'
        ? `${name}:foliage`
        : template.part === 'bark'
          ? `${name}:bark`
          : `${name}:mesh${t}`

    for (let i = 0; i < instances.length; i++) {
      const inst = instances[i]!
      if (base) {
        const p = dclSceneToLandscapeThree(inst.x, inst.z, base)
        dummy.position.set(p.x, alignY, p.z)
      } else {
        dummy.position.set(inst.x, alignY, inst.z)
      }
      dummy.rotation.set(0, inst.rotY, 0)
      dummy.scale.setScalar(inst.scale)
      dummy.updateMatrix()
      instanceMatrix.identity()
      instanceMatrix.multiply(dummy.matrix)
      instanceMatrix.multiply(template.localMatrix)
      mesh.setMatrixAt(i, instanceMatrix)
    }
    mesh.instanceMatrix.needsUpdate = true
    mesh.computeBoundingSphere()
    group.add(mesh)
  }

  return group
}

const baseOffsetCache = new Map<string, number>()

async function measureBaseOffset(cache: AssetCache, hash: string): Promise<number> {
  const hit = baseOffsetCache.get(hash)
  if (hit !== undefined) return hit

  const clone = await cache.clone(catalystAssetUrl(hash), hash, { landscape: true })
  const box = new THREE.Box3().setFromObject(clone)
  const y = (Number.isFinite(box.min.y) ? -box.min.y : 0) + (PROP_Y_SINK[hash] ?? 0)
  baseOffsetCache.set(hash, y)
  return y
}