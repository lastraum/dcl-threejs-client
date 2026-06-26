import { clientDebugLog } from '../client/debug/ClientDebugLog'
import { usePerfDebug } from '../client/devFlags'

export type MainThreadPerfSample = {
  platformMotionMs: number
  playerUpdateMs: number
  colliderApplyMs: number
}

const LOG_EVERY_FRAMES = 120

let enabled = false
let frameCount = 0
let platformMotionTotal = 0
let playerUpdateTotal = 0
let colliderApplyTotal = 0
let sampleCount = 0

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

/** Call once at boot — `?perfdebug` enables rolling main-thread physics timings. */
export function initMainThreadPerfFromUrl(): void {
  setMainThreadPerfEnabled(usePerfDebug())
  if (enabled) {
    clientDebugLog.log('perf', 'main-thread perf ACTIVE — platform/player/collider ms (?perfdebug)', {
      level: 'success',
      alsoConsole: true
    })
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
  const total = platform + player + collider
  clientDebugLog.log(
    'perf',
    `main avg ${LOG_EVERY_FRAMES}f — platform ${platform.toFixed(2)}ms · player ${player.toFixed(2)}ms · collider ${collider.toFixed(2)}ms · sum ${total.toFixed(2)}ms`,
    { alsoConsole: true }
  )
}