/**
 * Single empty-land floor for all of Genesis City (coords AOI only).
 *
 * Replaces per-parcel instanced EMPTY_LAND ground tiles inside the Scene Distance
 * ring. One mesh (~300×300 parcels) sits under roads/scenes; AOI still loads
 * Explorer roads + vacant scatter in the warm band.
 */
import * as THREE from 'three'
import type { AssetCache } from '../../rendering/AssetCache'
import { dclToThreePos } from '../../bridge/dclTransform'
import {
  GENESIS_CITY_MAX_X,
  GENESIS_CITY_MAX_Y,
  GENESIS_CITY_MIN,
  genesisCityDclRect
} from '../../player/genesisCityBounds'
import { EMPTY_LAND } from '../landscape/Data/EmptyLandCatalog'
import { loadMeshTemplates } from '../landscape/gltfInstancing'
import { EMPTY_LAND_GROUND_OFFSET } from '../landscape/Utils/SceneSpace'

/** Fallback FloorBase-ish dirt when catalyst ground GLB material is unavailable. */
const FALLBACK_GROUND_COLOR = 0x6b4a32

/**
 * One receive-shadow plane covering Genesis City, textured from EMPTY_LAND.ground
 * (UV tiled per parcel) so we keep the empty-land look without N draw instances.
 */
export async function buildGenesisCityEmptyPlane(
  cache: AssetCache,
  primaryBase: string
): Promise<THREE.Group> {
  const rect = genesisCityDclRect(primaryBase)
  const group = new THREE.Group()
  group.name = 'aoi-genesis-empty-plane'

  const material = await loadEmptyLandPlaneMaterial(
    cache,
    rect.widthParcels,
    rect.depthParcels
  )

  const geometry = new THREE.PlaneGeometry(rect.sizeX, rect.sizeZ, 1, 1)
  geometry.rotateX(-Math.PI / 2)

  const mesh = new THREE.Mesh(geometry, material)
  mesh.name = 'aoi-genesis-empty-plane:mesh'
  mesh.receiveShadow = true
  mesh.castShadow = false
  mesh.renderOrder = -3
  // City-scale plane is always under the camera frustum while walking Genesis.
  mesh.frustumCulled = false

  dclToThreePos(
    rect.centerX,
    EMPTY_LAND_GROUND_OFFSET.y,
    rect.centerZ,
    mesh.position
  )

  group.add(mesh)
  group.userData.genesisEmptyPlane = true
  group.userData.primaryBase = primaryBase.trim()
  group.userData.parcels = {
    min: GENESIS_CITY_MIN,
    maxX: GENESIS_CITY_MAX_X,
    maxY: GENESIS_CITY_MAX_Y,
    w: rect.widthParcels,
    d: rect.depthParcels
  }
  group.userData.sizeM = { x: rect.sizeX, z: rect.sizeZ }
  return group
}

async function loadEmptyLandPlaneMaterial(
  cache: AssetCache,
  tileRepeatU: number,
  tileRepeatV: number
): Promise<THREE.Material> {
  try {
    const templates = await loadMeshTemplates(cache, EMPTY_LAND.ground)
    const raw = templates[0]?.material
    const src = Array.isArray(raw) ? raw[0] : raw
    if (src) {
      const mat = src.clone()
      // Tile FloorBase albedo across the city so it doesn't stretch to one blob.
      if ('map' in mat && mat.map instanceof THREE.Texture) {
        const map = mat.map.clone()
        map.wrapS = THREE.RepeatWrapping
        map.wrapT = THREE.RepeatWrapping
        map.repeat.set(Math.max(1, tileRepeatU), Math.max(1, tileRepeatV))
        map.needsUpdate = true
        mat.map = map
        mat.needsUpdate = true
      }
      if ('roughness' in mat && typeof mat.roughness === 'number') {
        mat.roughness = Math.max(mat.roughness, 0.9)
      }
      mat.side = THREE.FrontSide
      return mat
    }
  } catch (err) {
    console.warn('[aoi] genesis empty plane — ground GLB material failed, solid fallback', err)
  }

  return new THREE.MeshStandardMaterial({
    color: FALLBACK_GROUND_COLOR,
    roughness: 0.95,
    metalness: 0.0,
    side: THREE.FrontSide
  })
}
