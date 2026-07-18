import * as THREE from 'three'
import { parseParcelKey } from '../../content/parseParcel'
import { sceneHasAuthorTerrain } from '../../content/sceneAuthorTerrain'
import type { ResolvedScene, SceneEnvironmentConfig } from '../../content/types'
import type { AssetCache } from '../../../rendering/AssetCache'
import { catalystAssetUrl } from '../Data/EmptyLandCatalog'
import type { LandscapeEnvironmentProfile } from '../EnvironmentCatalog'
import { landscapeProfileForResolvedScene } from '../resolveLandscapeEnvironment'
import { EMPTY_LAND_GROUND_OFFSET, parcelWorldOrigin } from '../Utils/SceneSpace'
import { decorateParcel, type DecorateDensityOpts } from '../ParcelDecorator'
import { resolveDesertSettings } from '../../../environment/desertDefaults'
import { resolveMountainsSettings } from '../../../environment/mountainsDefaults'
import { resolveLandSettings } from '../../../environment/landDefaults'
import { DesertAtmosphere } from '../../../environment/DesertAtmosphere'
import { isSceneParcel, sceneParcelBounds } from '../Utils/ParcelGrid'
import { createTerrainModel } from '../Worlds/TerrainModel'
import { dclToThreePos } from '../../../bridge/dclTransform'
import { buildIslandCircularShore } from './IslandShoreRing'
import { buildDesertGoldGround } from './DesertGoldGround'
import { buildLandColorGround } from './LandColorGround'
import { buildInfiniteGround, outerScatterContext } from './InfiniteGround'
import { buildForestOuterScatter } from '../ForestScatter'
import { buildDesertOuterRockScatter, buildPerlinInstancedScatter } from '../PerlinScatter'
import { finalizeFoliageWindLandscape, resetFoliageWindRegistry } from '../foliageWind'
import { buildEzTreeGrassField, type EzTreeGrassFieldHandle } from '../EzTreeGrassField'
import {
  buildAuthorTerrainGrassField,
  combineGrassHandles
} from '../AuthorTerrainGrassField'
import { readEnvironmentWindShader } from '../readEnvironmentWindShader'
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
  const authorTerrain = sceneHasAuthorTerrain(scene)
  const windShader = readEnvironmentWindShader(scene.metadata)
  let ezTreeGrass: EzTreeGrassFieldHandle | null = null

  // none = void authoring; genesis = skybox only — still plant grass if they authored terrain.
  if (profile.kind === 'none' || profile.kind === 'genesis') {
    onProgress?.(
      profile.kind === 'genesis'
        ? 'Landscape: genesis (sky only — no empty-land tiles)'
        : 'Landscape: none (blank scene)'
    )
    if (authorTerrain) {
      onProgress?.('Planting author-terrain grass…')
      ezTreeGrass = await buildAuthorTerrainGrassField(scene, { windShader, onProgress })
      if (ezTreeGrass) {
        landscape.add(ezTreeGrass.group)
        landscape.userData.ezTreeGrass = ezTreeGrass
        landscape.userData.windShader = windShader
      }
    }
    return landscape
  }

  if (profile.kind === 'water') {
    onProgress?.('Landscape: water (open ocean)')
    return landscape
  }

  const circularShore = profile.circularShore === true
  // Always build the horizon sand plate for desert — even with author terrain
  // (sculpt mesh sits on scene parcels; plate fills the outer dunes like play client).
  const proceduralDesert = profile.proceduralDesertPlane === true
  // Land: single solid-color plane (no ground GLBs / infinite tiles).
  const solidLandPlane = profile.kind === 'land'
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

  const envCfg =
    scene.metadata?.environment &&
    typeof scene.metadata.environment === 'object' &&
    !Array.isArray(scene.metadata.environment)
      ? (scene.metadata.environment as SceneEnvironmentConfig)
      : undefined
  const desertCfg = resolveDesertSettings(envCfg?.desert)
  const mountainsCfg = resolveMountainsSettings(envCfg?.mountains)

  if (proceduralDesert) {
    onProgress?.('Building desert gold ground…')
    const desertGround = buildDesertGoldGround(
      scene.parcels,
      scene.baseParcel,
      profile.borderPadding,
      desertCfg.sandColor,
      desertCfg
    )
    landscape.add(desertGround)
  }

  if (solidLandPlane) {
    const landCfg = resolveLandSettings(envCfg?.land)
    onProgress?.('Building land color plane…')
    landscape.add(
      buildLandColorGround(
        scene.parcels,
        scene.baseParcel,
        profile.borderPadding,
        landCfg.groundColor
      )
    )
  }

  const densityOpts: DecorateDensityOpts | undefined =
    profile.kind === 'desert'
      ? {
          rockDensity: desertCfg.rockDensity,
          perlinScale: desertCfg.perlinScale,
          perlinThreshold: desertCfg.perlinThreshold
        }
      : profile.kind === 'mountains'
        ? {
            rockDensity: mountainsCfg.rockDensity,
            treeDensity: mountainsCfg.treeDensity,
            backdropDensity: mountainsCfg.backdropDensity
          }
        : undefined

  for (let i = 0; i < total; i++) {
    const key = parcelKeys[i]!
    const parcel = parseParcelKey(key)
    const role = isSceneParcel(key, scene.parcels) ? 'scene' : 'padding'
    onProgress?.(`${role} parcel ${key} (${i + 1}/${total})`)

    const parcelRoot = new THREE.Group()
    parcelRoot.name = `parcel:${key}:${role}`
    const origin = parcelWorldOrigin(parcel, base)
    dclToThreePos(origin.x, origin.y, origin.z, parcelRoot.position)

    const skipSceneGround = authorTerrain && role === 'scene'
    // Desert / land use a single color plane — no per-parcel ground GLBs.
    if (!proceduralDesert && !solidLandPlane && !skipSceneGround) {
      const groundHash = role === 'scene' ? profile.sceneGround : profile.paddingGround
      const ground = await cache.clone(catalystAssetUrl(groundHash), groundHash, { landscape: true })
      ground.position.set(
        EMPTY_LAND_GROUND_OFFSET.x,
        EMPTY_LAND_GROUND_OFFSET.y,
        EMPTY_LAND_GROUND_OFFSET.z
      )
      parcelRoot.add(ground)
    }

    await decorateParcel(
      cache,
      parcel.x,
      parcel.y,
      role,
      parcelRoot,
      worldScene,
      profile,
      {
        sceneCenterPx,
        sceneCenterPy,
        sceneParcelKeys: new Set(scene.parcels),
        baseParcelX: base.x,
        baseParcelY: base.y
      },
      densityOpts
    )
    landscape.add(parcelRoot)
  }

  // Outer expanse (forest-style infinite scatter). Desert gets rocks to the horizon
  // even without infiniteGround tiles (gold plane already covers the floor).
  const outerCtx = outerScatterContext(scene.parcels, scene.baseParcel, profile.borderPadding)
  const seed = hashParcelCoords(base.x, base.y, 42)

  if (profile.kind === 'desert') {
    onProgress?.('Scattering desert rocks to the horizon…')
    const outerRocks = await buildDesertOuterRockScatter(
      cache,
      profile,
      outerCtx,
      seed,
      {
        rockDensity: desertCfg.rockDensity,
        perlinScale: desertCfg.perlinScale,
        perlinThreshold: desertCfg.perlinThreshold,
        onProgress
      }
    )
    landscape.add(outerRocks)

    // Dust / tumbleweeds span the full outer footprint (like forest expanse).
    const dust = DesertAtmosphere.create(envCfg?.desert, {
      widthM: outerCtx.maxX - outerCtx.minX,
      depthM: outerCtx.maxZ - outerCtx.minZ,
      originX: outerCtx.minX,
      originZ: outerCtx.minZ,
      sceneParcelKeys: new Set(scene.parcels),
      baseParcelX: base.x,
      baseParcelY: base.y
    })
    landscape.add(dust.group)
    landscape.userData.desertAtmosphere = dust
  }

  // Land: solid plane already covers the floor — only plant outer grass.
  // Forest / other infiniteGround: instanced GLB tiles + scatter.
  if (solidLandPlane) {
    if (profile.ezTreeGrass) {
      onProgress?.('Planting ez-tree grass (outer)…')
      const outerGrass = await buildEzTreeGrassField(
        outerCtx,
        scene.parcels,
        seed,
        profile.borderPadding,
        onProgress,
        { windShader }
      )
      ezTreeGrass = combineGrassHandles(ezTreeGrass, outerGrass)
    }
  } else if (profile.infiniteGround) {
    onProgress?.('Building outer instanced ground…')
    const infinite = await buildInfiniteGround(
      cache,
      profile.sceneGround,
      scene.parcels,
      scene.baseParcel,
      profile.borderPadding
    )
    landscape.add(infinite)

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
    } else if (profile.kind !== 'desert' && (profile.trees.length > 0 || profile.rocks.length > 0)) {
      const scatter = await buildPerlinInstancedScatter(cache, profile, outerCtx, seed, onProgress)
      landscape.add(scatter)
    }

    // Outer empty-parcel grass (land/forest style expanse).
    if (profile.ezTreeGrass) {
      onProgress?.('Planting ez-tree grass (outer)…')
      const outerGrass = await buildEzTreeGrassField(
        outerCtx,
        scene.parcels,
        seed,
        profile.borderPadding,
        onProgress,
        { windShader }
      )
      ezTreeGrass = combineGrassHandles(ezTreeGrass, outerGrass)
    }
  }

  // Author terrain grass on the scene footprint — any environment, paint-driven.
  if (authorTerrain) {
    onProgress?.('Planting author-terrain grass…')
    const authorGrass = await buildAuthorTerrainGrassField(scene, { windShader, onProgress })
    ezTreeGrass = combineGrassHandles(ezTreeGrass, authorGrass)
  }

  if (ezTreeGrass) {
    landscape.add(ezTreeGrass.group)
    landscape.userData.ezTreeGrass = ezTreeGrass
    landscape.userData.windShader = windShader
  }

  finalizeFoliageWindLandscape(landscape)

  return landscape
}

export function landscapeProfileForScene(scene: ResolvedScene): LandscapeEnvironmentProfile {
  return landscapeProfileForResolvedScene(scene)
}