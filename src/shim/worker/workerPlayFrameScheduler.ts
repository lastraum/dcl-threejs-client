import { coalesceCrdtChunksLww } from './workerSceneUiCrdtOutbound'
import { SKIP_ENGINE_UPDATE_KEY } from './patchSdkOnUpdatePollEvents'

/** Play-mode cold CRDT chunks — flushed once per unified play frame (no ack). */
const playModeColdCrdtBuffer: Uint8Array[] = []

let playFramePollInFlight = false

export function isPlayFramePollInFlight(): boolean {
  return playFramePollInFlight
}

/** Buffer non-pointer play-mode CRDT for end-of-frame coalesced egress. */
export function bufferPlayModeColdCrdt(chunk: Uint8Array): void {
  if (!chunk.byteLength) return
  playModeColdCrdtBuffer.push(chunk)
}

export function clearPlayModeColdCrdtBuffer(): void {
  playModeColdCrdtBuffer.length = 0
}

export function flushPlayModeColdCrdtEgress(post: (data: Uint8Array) => void): void {
  if (!playModeColdCrdtBuffer.length) return
  const coalesced = coalesceCrdtChunksLww(playModeColdCrdtBuffer.splice(0))
  for (const chunk of coalesced) {
    if (chunk.byteLength) post(chunk)
  }
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