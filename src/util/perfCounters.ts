/**
 * Lightweight frame counters for Help → RenderStats (Phase A measure).
 * Updated from the play loop; read by RenderStats — no allocation on hot path beyond numbers.
 */

export type PerfSnapshot = {
  remoteVisible: number
  remoteLoaded: number
  remoteComposePending: number
  remoteComposeActive: number
  /** Remotes that skipped full pose/anim work this frame (settled). */
  remotePoseSkipped: number
  /** Name tags currently shown (not distance-culled). */
  nameTagsShown: number
  movementSent: number
  movementSkippedIdle: number
  /** Rolling 1s rates derived in RenderStats. */
  movementSentPerSec: number
  movementSkippedPerSec: number
}

const state = {
  remoteVisible: 0,
  remoteLoaded: 0,
  remoteComposePending: 0,
  remoteComposeActive: 0,
  remotePoseSkipped: 0,
  nameTagsShown: 0,
  movementSent: 0,
  movementSkippedIdle: 0
}

let windowSent = 0
let windowSkipped = 0
let windowStart = 0
let sentPerSec = 0
let skippedPerSec = 0

export function perfSetRemoteStats(opts: {
  visible: number
  loaded: number
  composePending: number
  composeActive: number
  poseSkipped?: number
  nameTagsShown?: number
}): void {
  state.remoteVisible = opts.visible
  state.remoteLoaded = opts.loaded
  state.remoteComposePending = opts.composePending
  state.remoteComposeActive = opts.composeActive
  if (opts.poseSkipped !== undefined) state.remotePoseSkipped = opts.poseSkipped
  if (opts.nameTagsShown !== undefined) state.nameTagsShown = opts.nameTagsShown
}

export function perfNoteMovementSent(): void {
  state.movementSent++
  windowSent++
  rollWindow()
}

export function perfNoteMovementSkippedIdle(): void {
  state.movementSkippedIdle++
  windowSkipped++
  rollWindow()
}

function rollWindow(): void {
  const now = performance.now()
  if (windowStart <= 0) {
    windowStart = now
    return
  }
  const elapsed = now - windowStart
  if (elapsed < 1000) return
  const sec = elapsed / 1000
  sentPerSec = windowSent / sec
  skippedPerSec = windowSkipped / sec
  windowSent = 0
  windowSkipped = 0
  windowStart = now
}

export function perfSnapshot(): PerfSnapshot {
  rollWindow()
  return {
    remoteVisible: state.remoteVisible,
    remoteLoaded: state.remoteLoaded,
    remoteComposePending: state.remoteComposePending,
    remoteComposeActive: state.remoteComposeActive,
    remotePoseSkipped: state.remotePoseSkipped,
    nameTagsShown: state.nameTagsShown,
    movementSent: state.movementSent,
    movementSkippedIdle: state.movementSkippedIdle,
    movementSentPerSec: sentPerSec,
    movementSkippedPerSec: skippedPerSec
  }
}
