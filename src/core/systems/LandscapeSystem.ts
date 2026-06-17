import type { ResolvedScene } from '../../dcl/content/types'
import { allLandscapeDecorationHashes, catalystAssetUrl, EMPTY_LAND } from '../../dcl/landscape/Data/EmptyLandCatalog'
import { buildParcelLandscape } from '../../dcl/landscape/Systems/RenderGroundSystem'
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
    const isWorld = scene.source.kind === 'world'
    if (isWorld) {
      await cache.preload(
        allLandscapeDecorationHashes().map((hash) => ({ url: catalystAssetUrl(hash), hash }))
      )
    } else {
      await cache.preload([{ url: catalystAssetUrl(EMPTY_LAND.ground), hash: EMPTY_LAND.ground }])
    }
    await cache.preloadTextures(sharedTextureHashes().map((hash) => catalystAssetUrl(hash)))
    this.state.landscapeRoot = await buildParcelLandscape(scene, cache, onProgress)
  }
}
