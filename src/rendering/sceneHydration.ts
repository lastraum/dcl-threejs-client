import type { ResolvedScene } from '../dcl/content/types'
import type { AssetCache } from './AssetCache'
import type { SceneScriptSystem } from '../core/systems/SceneScriptSystem'
import {
  markSceneHydrated,
  primeManifestParses,
  resolveSceneBytesWarm,
  resolveSceneLoadWarm
} from './sceneLoadWarm'
import { clientDebugLog } from '../client/debug/ClientDebugLog'

export type SceneHydrationStats = {
  entityCount: number
  /** GltfContainer on projection with a resolvable, non-emote src (blocking attach target). */
  gltfEntities: number
  /** All GltfContainer components on projection (before src/hash filtering). */
  gltfContainers: number
  gltfLoaded: number
  gltfPending: number
  /** Resolved src but empty/broken GLB — will not attach; excluded from blocking gate. */
  gltfAbandoned: number
  gltfUnresolved: number
  gltfInflight: number
  textureInflight: number
}

export type WaitForSceneAssetsOptions = {
  /**
   * Optional hard ceiling. Prefer **omit / Infinity** — Genesis cold loads often exceed 3 minutes;
   * cutting off early leaves 1000+ GLTFs pending and feels broken.
   */
  timeoutMs?: number
  stableMs?: number
  onPrimeRender?: () => void
  /** Per-tick stats — e.g. throttle remote avatar composes during scene GLTF pressure. */
  onHydrationTick?: (stats: SceneHydrationStats) => void
}

export type WaitForSceneAssetsResult = {
  timedOut: boolean
  elapsedMs: number
}

/** @deprecated Prefer no timeout — kept for callers that still pass an explicit budget. */
const DEFAULT_TIMEOUT_MS = Number.POSITIVE_INFINITY
/** @deprecated Prefer no timeout. */
const FAST_TIMEOUT_MS = Number.POSITIVE_INFINITY
const STABLE_MS = 400
const STABLE_WARM_MS = 150
/** Scene scripts keep spawning entities after boot — wait for the count to settle. */
const ENTITY_STABLE_MS = 800
/** Brief soft attach budget only — long soft windows + high budgets freeze select UI. */
/** Soft attach window after force-ready — large enough to drain plaza tails in background. */
const SOFT_HYDRATION_MS = 12_000
/**
 * No attach progress + no downloads for this long → force-ready.
 * Custom/marketplace worlds often leave 1–2 GLBs pending forever (missing hashes /
 * bad relative paths). Genesis cold still makes progress with inflight>0 so this
 * only fires on a true stall tail — not mid-download.
 */
/**
 * No attach progress + no downloads → force-ready.
 * Plaza left ~30 "pending" forever (bad attach accounting); 60s+ hangs at ~79%.
 */
const ATTACH_STALL_MS = 3_500
/** Near-complete attach — enter play; rest attach under soft hydration. */
const ATTACH_NEAR_COMPLETE_RATIO = 0.88
const ATTACH_NEAR_COMPLETE_STALL_MS = 900
const ENABLE_ATTACH_STALL_BAILOUT = true
/**
 * Huge scenes (Genesis ~10k–20k GltfContainers): never block the loading screen
 * for multi-minute full attach. Play when this ratio is hit (background soft hydrate).
 */
const PLAYABLE_FORCE_RATIO = 0.90
const PLAYABLE_FORCE_MIN_ELAPSED_MS = 12_000
const PLAYABLE_FORCE_STALL_MS = 1_000
/** Absolute ceiling for blocking hydrate (ms). Soft hydrate continues after. */
const MAX_BLOCKING_HYDRATE_MS_HUGE = 75_000
const MAX_BLOCKING_HYDRATE_MS = 120_000
const HUGE_SCENE_GLTF_THRESHOLD = 4_000
/** Wait before treating peakGltfEntities===0 as complete when composite may still publish GltfContainer. */
const ZERO_GLTF_FALLBACK_MS = 12_000
/** Fast path when projection never gets GltfContainer and manifest downloads are idle. */
const ZERO_GLTF_FAST_MS = 1_500
/**
 * Empty projection (0 entities) after this — finish anyway so SDK6/no-CRDT scenes
 * don't sit forever on "Finishing scene load…" (~78%). Prefer fail-fast SDK6 detect.
 */
