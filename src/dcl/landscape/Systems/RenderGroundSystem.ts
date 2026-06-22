import * as THREE from 'three'
import { parseParcelKey } from '../../content/parseParcel'
import type { ResolvedScene } from '../../content/types'
import type { AssetCache } from '../../../rendering/AssetCache'
import { catalystAssetUrl } from '../Data/EmptyLandCatalog'
import type { LandscapeEnvironmentProfile } from '../EnvironmentCatalog'
import { landscapeProfileForResolvedScene } from '../resolveLandscapeEnvironment'
import { EMPTY_LAND_GROUND_OFFSET, parcelWorldOrigin } from '../Utils/SceneSpace'
import { decorateParcel } from '../ParcelDecorator'
import { isSceneParcel, sceneParcelBounds } from '../Utils/ParcelGrid'
import { createTerrainModel } from '../Worlds/TerrainModel'
import { dclToThreePos } from '../../../bridge/dclTransform'
import { buildIslandCircularShore } from './IslandShoreRing'
import { buildDesertGoldGround } from './DesertGoldGround'
import { buildInfiniteGround, outerScatterContext } from './InfiniteGround'
import { buildForestOuterScatter } from '../ForestScatter'
import { buildPerlinInstancedScatter } from '../PerlinScatter'
import { finalizeFoliageWindLandscape, resetFoliageWindRegistry } from '../foliageWind'
import { buildEzTreeGrassField, type EzTreeGrassFieldHandle } from '../EzTreeGrassField'
import { hashParcelCoords } from '../Utils/SeededRandom'

/**
 * Mirror of Unity Explorer `DCL.Landscape.Systems.RenderGroundSystem` +
 * `WorldTerrainGenerator` — builds ground mesh + parcel decoration per environment profile.
 */
export async function buildParcelLandscape(
  scene: ResolvedScene,
  cache: AssetCache,
  onProgress?: (msg: string) => void
): Promise<THREE.Group> {
  const landscape = new THREE.Group()
  landscape.name = 'landscape'
  resetFoliageWindRegistry()

  const profile = landscapeProfileForResolvedScene(scene)
  landscape.userData.environment = profile.kind

  if (profile.kind === 'none') {
    onProgress?.('Landscape: none (blank scene)')
    return landscape
  }

  if (profile.kind === 'water') {
    onProgress?.('Landscape: water (open ocean)')
    return landscape
  }

  const circularShore = profile.circularShore === true
  const proceduralDesert = profile.proceduralDesertPlane === true
  const terrain = createTerrainModel(scene.parcels, profile.borderPadding, circularShore)
  const base = parseParcelKey(scene.baseParcel)
  const bounds = sceneParcelBounds(scene.parcels)
  const sceneCenterPx = (bounds.minX + bounds.maxX) * 0.5
  const sceneCenterPy = (bounds.minY + bounds.maxY) * 0.5
  // Circular island: procedural shore disc covers scene + beach — no per-parcel empty-land GLBs.
  const parcelKeys = circularShore ? [] : terrain.landscapeParcelKeys
  const total = parcelKeys.length
  const worldScene = scene.source.kind === 'world'

  onProgress?.(
    circularShore
      ? `Landscape: ${profile.kind} (circular shore)`
      : `Landscape: ${profile.kind} (${total} parcels)`
  )

  if (circularShore) {
    onProgress?.('Building circular island beach…')
    const shore = await buildIslandCircularShore(
      scene.parcels,
      scene.baseParcel,
      profile.borderPadding
    )
    landscape.add(shore)
  }

  if (proceduralDesert) {
    onProgress?.('Building desert gold ground…')
    const desertGround = buildDesertGoldGround(scene.parcels, scene.baseParcel, profile.borderPadding)
    landscape.add(desertGround)
  }

  let ezTreeGrass: EzTreeGrassFieldHandle | null = null

  for (let i = 0; i < total; i++) {
    const key = parcelKeys[i]!
    const parcel = parseParcelKey(key)
    const role = isSceneParcel(key, scene.parcels) ? 'scene' : 'padding'
    onProgress?.(`${role} parcel ${key} (${i + 1}/${total})`)

    const parcelRoot = new THREE.Group()
    parcelRoot.name = `parcel:${key}:${role}`
    const origin = parcelWorldOrigin(parcel, base)
    dclToThreePos(origin.x, origin.y, origin.z, parcelRoot.position)

    if (!proceduralDesert) {
      const groundHash = role === 'scene' ? profile.sceneGround : profile.paddingGround
      const ground = await cache.clone(catalystAssetUrl(groundHash), groundHash)
      ground.position.set(
        EMPTY_LAND_GROUND_OFFSET.x,
        EMPTY_LAND_GROUND_OFFSET.y,
        EMPTY_LAND_GROUND_OFFSET.z
      )
      parcelRoot.add(ground)
    }

    await decorateParcel(cache, parcel.x, parcel.y, role, parcelRoot, worldScene, profile, {
      sceneCenterPx,
      sceneCenterPy,
      sceneParcelKeys: new Set(scene.parcels),
      baseParcelX: base.x,
      baseParcelY: base.y
    })
    landscape.add(parcelRoot)
  }

  if (profile.infiniteGround) {
    onProgress?.('Building outer instanced ground…')
    const infinite = await buildInfiniteGround(
      cache,
      profile.sceneGround,
      scene.parcels,
      scene.baseParcel,
      profile.borderPadding
    )
    landscape.add(infinite)

    const outerCtx = outerScatterContext(scene.parcels, scene.baseParcel, profile.borderPadding)
    const seed = hashParcelCoords(base.x, base.y, 42)

    if (profile.kind === 'forest') {
      onProgress?.('Growing forest expanse…')
      const forest = await buildForestOuterScatter(
        cache,
        profile,
        outerCtx,
        scene.parcels,
        seed,
        profile.borderPadding,
        onProgress
      )
      landscape.add(forest)
    } else if (profile.trees.length > 0 || profile.rocks.length > 0) {
      const scatter = await buildPerlinInstancedScatter(cache, profile, outerCtx, seed, onProgress)
      landscape.add(scatter)
    }

    if (profile.ezTreeGrass) {
      onProgress?.('Planting ez-tree grass…')
      ezTreeGrass = await buildEzTreeGrassField(
        outerCtx,
        scene.parcels,
        seed,
        profile.borderPadding,
        onProgress
      )
      if (ezTreeGrass) landscape.add(ezTreeGrass.group)
    }
  }

  if (ezTreeGrass) {
    landscape.userData.ezTreeGrass = ezTreeGrass
  }

  finalizeFoliageWindLandscape(landscape)

  return landscape
}

export function landscapeProfileForScene(scene: ResolvedScene): LandscapeEnvironmentProfile {
  return landscapeProfileForResolvedScene(scene)
}