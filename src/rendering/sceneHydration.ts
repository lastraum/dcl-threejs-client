import type { ResolvedScene } from '../dcl/content/types'
import type { AssetCache } from './AssetCache'
import type { SceneScriptSystem } from '../core/systems/SceneScriptSystem'

export type SceneHydrationStats = {
  entityCount: number
  gltfEntities: number
  gltfLoaded: number
  gltfPending: number
  /** Resolved src but empty/broken GLB — will not attach; excluded from blocking gate. */
  gltfAbandoned: number
  gltfUnresolved: number
  gltfInflight: number
  textureInflight: number
}

export type WaitForSceneAssetsOptions = {
  timeoutMs?: number
  stableMs?: number
  onPrimeRender?: () => void
  /** Cook PhysX static colliders after each hydration sync (incremental during GLB attach). */
  onCollidersCook?: () => void
}

export type WaitForSceneAssetsResult = {
  timedOut: boolean
  elapsedMs: number
}

const DEFAULT_TIMEOUT_MS = 180_000
const FAST_TIMEOUT_MS = 90_000
const STABLE_MS = 400
/** Scene scripts keep spawning entities after boot — wait for the count to settle. */
const ENTITY_STABLE_MS = 800
const SOFT_HYDRATION_MS = 8_000
/** No attach progress + no downloads — unrecoverable tail (disabled: loading waits for full attach). */
const ATTACH_STALL_MS = 20_000
const ENABLE_ATTACH_STALL_BAILOUT = false

function yieldToUi(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => resolve())
  })
}

function blockingPending(stats: SceneHydrationStats): number {
  const attachPending = Math.max(0, stats.gltfPending - stats.gltfAbandoned)
  return attachPending + stats.gltfInflight + stats.textureInflight
}

/** All discoverable GLTFs attached — false while entity count still at 0 (worker CRDT not on main yet). */
function isGltfAttachComplete(stats: SceneHydrationStats, peakGltfEntities: number): boolean {
  if (peakGltfEntities <= 0) return false
  const attachPending = Math.max(0, stats.gltfPending - stats.gltfAbandoned)
  return attachPending === 0 && stats.gltfInflight === 0 && stats.textureInflight === 0
}

function formatProgress(stats: SceneHydrationStats): string {
  if (stats.gltfEntities > 0) {
    return `Loading scene assets (${stats.gltfLoaded}/${stats.gltfEntities})…`
  }
  if (blockingPending(stats) > 0) {
    return 'Loading scene assets…'
  }
  return 'Finishing scene load…'
}

function formatTimeout(stats: SceneHydrationStats): string {
  if (stats.gltfEntities > 0) {
    return `Scene still loading (${stats.gltfLoaded}/${stats.gltfEntities} models) — continuing in background`
  }
  return 'Scene assets still loading — continuing in background'
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

/** Pump ECS → Three.js sync until GLBs/textures settle or timeout. Call before `world.start()`. */
export async function waitForSceneAssets(
  scene: ResolvedScene,
  sceneScript: SceneScriptSystem,
  assets: AssetCache,
  onProgress?: (msg: string, fraction?: number, stats?: SceneHydrationStats) => void,
  options: WaitForSceneAssetsOptions = {}
): Promise<WaitForSceneAssetsResult | void> {
  if (!scene.mainEntry || !scene.entityId) return

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const stableMs = options.stableMs ?? STABLE_MS
  const started = performance.now()
  let stableSince = 0
  let entityStableSince = 0
  let lastEntityCount = -1
  let lastGltfEntities = -1
  let lastMessage = ''
  let lastStats: SceneHydrationStats | null = null
  let lastLoggedLoaded = -1

  let peakInflight = 0
  let peakEntities = 0

  sceneScript.setAssetHydrationMode(true)

  return new Promise((resolve) => {
    let finished = false
    let lastProgressAt = performance.now()

    const finish = (timedOut: boolean, reason?: string) => {
      if (finished) return
      finished = true
      window.clearTimeout(hardTimeout)
      sceneScript.setAssetHydrationMode(false)
      sceneScript.notifyPlayReady()
      sceneScript.extendSoftHydration(SOFT_HYDRATION_MS)
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
      if (lastStats) onProgress?.(formatTimeout(lastStats))
      else onProgress?.('Scene assets still loading — continuing in background')
      finish(true, reason)
    }

    const hardTimeout = window.setTimeout(() => {
      forceTimeout('Hard timeout')
    }, timeoutMs)

    const tick = async () => {
      if (finished) return
      try {
        if (performance.now() - started >= timeoutMs) {
          forceTimeout('Timeout')
          return
        }

        await yieldToUi()
        if (finished || performance.now() - started >= timeoutMs) {
          forceTimeout('Timeout')
          return
        }

        await sceneScript.syncRenderer()
        if (finished) return
        sceneScript.syncCollisionForce()
        options.onCollidersCook?.()
        sceneScript.pumpMotionBridges(1 / 60)

        const bridgeStats = sceneScript.getHydrationStats()
        const assetStats = assets.getLoadStats()
        const stats: SceneHydrationStats = bridgeStats ?? {
          entityCount: 0,
          gltfEntities: 0,
          gltfLoaded: 0,
          gltfPending: 0,
          gltfAbandoned: 0,
          gltfUnresolved: 0,
          gltfInflight: assetStats.gltfInflight,
          textureInflight: assetStats.textureInflight
        }
        lastStats = stats

        peakInflight = Math.max(peakInflight, stats.gltfInflight)
        peakEntities = Math.max(peakEntities, stats.gltfEntities)

        if (stats.gltfLoaded !== lastLoggedLoaded) {
          lastLoggedLoaded = stats.gltfLoaded
          lastProgressAt = performance.now()
          const elapsed = ((performance.now() - started) / 1000).toFixed(1)
          console.info(
            `[Hydration] ${stats.gltfLoaded}/${stats.gltfEntities} attached (${elapsed}s) — ${stats.gltfPending} pending (${stats.gltfAbandoned} abandoned), ${stats.gltfInflight} downloading, tex ${stats.textureInflight}, entities ${stats.entityCount}`
          )
        }

        if (performance.now() - started >= timeoutMs) {
          forceTimeout('Timeout')
          return
        }

        const pending = blockingPending(stats)
        if (
          ENABLE_ATTACH_STALL_BAILOUT &&
          pending > 0 &&
          stats.gltfInflight === 0 &&
          stats.textureInflight === 0 &&
          performance.now() - lastProgressAt >= ATTACH_STALL_MS
        ) {
          forceTimeout('Attach stalled')
          return
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
        const fraction = peakEntities > 0
          ? computeAssetProgress(stats, peakInflight, peakEntities)
          : undefined
        if (message !== lastMessage || fraction !== undefined) {
          lastMessage = message
          onProgress?.(message, fraction, stats)
        }

        if (isGltfAttachComplete(stats, peakEntities) && entityStableSince > 0) {
          if (stableSince === 0) stableSince = performance.now()
          const assetsStable = performance.now() - stableSince >= stableMs
          const entitiesStable = performance.now() - entityStableSince >= ENTITY_STABLE_MS
          if (assetsStable && entitiesStable) {
            const elapsed = ((performance.now() - started) / 1000).toFixed(1)
            console.info(
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
