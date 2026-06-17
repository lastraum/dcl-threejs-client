import * as THREE from 'three'
import { parseParcelKey } from '../../content/parseParcel'
import type { ResolvedScene } from '../../content/types'
import type { AssetCache } from '../../../rendering/AssetCache'
import { catalystAssetUrl, EMPTY_LAND } from '../Data/EmptyLandCatalog'
import { EMPTY_LAND_GROUND_OFFSET, parcelWorldOrigin } from '../Utils/SceneSpace'
import { decorateParcel } from '../ParcelDecorator'
import { isSceneParcel } from '../Utils/ParcelGrid'
import { createTerrainModel } from '../Worlds/TerrainModel'
import { dclToThreePos } from '../../../bridge/dclTransform'

/**
 * Mirror of Unity Explorer `DCL.Landscape.Systems.RenderGroundSystem` +
 * `WorldTerrainGenerator` — builds ground mesh + parcel decoration.
 */
export async function buildParcelLandscape(
  scene: ResolvedScene,
  cache: AssetCache,
  onProgress?: (msg: string) => void
): Promise<THREE.Group> {
  const landscape = new THREE.Group()
  landscape.name = 'landscape'

  const terrain = createTerrainModel(scene.parcels, 1)
  const base = parseParcelKey(scene.baseParcel)
  const total = terrain.landscapeParcelKeys.length
  const worldScene = scene.source.kind === 'world'

  for (let i = 0; i < total; i++) {
    const key = terrain.landscapeParcelKeys[i]!
    const parcel = parseParcelKey(key)
    const role = isSceneParcel(key, scene.parcels) ? 'scene' : 'padding'
    onProgress?.(`${role} parcel ${key} (${i + 1}/${total})`)

    const parcelRoot = new THREE.Group()
    parcelRoot.name = `parcel:${key}:${role}`
    const origin = parcelWorldOrigin(parcel, base)
    dclToThreePos(origin.x, origin.y, origin.z, parcelRoot.position)

    const ground = await cache.clone(catalystAssetUrl(EMPTY_LAND.ground), EMPTY_LAND.ground)
    ground.position.set(
      EMPTY_LAND_GROUND_OFFSET.x,
      EMPTY_LAND_GROUND_OFFSET.y,
      EMPTY_LAND_GROUND_OFFSET.z
    )
    parcelRoot.add(ground)

    await decorateParcel(cache, parcel.x, parcel.y, role, parcelRoot, worldScene)
    landscape.add(parcelRoot)
  }

  return landscape
}
