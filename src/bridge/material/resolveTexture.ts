import type { ResolvedScene } from '../../dcl/content/types'
import {
  DCL_SHARED_TEXTURES,
  findSceneContentHash,
  resolveDclAssetUrl
} from '../../rendering/DclTextureResolver'
import { proxiedTextureUrl, unwrapMisroutedMediaUrl } from '../../rendering/textureProxy'

function leafName(path: string): string {
  const clean = path.split('?')[0]!.split('#')[0]!
  return decodeURIComponent(clean.split('/').pop() ?? clean)
}

function resolveSceneAssetUrl(
  src: string,
  scene: ResolvedScene,
  options: { proxyImages: boolean }
): string | null {
  const trimmed = src.trim()
  if (!trimmed) return null
  if (/^(https?:|data:|blob:)/i.test(trimmed)) {
    const resolved = options.proxyImages ? proxiedTextureUrl(trimmed) : trimmed
    return options.proxyImages ? resolved : unwrapMisroutedMediaUrl(resolved)
  }

  if (/^(bafy|bafkre|Qm)/i.test(trimmed)) return scene.assetUrl(trimmed)

  const hash = findSceneContentHash(scene.content, trimmed)
  if (hash) return scene.assetUrl(hash)

  const shared =
    DCL_SHARED_TEXTURES[leafName(trimmed)] ??
    DCL_SHARED_TEXTURES[trimmed] ??
    Object.entries(DCL_SHARED_TEXTURES).find(([key]) => key.toLowerCase() === leafName(trimmed).toLowerCase())?.[1]
  if (shared) return scene.assetUrl(shared)

  const resolved = resolveDclAssetUrl(trimmed)
  if (resolved && resolved !== trimmed && /^https?:/i.test(resolved)) {
    return options.proxyImages ? proxiedTextureUrl(resolved) : resolved
  }

  return null
}

/** Map a Material `texture.src` or glTF image path to a fetchable scene content URL. */
export function resolveSceneTextureUrl(src: string, scene: ResolvedScene): string | null {
  return resolveSceneAssetUrl(src, scene, { proxyImages: true })
}

/** Video / audio scene assets — never rewrite through the image texture proxy. */
export function resolveSceneMediaUrl(src: string, scene: ResolvedScene): string | null {
  return resolveSceneAssetUrl(src, scene, { proxyImages: false })
}