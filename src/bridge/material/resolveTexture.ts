import type { ResolvedScene } from '../../dcl/content/types'
import { DCL_SHARED_TEXTURES, findSceneContentHash } from '../../rendering/DclTextureResolver'

function leafName(path: string): string {
  const clean = path.split('?')[0]!.split('#')[0]!
  return decodeURIComponent(clean.split('/').pop() ?? clean)
}

/** Map a Material `texture.src` or glTF path to a fetchable scene content URL. */
export function resolveSceneTextureUrl(src: string, scene: ResolvedScene): string | null {
  const trimmed = src.trim()
  if (!trimmed) return null
  if (/^(https?:|data:|blob:)/i.test(trimmed)) return trimmed

  if (/^(bafy|bafkre|Qm)/i.test(trimmed)) return scene.assetUrl(trimmed)

  const hash = findSceneContentHash(scene.content, trimmed)
  if (hash) return scene.assetUrl(hash)

  const shared =
    DCL_SHARED_TEXTURES[leafName(trimmed)] ??
    DCL_SHARED_TEXTURES[trimmed] ??
    Object.entries(DCL_SHARED_TEXTURES).find(([key]) => key.toLowerCase() === leafName(trimmed).toLowerCase())?.[1]
  if (shared) return scene.assetUrl(shared)

  return null
}
