import { clientDebugLog } from '../client/debug/ClientDebugLog'
import { usePerfDebug } from '../client/devFlags'
import { perfSnapshot } from '../util/perfCounters'

export type MainThreadPerfSample = {
  platformMotionMs: number
  playerUpdateMs: number
  colliderApplyMs: number
  /** Optional wall ms for whole frame phases (set from World when available). */
  syncRendererMs?: number
  frameDtMs?: number
}

const LOG_EVERY_FRAMES = 120
/** Also log immediately when pendingDiff age or size breaches SLO. */
const PENDING_AGE_BREACH_MS = 500
const PENDING_SIZE_BREACH = 200

let enabled = false
let frameCount = 0
let platformMotionTotal = 0
let playerUpdateTotal = 0
let colliderApplyTotal = 0
let sampleCount = 0
let lastBreachLogAt = 0

export function setMainThreadPerfEnabled(next: boolean): void {
  enabled = next
  if (!enabled) {
    frameCount = 0
    platformMotionTotal = 0
    playerUpdateTotal = 0
    colliderApplyTotal = 0
    sampleCount = 0
  }
}

export function isMainThreadPerfEnabled(): boolean {
  return enabled
}

/** Call once at boot — `?perfdebug` enables rolling main-thread + pipeline health. */
export function initMainThreadPerfFromUrl(): void {
  setMainThreadPerfEnabled(usePerfDebug())
  if (enabled) {
    clientDebugLog.log(
      'perf',
      'frame budget ACTIVE — [frame] health every 120f + breach (?perfdebug)',
      { level: 'success', alsoConsole: true }
    )
  }
}

export function recordMainThreadPerf(sample: MainThreadPerfSample): void {
  if (!enabled) return
  if (sample.platformMotionMs > 0 || sample.playerUpdateMs > 0) {
    platformMotionTotal += sample.platformMotionMs
    playerUpdateTotal += sample.playerUpdateMs
    sampleCount++
    frameCount++
  }
  if (sample.colliderApplyMs > 0) {
    colliderApplyTotal += sample.colliderApplyMs
  }

  const snap = perfSnapshot()
  const now = performance.now()
  const breach =
    snap.pendingDiffAgeMaxMs >= PENDING_AGE_BREACH_MS ||
    snap.pendingDiffSize >= PENDING_SIZE_BREACH ||
    snap.pointerFullDump > 0
  if (breach && now - lastBreachLogAt >= 2000) {
    lastBreachLogAt = now
    logFrameHealth('BREACH', sample, snap)
  }

  if (frameCount < LOG_EVERY_FRAMES) return
  frameCount = 0
  const n = Math.max(1, sampleCount)
  const platform = platformMotionTotal / n
  const player = playerUpdateTotal / n
  const collider = colliderApplyTotal / n
  platformMotionTotal = 0
  playerUpdateTotal = 0
  colliderApplyTotal = 0
  sampleCount = 0
  logFrameHealth(
    'ok',
    {
      platformMotionMs: platform,
      playerUpdateMs: player,
      colliderApplyMs: collider,
      frameDtMs: sample.frameDtMs
    },
    snap
  )
}

function logFrameHealth(
  kind: 'ok' | 'BREACH',
  sample: MainThreadPerfSample,
  snap: ReturnType<typeof perfSnapshot>
): void {
  const peel = snap.peelMaterialMs + snap.peelTransformMs + snap.peelGltfMs
  const line =
    `[frame] ${kind} ` +
    `platform=${sample.platformMotionMs.toFixed(1)} ` +
    `player=${sample.playerUpdateMs.toFixed(1)} ` +
    `collider=${sample.colliderApplyMs.toFixed(1)} ` +
    `syncR=${snap.syncRendererMs.toFixed(1)} ` +
    `peel=${peel.toFixed(1)}(m${snap.peelMaterialMs.toFixed(1)}/t${snap.peelTransformMs.toFixed(1)}/g${snap.peelGltfMs.toFixed(1)} e${snap.peelEntities}) ` +
    `pendingDiff=${snap.pendingDiffSize} ageMax=${snap.pendingDiffAgeMaxMs.toFixed(0)}ms ` +
    `ptrEdge=${snap.pointerEdgeMs.toFixed(1)} fullDump=${snap.pointerFullDump} ` +
    `uiMount/s=${snap.uiMountPostsPerSec.toFixed(1)} ` +
    `vcHydrate/s=${snap.vcHydratePerSec.toFixed(1)} poseLive/s=${snap.vcPoseLivePerSec.toFixed(1)} ` +
    `remotes=${snap.remoteVisible} remoteMs=${snap.remoteUpdateMs.toFixed(1)}`
  clientDebugLog.log('perf', line, {
    alsoConsole: true,
    level: kind === 'BREACH' ? 'warn' : 'info'
  })
}