const EMPTY_PROJECTION_MS = 5_000
const ENTITY_STABLE_FAST_MS = 300
/** Periodic status log while attach count is unchanged (composite may still be publishing GltfContainer). */
const HYDRATION_STATUS_LOG_MS = 5_000

function countManifestGlbs(scene: ResolvedScene): number {
  const seen = new Set<string>()
  let count = 0
  for (const entry of scene.content) {
    if (!entry.file.toLowerCase().endsWith('.glb')) continue
    if (!entry.hash || seen.has(entry.hash)) continue
    seen.add(entry.hash)
    count++
  }
  return count
}

function yieldToUi(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => resolve())
  })
}

function blockingPending(stats: SceneHydrationStats): number {
  const attachPending = Math.max(0, stats.gltfPending - stats.gltfAbandoned)
  return attachPending + stats.gltfInflight + stats.textureInflight
}

/**
 * All discoverable GLTFs attached.
 * When peakGltfEntities stays 0, only fall back after ZERO_GLTF_FALLBACK_MS so composite
 * CRDT has time to publish GltfContainer on the projection.
 */
function zeroGltfFallbackMs(stats: SceneHydrationStats, manifestGlbCount: number): number {
  if (stats.gltfContainers > 0 || stats.gltfEntities > 0) return ZERO_GLTF_FALLBACK_MS
  if (manifestGlbCount > 0 && (stats.gltfInflight > 0 || stats.textureInflight > 0)) {
    return ZERO_GLTF_FALLBACK_MS
  }
  return ZERO_GLTF_FAST_MS
}

function entityStableRequiredMs(peakGltfEntities: number, gltfContainers: number): number {
  // Huge plazas keep publishing GltfContainer for a long time — don't wait 800ms forever.
  if (peakGltfEntities >= HUGE_SCENE_GLTF_THRESHOLD) return ENTITY_STABLE_FAST_MS
  if (peakGltfEntities > 0 || gltfContainers > 0) return ENTITY_STABLE_MS
  return ENTITY_STABLE_FAST_MS
}

function isGltfAttachComplete(
  stats: SceneHydrationStats,
  peakGltfEntities: number,
  elapsedMs: number,
  manifestGlbCount: number
): boolean {
  const attachPending = Math.max(0, stats.gltfPending - stats.gltfAbandoned)
  if (peakGltfEntities <= 0) {
    if (elapsedMs < zeroGltfFallbackMs(stats, manifestGlbCount)) return false
    if (attachPending !== 0 || stats.gltfInflight !== 0 || stats.textureInflight !== 0) {
      return false
    }
    // Normal: scene spawned entities without mesh GLTFs yet (or pure empty ECS).
    if (stats.entityCount > 0) return true
    // No CRDT entities at all — empty parcel script / unsupported runtime. Don't hang the bar.
    return elapsedMs >= Math.max(zeroGltfFallbackMs(stats, manifestGlbCount), EMPTY_PROJECTION_MS)
  }
  return attachPending === 0 && stats.gltfInflight === 0 && stats.textureInflight === 0
}

function formatProgress(stats: SceneHydrationStats): string {
  if (stats.gltfEntities > 0) {
    const k = stats.gltfEntities >= 1000
    const loaded = k ? `${(stats.gltfLoaded / 1000).toFixed(1)}k` : String(stats.gltfLoaded)
    const total = k ? `${(stats.gltfEntities / 1000).toFixed(1)}k` : String(stats.gltfEntities)
    return `Loading models (${loaded}/${total} instances)…`
  }
  if (blockingPending(stats) > 0) {
    return 'Loading scene models…'
  }
  return 'Finishing scene load…'
}

