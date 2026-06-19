import type { ResolvedScene } from '../../dcl/content/types'
import { allHashesForProfile } from '../../dcl/landscape/EnvironmentCatalog'
import { landscapeProfileForResolvedScene } from '../../dcl/landscape/resolveLandscapeEnvironment'
import { catalystAssetUrl, EMPTY_LAND } from '../../dcl/landscape/Data/EmptyLandCatalog'
import {
  buildParcelLandscape,
  landscapeProfileForScene
} from '../../dcl/landscape/Systems/RenderGroundSystem'
import type { AssetCache } from '../../rendering/AssetCache'
import { sharedTextureHashes } from '../../rendering/DclTextureResolver'

export type LandscapeSystemState = {
  landscapeRoot: Awaited<ReturnType<typeof buildParcelLandscape>> | null
}

/** Mirror of Unity Explorer `DCL.Landscape` bootstrap + terrain load. */
export class LandscapeSystem {
  readonly state: LandscapeSystemState = { landscapeRoot: null }

  async initialize(
    scene: ResolvedScene,
    cache: AssetCache,
    onProgress?: (msg: string) => void
  ): Promise<void> {
    const profile = landscapeProfileForScene(scene)
    if (profile.kind === 'none' || profile.kind === 'water') {
      this.state.landscapeRoot = await buildParcelLandscape(scene, cache, onProgress)
      return
    }

    const needsDecorationAssets =
      scene.source.kind === 'world' ||
      profile.decoration === 'parcel' ||
      profile.infiniteGround

    if (needsDecorationAssets) {
      const hashes = allHashesForProfile(profile)
      await cache.preload(hashes.map((hash) => ({ url: catalystAssetUrl(hash), hash })))
    } else {
      await cache.preload([{ url: catalystAssetUrl(EMPTY_LAND.ground), hash: EMPTY_LAND.ground }])
    }

    await cache.preloadTextures(sharedTextureHashes().map((hash) => catalystAssetUrl(hash)))
    this.state.landscapeRoot = await buildParcelLandscape(scene, cache, onProgress)
  }

  static profileForScene(scene: ResolvedScene) {
    return landscapeProfileForResolvedScene(scene)
  }
}