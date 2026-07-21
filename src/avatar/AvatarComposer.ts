import * as THREE from 'three'
import type { AssetCache } from '../rendering/AssetCache'
import { getSessionAssetCache } from '../rendering/AssetCache'
import { applyBodyShapeVisibility } from './bodyShape'
import { applyFacialFeatures } from './face'
import {
  attachWearableFallback,
  findSkeleton,
  loadWearableSceneCached,
  mergeWearableMeshes,
  prepareWearableForCompose,
  pruneWearableDisplayMeshes,
  sanitizeWearableRoot,
  disposeWearableInstance,
  buildMappingsForWearables
} from './loadWearable'
import { pushWearableMappings, popWearableMappings } from '../rendering/DclTextureResolver'
import { applyWearableEmissives } from './materials'
import { buildComposeConfig } from './resolveProfile'
import { resolveAvatarProfile } from './peerApi'
import { isModelWearable } from './slots'
import { yieldToNextFrame } from '../rendering/mainThreadYield'
import { stabilizeSkinnedMeshes } from '../rendering/skinnedMeshInstance'
import { isAvatarVerbose } from '../client/debug/ClientDebugLog'
import type { AvatarComposeConfig, AvatarProfile, BodyShape, WearableCategory } from './types'

export type ComposeOptions = {
  profileId?: string
  bodyShape?: BodyShape
  assetCache?: AssetCache | null
  /**
   * Authoritative profile to compose from, skipping the lambdas fetch.
   * Used after backpack equip / local Catalyst deploy (lambdas can lag).
   */
  profile?: AvatarProfile
}

/** Serializes composes — global wearable texture mappings are not re-entrant. */
let composeMutex: Promise<void> = Promise.resolve()

async function withComposeMutex<T>(run: () => Promise<T>): Promise<T> {
  const prior = composeMutex
  let release!: () => void
  composeMutex = new Promise<void>((resolve) => {
    release = resolve
  })
  await prior
  try {
    return await run()
  } finally {
    release()
  }
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
  return withComposeMutex(() => composeFromConfig(config, assetCache ?? getSessionAssetCache()))
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
  /** Categories with a live mesh after merge/fallback — basemesh hide only when present. */
  const attachedCategories = new Set<WearableCategory>()
  /** Subset attached via rigid fallback — their slot's basemesh stays visible. */
  const fallbackCategories = new Set<WearableCategory>()
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

    const modelWearables = config.wearables.filter(
      (w) => w.data.category !== 'body_shape' && isModelWearable(w)
    )
    const loadedLayers = await Promise.all(
      modelWearables.map(async (wearable) => {
        try {
          // Facial hair takes its own D3JS color when set; every other wearable's
          // hair-named materials keep the profile hair color.
          const hairTint =
            wearable.data.category === 'facial_hair'
              ? config.facialHair ?? config.hair
              : config.hair
          const layer = await loadWearableSceneCached(
            cache,
            wearable,
            config.bodyShape,
            config.skin,
            hairTint,
            true
          )
          return { wearable, layer }
        } catch (err) {
          console.warn(`Skipping wearable ${wearable.id}:`, err)
          return null
        }
      })
    )

    let mergeIndex = 0
    for (const entry of loadedLayers) {
      if (!entry) continue
      // One wearable merge per frame — keeps peer compose from stacking multi-ms CPU on rAF.
      if (mergeIndex > 0) await yieldToNextFrame()
      mergeIndex++

      const category = entry.wearable.data.category
      const mergeOpts = {
        category,
        wearableId: entry.wearable.id,
        bodyRoot,
        // replaces has hide semantics for base parts — fallback anchoring/skin logic
        // treats both alike.
        hides: [
          ...(entry.wearable.data.hides ?? []),
          ...(entry.wearable.data.replaces ?? [])
        ]
      }
      const isFeet = category === 'feet'
      if (isFeet && isAvatarVerbose()) {
        console.info(`[avatar] composing feet — ${entry.wearable.id}`)
      }

      let merged = false
      if (isFeet) {
        // Raw-first so foot/Hips bind weights stay valid. Unit mismatch (RTFKT Armature×10 /
        // cm verts) is corrected inside mergeWearableMeshes via wearableUnitScaleFactor.
        pruneWearableDisplayMeshes(entry.layer, { extentCheck: false })
        merged = mergeWearableMeshes(entry.layer, skeleton, avatar, mergeOpts)
        if (!merged) {
          prepareWearableForCompose(entry.layer, bodyRoot, category)
          merged = mergeWearableMeshes(entry.layer, skeleton, avatar, mergeOpts)
        }
      } else {
        prepareWearableForCompose(entry.layer, bodyRoot, category)
        merged = mergeWearableMeshes(entry.layer, skeleton, avatar, mergeOpts)
      }

      if (!merged) {
        // Fallback renders the AUTHORED rest pose — the merge attempt's prepare pass
        // mutated this layer's transforms, so bake from a pristine clone instead.
        disposeWearableInstance(entry.layer)
        const pristine = await loadWearableSceneCached(
          cache,
          entry.wearable,
          config.bodyShape,
          config.skin,
          config.hair,
          true
        )
        const attached = attachWearableFallback(pristine, skeleton, avatar, mergeOpts)
        if (attached && isAvatarVerbose()) {
          console.info(`[avatar] ${category} fallback attach (authored pose) — ${entry.wearable.id}`)
        }
        if (!attached) {
          console.warn(
            `[avatar] skipping wearable ${entry.wearable.id} (${category}) — no merge and no safe fallback geometry`
          )
          disposeWearableInstance(pristine)
        } else {
          attachedCategories.add(category)
          // Overlay-style fallback (no hides/replaces) keeps the base part visible and
          // animated under it. Replacement-style (hides/replaces something) hides its
          // own slot too — its kept skin meshes ARE the body there, rigid like the
          // official parallel-rig rendering of broken exports.
          if (!mergeOpts.hides.length) fallbackCategories.add(category)
        }
      } else {
        attachedCategories.add(category)
        disposeWearableInstance(entry.layer)
      }
    }
  } finally {
    popWearableMappings()
  }

  await yieldToNextFrame()
  applyBodyShapeVisibility(bodyRoot, config.wearables, {
    attachedCategories,
    fallbackCategories,
    forceRender: config.forceRender
  })
  await applyFacialFeatures(bodyRoot, config, cache)
  await yieldToNextFrame()
  applyWearableEmissives(avatar)
  stabilizeSkinnedMeshes(avatar)
  return avatar
}
