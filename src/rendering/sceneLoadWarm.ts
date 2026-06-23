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

export async function resolveSceneLoadWarm(cache: AssetCache, scene: ResolvedScene): Promise<boolean> {
  if (isSceneLoadWarm(cache, scene)) return true
  return isSceneBytesWarm(scene)
}

/** Parse manifest GLBs in parallel so attach only clones from memory on warm revisits. */
export async function primeManifestParses(
  cache: AssetCache,
  scene: ResolvedScene,
  concurrency = 12
): Promise<void> {
  const glbs = collectManifestGlbs(scene)
  const pending = glbs.filter(({ hash }) => !cache.hasCached(normalizeGlbCacheKey(hash)))
  if (!pending.length) return

  const started = performance.now()
  for (let i = 0; i < pending.length; i += concurrency) {
    const batch = pending.slice(i, i + concurrency)
    await Promise.all(
      batch.map(({ url, hash }) => cache.load(url, hash, { quiet: true }).catch(() => null))
    )
  }
  const elapsed = ((performance.now() - started) / 1000).toFixed(1)
  console.info(`[Hydration] primed ${pending.length} GLB parse(s) in ${elapsed}s`)
}