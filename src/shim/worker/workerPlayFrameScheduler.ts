import { SKIP_ENGINE_UPDATE_KEY } from './patchSdkOnUpdatePollEvents'

let playFramePollInFlight = false

export function isPlayFramePollInFlight(): boolean {
  return playFramePollInFlight
}

function markSkipEngineUpdateThisFrame(): void {
  ;(globalThis as Record<string, unknown>)[SKIP_ENGINE_UPDATE_KEY] = true
}

function clearSkipEngineUpdateThisFrame(): void {
  ;(globalThis as Record<string, unknown>)[SKIP_ENGINE_UPDATE_KEY] = false
}

/**
 * Phase 2 — pollEvents-only leg of exports.onUpdate after cooperative engine.update.
 * engine.seal() + pollEvents run inside the patched SDK onUpdate boundary.
 */
export async function runPlayFramePollPhase(
  sceneOnUpdate: ((dt: number) => unknown) | null,
  dt: number
): Promise<void> {
  if (!sceneOnUpdate || playFramePollInFlight) return
  playFramePollInFlight = true
  markSkipEngineUpdateThisFrame()
  try {
    await Promise.resolve(sceneOnUpdate(dt))
  } finally {
    clearSkipEngineUpdateThisFrame()
    playFramePollInFlight = false
  }
}