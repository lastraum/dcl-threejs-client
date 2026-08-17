/**
 * Read scene VideoPlayer sources from main.composite for the 2D landing.
 * Covers custom HLS/mp4 screens that never go through LiveKit.
 */
import type { SceneLandingRoute } from '../dcl/content/route'
import type { ContentFile, ResolvedScene } from '../dcl/content/types'
import { resolveSceneFromRoute } from '../dcl/content/resolveScene'
import { isLiveKitVideoSrc } from '../media/livekitVideoSource'
import { isHttpsM3u8 } from './sceneStreams'

export type SceneCompositeVideo = {
  entityId: number
  name: string | null
  /** Raw ECS VideoPlayer.src */
  src: string
  /** Browser-playable absolute URL (https or content CDN). */
  mediaUrl: string
  playing: boolean
  /** Matches ECS VideoPlayer.loop (default false) — same as in-world WebVideoPlayer. */
  loop: boolean
  isHls: boolean
}

function unwrap(value: unknown): unknown {
  if (value && typeof value === 'object' && 'json' in (value as object)) {
    return unwrap((value as { json: unknown }).json)
  }
  return value
}

function componentData(
  composite: { components?: unknown },
  name: string
): Record<string, unknown> {
  const components = composite.components
  if (!Array.isArray(components)) return {}
  for (const c of components) {
    if (!c || typeof c !== 'object') continue
    const n = (c as { name?: string }).name
    const data = (c as { data?: unknown }).data
    if (n === name && data && typeof data === 'object') {
      return data as Record<string, unknown>
    }
  }
  return {}
}

function findCompositeEntry(content: ContentFile[]): ContentFile | null {
  return (
    content.find((f) => f.file === 'main.composite') ??
    content.find((f) => f.file === 'assets/scene/main.composite') ??
    null
  )
}

/** Resolve VideoPlayer.src without image texture proxy (same rules as in-world media). */
export function resolveCompositeMediaUrl(
  src: string,
  scene: Pick<ResolvedScene, 'content' | 'assetUrl'>
): string | null {
  const trimmed = src.trim()
  if (!trimmed || isLiveKitVideoSrc(trimmed)) return null
  if (/^https:\/\//i.test(trimmed)) return trimmed
  // Allow http only for local/dev content hashes — production streams are https.
  if (/^http:\/\//i.test(trimmed)) return null
  if (/^(bafy|bafkre|Qm)/i.test(trimmed)) return scene.assetUrl(trimmed)
  const hit =
    scene.content.find((c) => c.file === trimmed) ??
    scene.content.find((c) => c.file.endsWith(`/${trimmed}`))
  return hit ? scene.assetUrl(hit.hash) : null
}

export function isPlayableLandingMediaUrl(url: string): boolean {
  const u = url.trim()
  if (!/^https:\/\//i.test(u)) return false
  if (isHttpsM3u8(u)) return true
  return /\.(mp4|webm|mov|ogg|m4v)(\?|#|$)/i.test(u)
}

/**
 * Pure parse — extract playable HTTP(S) VideoPlayers from composite JSON.
 * Skips livekit-video:// (handled by Cast / LiveKit path).
 */
export function extractCompositeVideos(
  compositeJson: unknown,
  scene: Pick<ResolvedScene, 'content' | 'assetUrl'>
): SceneCompositeVideo[] {
  const root = unwrap(compositeJson)
  if (!root || typeof root !== 'object') return []

  const composite = root as { components?: unknown }
  const videoData = componentData(composite, 'core::VideoPlayer')
  if (Object.keys(videoData).length === 0) return []

  const nameData = componentData(composite, 'core-schema::Name')
  const out: SceneCompositeVideo[] = []
  const seenUrls = new Set<string>()

  for (const [entKey, raw] of Object.entries(videoData)) {
    const entityId = Number(entKey)
    if (!Number.isFinite(entityId)) continue
    const spec = unwrap(raw) as { src?: string; playing?: boolean; loop?: boolean } | null
    const src = typeof spec?.src === 'string' ? spec.src.trim() : ''
    if (!src || isLiveKitVideoSrc(src)) continue

    const mediaUrl = resolveCompositeMediaUrl(src, scene)
    if (!mediaUrl || !isPlayableLandingMediaUrl(mediaUrl)) continue

    const urlKey = mediaUrl.toLowerCase()
    if (seenUrls.has(urlKey)) continue
    seenUrls.add(urlKey)

    const nameRaw = unwrap(nameData[entKey]) as { value?: string } | null
    const name =
      typeof nameRaw?.value === 'string' && nameRaw.value.trim()
        ? nameRaw.value.trim()
        : null

    out.push({
      entityId,
      name,
      src,
      mediaUrl,
      playing: spec?.playing !== false,
      // Match WebVideoPlayer: only loop when ECS explicitly sets loop === true.
      loop: spec?.loop === true,
      isHls: isHttpsM3u8(mediaUrl)
    })
  }

  // Prefer screens authored as playing (live/default on).
  out.sort((a, b) => Number(b.playing) - Number(a.playing) || a.entityId - b.entityId)
  return out
}

export function sceneCompositeVideoLabel(video: SceneCompositeVideo): string {
  const name = video.name?.trim()
  if (name) return `Scene: ${name}`
  return video.isHls ? 'Scene video (HLS)' : 'Scene video'
}

/**
 * Resolve scene deploy → fetch main.composite → playable VideoPlayer list.
 * Safe for landing: no worker, no LiveKit.
 */
export async function fetchSceneCompositeVideos(
  route: SceneLandingRoute
): Promise<SceneCompositeVideo[]> {
  try {
    const scene = await resolveSceneFromRoute(route)
    const entry = findCompositeEntry(scene.content)
    if (!entry?.hash) return []

    const res = await fetch(scene.assetUrl(entry.hash), {
      headers: { Accept: 'application/json' }
    })
    if (!res.ok) return []

    const json: unknown = await res.json()
    return extractCompositeVideos(json, scene)
  } catch (err) {
    console.warn(
      '[landing] composite VideoPlayer fetch failed',
      err instanceof Error ? err.message : err
    )
    return []
  }
}
