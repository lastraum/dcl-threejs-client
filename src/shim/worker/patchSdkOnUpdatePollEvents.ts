import { isWorkerMoveCameraFlightLatched } from './workerPlayerFrameEgress'

/**
 * SDK default exports.onUpdate ends with pollEvents(sendBatch). After an inject-only UI pointer
 * click, the next cooperative onUpdate replays that batch and undoes handler egress (MOVE CAMERA
 * toggle, InputModifier freeze). Skip pollEvents once — engine.update already ran in the pointer tick.
 *
 * Phase 2 — cooperative tick runs engine.update; onUpdate runs pollEvents only via SKIP_ENGINE_UPDATE.
 */
export const DEFER_SDK_POLL_EVENTS_KEY = '__THREEJS_DEFER_SDK_POLL_EVENTS__'
export const DEFER_SDK_POLL_EVENTS_LATCH_KEY = '__THREEJS_DEFER_SDK_POLL_EVENTS_LATCH__'
export const SKIP_ENGINE_UPDATE_KEY = '__THREEJS_SKIP_ENGINE_UPDATE_THIS_FRAME__'

const SDK_ON_UPDATE_RE =
  /async function onUpdate\((\w+)\)\s*\{\s*engine\.seal\(\);\s*await engine\.update\(\1\);\s*await pollEvents\(([^)]+)\);\s*\}/

const SDK_ON_UPDATE_PATCHED_LEGACY_RE =
  /async function onUpdate\((\w+)\)\{engine\.seal\(\);await engine\.update\(\1\);if\(globalThis\.(__THREEJS_DEFER_SDK_POLL_EVENTS__)\)\{globalThis\.\2=false\}else\{await pollEvents\(([^)]+)\)\}\}/

const SDK_ON_UPDATE_PATCHED_RE = new RegExp(
  `async function onUpdate\\((\\w+)\\)\\{engine\\.seal\\(\\);` +
    `if\\(!globalThis\\.${SKIP_ENGINE_UPDATE_KEY}\\)\\{await engine\\.update\\(\\1\\)\\}` +
    `if\\(globalThis\\.(${DEFER_SDK_POLL_EVENTS_KEY})\\)\\{globalThis\\.\\2=false\\}` +
    `else if\\(!\\(globalThis\\.${DEFER_SDK_POLL_EVENTS_LATCH_KEY}&&globalThis\\.${DEFER_SDK_POLL_EVENTS_LATCH_KEY}\\(\\)\\)\\)` +
    `\\{await pollEvents\\(([^)]+)\\)\\}\\}`
)

function wrapOnUpdatePlayFrameBoundary(dtVar: string, pollArg: string): string {
  return (
    `async function onUpdate(${dtVar}){engine.seal();` +
    `if(!globalThis.${SKIP_ENGINE_UPDATE_KEY}){await engine.update(${dtVar})}` +
    `if(globalThis.${DEFER_SDK_POLL_EVENTS_KEY}){globalThis.${DEFER_SDK_POLL_EVENTS_KEY}=false}` +
    `else if(!(globalThis.${DEFER_SDK_POLL_EVENTS_LATCH_KEY}&&globalThis.${DEFER_SDK_POLL_EVENTS_LATCH_KEY}()))` +
    `{await pollEvents(${pollArg})}}`
  )
}

export function patchSdkOnUpdatePollEventsBoundary(code: string): { code: string; applied: boolean } {
  let applied = false
  let out = code
  if (SDK_ON_UPDATE_RE.test(out)) {
    SDK_ON_UPDATE_RE.lastIndex = 0
    out = out.replace(SDK_ON_UPDATE_RE, (_match, dtVar, pollArg) => {
      applied = true
      return wrapOnUpdatePlayFrameBoundary(dtVar, pollArg)
    })
  }
  if (SDK_ON_UPDATE_PATCHED_LEGACY_RE.test(out)) {
    SDK_ON_UPDATE_PATCHED_LEGACY_RE.lastIndex = 0
    out = out.replace(SDK_ON_UPDATE_PATCHED_LEGACY_RE, (_match, dtVar, _key, pollArg) => {
      applied = true
      return wrapOnUpdatePlayFrameBoundary(dtVar, pollArg)
    })
  }
  if (SDK_ON_UPDATE_PATCHED_RE.test(out)) {
    SDK_ON_UPDATE_PATCHED_RE.lastIndex = 0
    out = out.replace(SDK_ON_UPDATE_PATCHED_RE, (_match, dtVar, _deferKey, pollArg) => {
      applied = true
      return wrapOnUpdatePlayFrameBoundary(dtVar, pollArg)
    })
  }
  return { code: out, applied }
}

export function installSdkPollEventsLatchHook(): void {
  const g = globalThis as Record<string, unknown>
  // Only MOVE CAMERA — scene freezes (Flagtag lobby) must keep pollEvents running
  // so join / CUSTOM_EVENT / UI handlers still process.
  g[DEFER_SDK_POLL_EVENTS_LATCH_KEY] = () => isWorkerMoveCameraFlightLatched()
}

export function markDeferSdkPollEventsAfterInjectUiClick(): void {
  ;(globalThis as Record<string, unknown>)[DEFER_SDK_POLL_EVENTS_KEY] = true
}

/** Drop one-shot defer after stuck tick recovery so later onUpdate can pollEvents again. */
export function clearInjectOnlySdkPollEventsDeferred(): void {
  ;(globalThis as Record<string, unknown>)[DEFER_SDK_POLL_EVENTS_KEY] = false
}

/** One-shot flag after inject-only UI click — cleared on the next exports.onUpdate. */
export function isInjectOnlySdkPollEventsDeferred(): boolean {
  return !!(globalThis as Record<string, unknown>)[DEFER_SDK_POLL_EVENTS_KEY]
}

/**
 * True while MOVE CAMERA freeze latch is active or after inject-only UI click (one onUpdate).
 * Scene lock-all freezes (Flagtag lobby) do NOT defer pollEvents.
 * Do NOT use this to gate react-ecs.
 */
export function isSdkPollEventsDeferred(): boolean {
  if (isWorkerMoveCameraFlightLatched()) return true
  return isInjectOnlySdkPollEventsDeferred()
}