function formatTimeout(stats: SceneHydrationStats): string {
  if (stats.gltfEntities > 0) {
    const pct = ((stats.gltfLoaded / Math.max(1, stats.gltfEntities)) * 100).toFixed(0)
    return `Entering world (${pct}% models) — rest loading in background`
  }
  return 'Entering world — models still loading in background'
}

function maxBlockingHydrateMs(peakGltf: number): number {
  return peakGltf >= HUGE_SCENE_GLTF_THRESHOLD
    ? MAX_BLOCKING_HYDRATE_MS_HUGE
    : MAX_BLOCKING_HYDRATE_MS
}

/** Progress range for the asset-loading phase within the overall 0→1 loading bar. */
const ASSET_PROGRESS_START = 0.38
const ASSET_PROGRESS_END = 0.80
const ASSET_PROGRESS_RANGE = ASSET_PROGRESS_END - ASSET_PROGRESS_START

/** Weight split between fetch+parse vs entity hydration sub-phases. */
const FETCH_WEIGHT = 0.4
const HYDRATE_WEIGHT = 0.6

/**
 * Compute a two-phase progress fraction for asset loading.
 * Phase 1 (fetch): tracks gltfInflight decreasing from its peak toward 0.
 * Phase 2 (hydrate): tracks gltfLoaded increasing toward gltfEntities.
 * Returns a value in the ASSET_PROGRESS_START → ASSET_PROGRESS_END range.
 */
function computeAssetProgress(
  stats: SceneHydrationStats,
  peakInflight: number,
  peakEntities: number
): number {
  const fetchFrac = peakInflight > 0
    ? Math.max(0, 1 - stats.gltfInflight / peakInflight)
    : 1
  const hydrateFrac = peakEntities > 0
    ? stats.gltfLoaded / peakEntities
    : 1
  const combined = FETCH_WEIGHT * fetchFrac + HYDRATE_WEIGHT * hydrateFrac
  return ASSET_PROGRESS_START + ASSET_PROGRESS_RANGE * combined
}

/**
 * Pump ECS → Three.js sync until GLBs/textures settle.
 * By default **no hard timeout** — waits until attach-complete (Genesis cold may take several minutes).
 * Pass `timeoutMs` only for explicit bailout testing.
 */
