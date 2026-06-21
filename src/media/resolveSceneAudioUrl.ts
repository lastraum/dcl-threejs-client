import { resolveSceneTextureUrl } from '../bridge/material/resolveTexture'
import type { ResolvedScene } from '../dcl/content/types'

/** True when `audioClipUrl` is an absolute remote clip (not a scene manifest path). */
export function isRemoteAudioClipUrl(src: string): boolean {
  return /^https?:\/\//i.test(src.trim())
}

/**
 * Resolve `AudioSource.audioClipUrl` to a fetchable URL.
 * Supports bundled scene paths, Catalyst/IPFS hashes, and remote HTTPS clips (e.g. dclstreams.com).
 */
export function resolveSceneAudioUrl(src: string, scene: ResolvedScene): string | null {
  const trimmed = src.trim()
  if (!trimmed) return null
  if (/^(https?:|data:|blob:)/i.test(trimmed)) return trimmed
  return resolveSceneTextureUrl(trimmed, scene)
}