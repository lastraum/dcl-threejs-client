import * as THREE from 'three'
import type { AssetCache } from '../rendering/AssetCache'
import { getWearableRepresentation } from './peerApi'
import { hexToColor, lipColorFromSkin } from './materials'
import type { AvatarComposeConfig, BodyShape, WearableCategory, WearableDefinition } from './types'

const BASE_AVATAR_URN = /off-chain:base-avatars/
const fallbackTextureLoader = new THREE.TextureLoader()

function isDefaultWearable(wearable: WearableDefinition | undefined): boolean {
  if (!wearable) return true
  return BASE_AVATAR_URN.test(wearable.id)
}

function pngUrl(wearable: WearableDefinition, bodyShape: BodyShape, mask: boolean): string | null {
  const rep = getWearableRepresentation(wearable, bodyShape)
  const file = rep.contents.find((c) => {
    const key = c.key.toLowerCase()
    if (mask) return key.endsWith('_mask.png')
    return key.endsWith('.png') && !key.endsWith('_mask.png')
  })
  return file?.url ?? null
}

async function loadFeatureTexture(url: string, cache?: AssetCache): Promise<THREE.Texture> {
  const texture = cache ? await cache.loadTexture(url) : await fallbackTextureLoader.loadAsync(url)
  texture.colorSpace = THREE.SRGBColorSpace
  return texture
}

async function loadFeaturePair(
  wearable: WearableDefinition | undefined,
  bodyShape: BodyShape,
  cache?: AssetCache
): Promise<[THREE.Texture | null, THREE.Texture | null]> {
  if (!wearable) return [null, null]
  try {
    const mainUrl = pngUrl(wearable, bodyShape, false)
    if (!mainUrl) return [null, null]
    const texture = await loadFeatureTexture(mainUrl, cache)
    const maskUrl = pngUrl(wearable, bodyShape, true)
    const mask = maskUrl ? await loadFeatureTexture(maskUrl, cache).catch(() => null) : null
    return [texture, mask]
  } catch {
    return [null, null]
  }
}

function applyFeatureMaterial(
  mesh: THREE.Mesh,
  texture: THREE.Texture,
  color: THREE.Color,
  mask: THREE.Texture | null
): void {
  const emissive = mask ? color.clone().multiplyScalar(0.25) : new THREE.Color(0, 0, 0)
  const mat = new THREE.MeshStandardMaterial({
    map: texture,
    color,
    transparent: true,
    alphaTest: 0.01,
    depthWrite: true,
    side: THREE.DoubleSide,
    metalness: 0,
    roughness: 1,
    emissive,
    ...(mask ? { emissiveMap: mask, emissiveIntensity: 2.5 } : { emissiveIntensity: 0 })
  })
  if (mask) {
    mat.emissiveMap!.colorSpace = THREE.SRGBColorSpace
    mat.toneMapped = false
  }
  mesh.material = mat
  mesh.visible = true
}

/** Apply eyes / eyebrows / mouth textures to body_shape mask meshes — Forge `face.ts`. */
export async function applyFacialFeatures(
  bodyRoot: THREE.Object3D,
  config: AvatarComposeConfig,
  cache?: AssetCache
): Promise<void> {
  const find = (category: WearableCategory) =>
    config.wearables.find((w) => w.data.category === category)

  const eyesWearable = find('eyes')
  const browsWearable = find('eyebrows')
  const mouthWearable = find('mouth')

  const [eyes, eyebrows, mouth] = await Promise.all([
    loadFeaturePair(eyesWearable, config.bodyShape, cache),
    loadFeaturePair(browsWearable, config.bodyShape, cache),
    loadFeaturePair(mouthWearable, config.bodyShape, cache)
  ])

  const eyeColor = isDefaultWearable(eyesWearable)
    ? hexToColor(config.eyes)
    : new THREE.Color(1, 1, 1)
  const hairColor = hexToColor(config.hair)
  const lipColor = lipColorFromSkin(config.skin)

  bodyRoot.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh) || !obj.visible) return
    const name = obj.name.toLowerCase()

    if (name.endsWith('mask_eyes')) {
      const [texture, mask] = eyes
      if (texture) applyFeatureMaterial(obj, texture, eyeColor, mask)
      else obj.visible = false
    }
    if (name.endsWith('mask_eyebrows')) {
      const [texture, mask] = eyebrows
      if (texture) applyFeatureMaterial(obj, texture, hairColor, mask)
      else obj.visible = false
    }
    if (name.endsWith('mask_mouth')) {
      const [texture, mask] = mouth
      if (texture) applyFeatureMaterial(obj, texture, lipColor, mask)
      else obj.visible = false
    }
  })
}