export async function waitForSceneAssets(
  scene: ResolvedScene,
  sceneScript: SceneScriptSystem,
  assets: AssetCache,
  onProgress?: (msg: string, fraction?: number, stats?: SceneHydrationStats) => void,
  options: WaitForSceneAssetsOptions = {}
): Promise<WaitForSceneAssetsResult | void> {
  if (!scene.mainEntry || !scene.entityId) return

  const timeoutMs =
    options.timeoutMs !== undefined && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
      ? options.timeoutMs
      : Number.POSITIVE_INFINITY
  const hasHardTimeout = Number.isFinite(timeoutMs)
  const stableMs = options.stableMs ?? STABLE_MS
  const started = performance.now()
  let stableSince = 0
  let entityStableSince = 0
  let lastEntityCount = -1
  let lastGltfEntities = -1
  let lastMessage = ''
  let lastStats: SceneHydrationStats | null = null
  let lastLoggedLoaded = -1
  let lastStatusLogAt = started

  const manifestGlbCount = countManifestGlbs(scene)
  let peakInflight = 0
  /** Peak resolvable GltfContainer count on projection — drives the attach-complete gate. */
  let peakGltfEntities = 0
  /** Progress denominator — manifest floor until projection publishes GltfContainer. */
  let peakProgressEntities = manifestGlbCount > 0 ? manifestGlbCount : 0

  sceneScript.setAssetHydrationMode(true)
  sceneScript.prefetchGltfs()

  const warmScene = await resolveSceneLoadWarm(assets, scene)
  const bytesWarm = !warmScene && (await resolveSceneBytesWarm(scene))
  /**
   * Bytes only before play. Never bulk-parse the content map into Three templates —
   * soft concurrency=2 still finished 214 parses and left gltfCached≈225 → GC ~1fps.
   * Parse only on GltfContainer attach (clone if already in session cache).
   * Dev-only escape: ?softPrime=1 (explicit, never default).
   */
  onProgress?.('Downloading scene models…')
  const cacheAtStart = assets.getLoadStats().gltfCached
  if (!bytesWarm && !warmScene) {
    // Wait for content-map bytes — no short ceiling; progress continues via attach loop.
    const wait = await assets.waitForPrefetchBytes(Number.POSITIVE_INFINITY)
    clientDebugLog.consoleOnly(
      'info',
      `[Hydration] content-map GLB bytes ready — remainingInflight=${wait.remaining} waited=${(wait.waitedMs / 1000).toFixed(1)}s gltfCached=${cacheAtStart} (no bulk parse)`
    )
  } else {
    clientDebugLog.consoleOnly(
      'info',
      `[Hydration] ${warmScene ? 'session already has templates' : 'IDB bytes warm'} — no bulk parse (gltfCached=${cacheAtStart})`
    )
  }
  // NEVER auto-prime. Prior soft-prime left 214 Three graphs in heap → 1fps at select.
  // Only if you intentionally want template parse for profiling: ?softPrime=1
  const softPrime =
    typeof location !== 'undefined' &&
    new URLSearchParams(location.search).get('softPrime') === '1'
  if (softPrime) {
    console.warn('[Hydration] ?softPrime=1 — background template parse (WILL hurt FPS)')
    void primeManifestParses(assets, scene, 2).catch(() => {})
  }

  const stableRequiredMs = warmScene ? STABLE_WARM_MS : stableMs

  return new Promise((resolve) => {
    let finished = false
    let lastProgressAt = performance.now()

    const finish = (timedOut: boolean, reason?: string) => {
      if (finished) return
      finished = true
      if (hardTimeout !== undefined) window.clearTimeout(hardTimeout)
      sceneScript.setAssetHydrationMode(false)
      // Huge plazas force-ready early — keep soft attach high so the tail still streams in.
      const softMs =
        peakGltfEntities >= HUGE_SCENE_GLTF_THRESHOLD ? Math.max(SOFT_HYDRATION_MS, 20_000) : SOFT_HYDRATION_MS
      sceneScript.extendSoftHydration(softMs)
      if (!timedOut) markSceneHydrated(scene)
      options.onPrimeRender?.()
      if (reason) console.warn(`[Hydration] ${reason}`)
      resolve({ timedOut, elapsedMs: performance.now() - started })
    }

    const forceTimeout = (reason: string) => {
      const elapsed = ((performance.now() - started) / 1000).toFixed(1)
      console.warn(
        `[Hydration] ${reason} after ${elapsed}s — forcing scene ready.`,
        lastStats
          ? `${lastStats.gltfLoaded}/${lastStats.gltfEntities} attached, ${lastStats.gltfPending} pending (${lastStats.gltfAbandoned} abandoned), ${lastStats.gltfInflight} downloading`
          : 'no stats'
      )
      // Always advance the bar past the asset phase — string-only status left the UI
      // stuck at ~79% even after force-ready.
      if (lastStats) onProgress?.(formatTimeout(lastStats), ASSET_PROGRESS_END, lastStats)
      else onProgress?.('Scene assets still loading — continuing in background', ASSET_PROGRESS_END)
      finish(true, reason)
    }

    // Optional explicit bailout only — default is wait-until-attached (no ceiling).
    const hardTimeout = hasHardTimeout
      ? window.setTimeout(() => {
          forceTimeout('Hard timeout')
        }, timeoutMs)
      : undefined

    const tick = async () => {
      if (finished) return
      try {
        if (hasHardTimeout && performance.now() - started >= timeoutMs) {
          forceTimeout('Timeout')
          return
        }

        await yieldToUi()
        if (finished) return
        if (hasHardTimeout && performance.now() - started >= timeoutMs) {
          forceTimeout('Timeout')
          return
        }

        await sceneScript.yieldForWorkerMessages()
        await sceneScript.syncRenderer()
        if (finished) return
        sceneScript.flushHydrationCollisionWork()
        sceneScript.pumpMotionBridges(1 / 60)

        const bridgeStats = sceneScript.getHydrationStats()
        const assetStats = assets.getLoadStats()
        const stats: SceneHydrationStats = bridgeStats ?? {
          entityCount: 0,
          gltfEntities: 0,
          gltfContainers: 0,
          gltfLoaded: 0,
          gltfPending: 0,
          gltfAbandoned: 0,
          gltfUnresolved: 0,
          gltfInflight: assetStats.gltfInflight,
          textureInflight: assetStats.textureInflight
        }
        lastStats = stats
        options.onHydrationTick?.(stats)

        peakInflight = Math.max(peakInflight, stats.gltfInflight)
        peakGltfEntities = Math.max(peakGltfEntities, stats.gltfEntities)
        peakProgressEntities = Math.max(peakProgressEntities, stats.gltfEntities, manifestGlbCount)

        const elapsed = performance.now() - started
        const shouldLogStatus =
          stats.gltfLoaded !== lastLoggedLoaded ||
          elapsed - lastStatusLogAt >= HYDRATION_STATUS_LOG_MS

        if (shouldLogStatus) {
          if (stats.gltfLoaded !== lastLoggedLoaded) {
            lastLoggedLoaded = stats.gltfLoaded
            lastProgressAt = performance.now()
          }
          lastStatusLogAt = performance.now()
          const elapsedSec = (elapsed / 1000).toFixed(1)
          clientDebugLog.consoleOnly(
            'info',
            `[Hydration] ${stats.gltfLoaded}/${stats.gltfEntities} attached (${elapsedSec}s) — ` +
              `${stats.gltfPending} pending (${stats.gltfAbandoned} abandoned), ${stats.gltfInflight} downloading, ` +
              `tex ${stats.textureInflight}, entities ${stats.entityCount}, ` +
              `gltfContainers ${stats.gltfContainers}` +
              (stats.gltfUnresolved ? `, unresolved ${stats.gltfUnresolved}` : '') +
              (manifestGlbCount ? `, manifest ${manifestGlbCount}` : '')
          )
        }

        if (
          stats.gltfEntities === 0 &&
          stats.gltfContainers === 0 &&
          manifestGlbCount > 3 &&
          stats.entityCount > 0 &&
          elapsed >= 10_000 &&
          performance.now() - lastProgressAt >= 10_000
        ) {
          lastProgressAt = performance.now()
          console.warn(
            `[Hydration] no GltfContainer in projection after ${(elapsed / 1000).toFixed(0)}s — ` +
              `${stats.entityCount} entities, worker CRDT may not be reaching renderer (check [sceneWorker] pendingCrdt)`
          )
        }

        if (hasHardTimeout && performance.now() - started >= timeoutMs) {
          forceTimeout('Timeout')
          return
        }

        const pending = blockingPending(stats)
        const ratio =
          stats.gltfEntities > 0 ? stats.gltfLoaded / stats.gltfEntities : 0
        const idleMs = performance.now() - lastProgressAt
        const elapsedNow = performance.now() - started

        // Absolute ceiling — never multi-minute loading screens on 10k–20k instance plazas.
        if (elapsedNow >= maxBlockingHydrateMs(peakGltfEntities)) {
          forceTimeout(
            `Blocking hydrate ceiling (${(elapsedNow / 1000).toFixed(0)}s, ${stats.gltfLoaded}/${stats.gltfEntities} models)`
          )
          return
        }

        // Playable force: enough of the world is up — soft-hydrate the rest after enter.
        if (
          peakGltfEntities >= HUGE_SCENE_GLTF_THRESHOLD &&
          ratio >= PLAYABLE_FORCE_RATIO &&
          elapsedNow >= PLAYABLE_FORCE_MIN_ELAPSED_MS &&
          idleMs >= PLAYABLE_FORCE_STALL_MS
        ) {
          forceTimeout(
            `Playable force-ready (${(ratio * 100).toFixed(0)}% of ${stats.gltfEntities} model instances)`
          )
          return
        }

        if (ENABLE_ATTACH_STALL_BAILOUT && pending > 0) {
          // Allow near-complete bail even with a few downloads still in flight.
          const downloadsQuiet = stats.gltfInflight <= 2 && stats.textureInflight <= 2
          if (stats.gltfInflight === 0 && stats.textureInflight === 0) {
            if (
              idleMs >= ATTACH_STALL_MS ||
              (ratio >= ATTACH_NEAR_COMPLETE_RATIO && idleMs >= ATTACH_NEAR_COMPLETE_STALL_MS)
            ) {
              forceTimeout(
                ratio >= ATTACH_NEAR_COMPLETE_RATIO
                  ? `Attach near-complete (${(ratio * 100).toFixed(0)}%)`
                  : 'Attach stalled'
              )
              return
            }
          } else if (
            downloadsQuiet &&
            ratio >= ATTACH_NEAR_COMPLETE_RATIO &&
            idleMs >= ATTACH_NEAR_COMPLETE_STALL_MS * 1.5
          ) {
            forceTimeout(
              `Attach near-complete with quiet downloads (${(ratio * 100).toFixed(0)}%)`
            )
            return
          }
        }

        if (stats.entityCount !== lastEntityCount) {
          lastEntityCount = stats.entityCount
          entityStableSince = 0
          stableSince = 0
        } else if (entityStableSince === 0) {
          entityStableSince = performance.now()
        }

        if (stats.gltfEntities !== lastGltfEntities) {
          lastGltfEntities = stats.gltfEntities
          entityStableSince = 0
          stableSince = 0
        }

        const message = formatProgress(stats)
        const fraction = peakProgressEntities > 0
          ? computeAssetProgress(stats, peakInflight, peakProgressEntities)
          : undefined
        if (message !== lastMessage || fraction !== undefined) {
          lastMessage = message
          onProgress?.(message, fraction, stats)
        }

        const elapsedMs = performance.now() - started
        const entityStableMs = warmScene
          ? ENTITY_STABLE_FAST_MS
          : entityStableRequiredMs(peakGltfEntities, stats.gltfContainers)
        if (
          isGltfAttachComplete(stats, peakGltfEntities, elapsedMs, manifestGlbCount) &&
          entityStableSince > 0
        ) {
          if (stableSince === 0) stableSince = performance.now()
          const assetsStable = performance.now() - stableSince >= stableRequiredMs
          const entitiesStable = performance.now() - entityStableSince >= entityStableMs
          if (assetsStable && entitiesStable) {
            const elapsed = ((performance.now() - started) / 1000).toFixed(1)
            clientDebugLog.consoleOnly(
              'info',
              `[Hydration] Scene ready in ${elapsed}s — ${stats.gltfLoaded}/${stats.gltfEntities} GLTFs, ${stats.entityCount} entities`
            )
            onProgress?.('Scene ready', ASSET_PROGRESS_END)
            finish(false)
            return
          }
        } else {
          stableSince = 0
        }
      } catch (err) {
        console.warn('[hydration] sync tick failed', err)
      }

      if (!finished) {
        requestAnimationFrame(() => {
          void tick()
        })
      }
    }

    requestAnimationFrame(() => {
      void tick()
    })
  })
}

export { FAST_TIMEOUT_MS, DEFAULT_TIMEOUT_MS }
