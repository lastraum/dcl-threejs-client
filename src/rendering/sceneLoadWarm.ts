import type { ResolvedScene } from '../dcl/content/types'
import type { AssetCache } from './AssetCache'
import { normalizeGlbCacheKey, readGlbBytes } from './glbByteCache'
import { collectManifestGlbs } from './manifestAssets'

export type ManifestGlbCacheStats = {
  total: number
  parsed: number
}

const sessionHydratedScenes = new Set<string>()

export function sceneSessionKey(scene: ResolvedScene): string {
  return scene.entityId ?? `${scene.baseParcel}@${scene.realm.contentUrl}`
}

export function markSceneHydrated(scene: ResolvedScene): void {
  sessionHydratedScenes.add(sceneSessionKey(scene))
}

export function wasSceneHydratedThisSession(scene: ResolvedScene): boolean {
  return sessionHydratedScenes.has(sceneSessionKey(scene))
}

export function getManifestGlbCacheStats(cache: AssetCache, scene: ResolvedScene): ManifestGlbCacheStats {
  const glbs = collectManifestGlbs(scene)
  let parsed = 0
  for (const { hash } of glbs) {
    if (cache.hasCached(normalizeGlbCacheKey(hash))) parsed++
  }
  return { total: glbs.length, parsed }
}

/** True when this scene was hydrated earlier in the tab session or most GLBs are already parsed. */
export function isSceneLoadWarm(cache: AssetCache, scene: ResolvedScene): boolean {
  if (wasSceneHydratedThisSession(scene)) return true
  const stats = getManifestGlbCacheStats(cache, scene)
  if (stats.total === 0) return false
  return stats.parsed / stats.total >= 0.75
}

/** True when IndexedDB already holds most manifest GLB bytes (page reload revisit). */
export async function isSceneBytesWarm(scene: ResolvedScene): Promise<boolean> {
  const glbs = collectManifestGlbs(scene)
  if (!glbs.length) return false
  const hits = await Promise.all(glbs.map(({ hash }) => readGlbBytes(hash)))
  const warm = hits.filter((buf) => buf && buf.byteLength > 0).length
  return warm / glbs.length >= 0.75
}

/**
 * Session parse-cache warm (same-tab revisit). Hydration no longer uses a hard timeout;
 * warm only shortens settle windows / settle delays.
 */
export async function resolveSceneLoadWarm(cache: AssetCache, scene: ResolvedScene): Promise<boolean> {
  return isSceneLoadWarm(cache, scene)
}

/** IndexedDB byte warm — speeds GLB prime inside hydration. */
export async function resolveSceneBytesWarm(scene: ResolvedScene): Promise<boolean> {
  return isSceneBytesWarm(scene)
}

export type PrimeManifestParsesResult = {
  total: number
  alreadyParsed: number
  attempted: number
  parsed: number
  failed: number
  elapsedMs: number
}

/**
 * Parse every content-map (catalyst) GLB into AssetCache Three templates.
 * Blocks until each hash is parsed or has permanently failed — attach later only clones.
 * Does NOT cook colliders (cook stays attach/runtime for entities that exist).
 */
export async function primeManifestParses(
  cache: AssetCache,
  scene: ResolvedScene,
  concurrency = 12,
  onProgress?: (done: number, total: number) => void
): Promise<PrimeManifestParsesResult> {
  const glbs = collectManifestGlbs(scene)
  const total = glbs.length
  if (!total) {
    return { total: 0, alreadyParsed: 0, attempted: 0, parsed: 0, failed: 0, elapsedMs: 0 }
  }

  const pending = glbs.filter(({ hash }) => !cache.hasCached(normalizeGlbCacheKey(hash)))
  const alreadyParsed = total - pending.length
  if (!pending.length) {
    onProgress?.(total, total)
    console.info(`[Hydration] content GLB templates already parsed — ${total}/${total}`)
    return {
      total,
      alreadyParsed,
      attempted: 0,
      parsed: total,
      failed: 0,
      elapsedMs: 0
    }
  }

  const started = performance.now()
  let completed = alreadyParsed
  let failed = 0
  onProgress?.(completed, total)

  for (let i = 0; i < pending.length; i += concurrency) {
    const batch = pending.slice(i, i + concurrency)
    const results = await Promise.all(
      batch.map(({ url, hash }) =>
        cache.load(url, hash, { quiet: true }).then(
          () => true as const,
          () => false as const
        )
      )
    )
    for (const ok of results) {
      completed++
      if (!ok) failed++
    }
    onProgress?.(completed, total)
  }

  const elapsedMs = performance.now() - started
  const parsed = total - failed
  console.info(
    `[Hydration] primed content GLB templates — ${parsed}/${total} ok` +
      (failed ? ` (${failed} failed)` : '') +
      ` in ${(elapsedMs / 1000).toFixed(1)}s (concurrency=${concurrency})`
  )
  return {
    total,
    alreadyParsed,
    attempted: pending.length,
    parsed,
    failed,
    elapsedMs
  }
}