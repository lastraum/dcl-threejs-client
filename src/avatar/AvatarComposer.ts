import * as THREE from 'three'
import type { AssetCache } from '../rendering/AssetCache'
import { getSessionAssetCache } from '../rendering/AssetCache'
import { applyBodyShapeVisibility } from './bodyShape'
import { applyFacialFeatures } from './face'
import {
  findSkeleton,
  loadWearableSceneCached,
  mergeWearableMeshes,
  sanitizeWearableRoot,
  disposeWearableInstance,
  buildMappingsForWearables
} from './loadWearable'
import { pushWearableMappings, popWearableMappings } from '../rendering/DclTextureResolver'
import { applyWearableEmissives } from './materials'
import { buildComposeConfig } from './resolveProfile'
import { resolveAvatarProfile } from './peerApi'
import { isModelWearable } from './slots'
import { stabilizeSkinnedMeshes } from '../rendering/skinnedMeshInstance'
import type { AvatarComposeConfig, AvatarProfile, BodyShape } from './types'

export type ComposeOptions = {
  profileId?: string
  bodyShape?: BodyShape
  assetCache?: AssetCache | null
}

/** Builds a composed DCL avatar `Group` from a profile or defaults. */
export async function composeAvatar(options: ComposeOptions = {}): Promise<THREE.Group> {
  const profile = await resolveAvatarProfile(options.profileId, options.bodyShape)
  return composeAvatarFromProfile(profile, undefined, options.assetCache)
}

/** Builds a composed DCL avatar `Group` from a resolved profile record. */
export async function composeAvatarFromProfile(
  profile: AvatarProfile,
  contentUrl?: string,
  assetCache?: AssetCache | null
): Promise<THREE.Group> {
  const config = await buildComposeConfig(profile, profile.address, contentUrl)
  return composeFromConfig(config, assetCache ?? getSessionAssetCache())
}

async function composeFromConfig(
  config: AvatarComposeConfig,
  cache: AssetCache
): Promise<THREE.Group> {
  const avatar = new THREE.Group()
  avatar.name = 'dcl-avatar'

  const bodyShapeDef = config.wearables.find((w) => w.data.category === 'body_shape')
  if (!bodyShapeDef) throw new Error('No body_shape wearable in compose config')

  const mergedMappings = buildMappingsForWearables(config.wearables, config.bodyShape)
  pushWearableMappings(mergedMappings)
  let bodyRoot: THREE.Object3D
  try {
    bodyRoot = await loadWearableSceneCached(
      cache,
      bodyShapeDef,
      config.bodyShape,
      config.skin,
      config.hair,
      true
    )
    sanitizeWearableRoot(bodyRoot)
    avatar.add(bodyRoot)

    const skeleton = findSkeleton(bodyRoot)
    if (!skeleton) throw new Error('Body shape has no skeleton')

    for (const wearable of config.wearables) {
      if (wearable.data.category === 'body_shape') continue
      if (!isModelWearable(wearable)) continue
      try {
        const layer = await loadWearableSceneCached(
          cache,
          wearable,
          config.bodyShape,
          config.skin,
          config.hair,
          true
        )
        sanitizeWearableRoot(layer)
        const merged = mergeWearableMeshes(layer, skeleton, avatar)
        if (!merged) {
          avatar.add(layer)
        } else {
          disposeWearableInstance(layer)
        }
      } catch (err) {
        console.warn(`Skipping wearable ${wearable.id}:`, err)
      }
    }
  } finally {
    popWearableMappings()
  }

  applyBodyShapeVisibility(bodyRoot, config.wearables)
  await applyFacialFeatures(bodyRoot, config)
  applyWearableEmissives(avatar)
  stabilizeSkinnedMeshes(avatar)
  return avatar
}
