/**
 * Lightweight frame counters for Help → RenderStats.
 * Updated from the play loop; read by RenderStats — no allocation on hot path beyond numbers.
 */

export type PerfSnapshot = {
  remoteVisible: number
  remoteLoaded: number
  remoteComposePending: number
  remoteComposeActive: number
  /** Remotes that skipped full pose lerp this frame (settled root). */
  remotePoseSkipped: number
  /** Remotes that skipped mixer/skeleton this frame (settled loco-idle). */
  remoteAnimSkipped: number
  /** Name tags currently shown (not distance-culled). */
  nameTagsShown: number
  /** Last RemoteAvatarManager.update wall ms. */
  remoteUpdateMs: number
  /** Portion of remote update spent in anim/mixer (approx). */
  remoteAnimMs: number
  /** Last full avatar compose wall ms (0 if none yet). */
  lastComposeMs: number
  /** Peers ticked this frame by LOD band. */
  lodNear: number
  lodMid: number
  lodFar: number
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
  remoteAnimSkipped: 0,
  nameTagsShown: 0,
  remoteUpdateMs: 0,
  remoteAnimMs: 0,
  lastComposeMs: 0,
  lodNear: 0,
  lodMid: 0,
  lodFar: 0,
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
  animSkipped?: number
  nameTagsShown?: number
  remoteUpdateMs?: number
  remoteAnimMs?: number
  lodNear?: number
  lodMid?: number
  lodFar?: number
}): void {
  state.remoteVisible = opts.visible
  state.remoteLoaded = opts.loaded
  state.remoteComposePending = opts.composePending
  state.remoteComposeActive = opts.composeActive
  if (opts.poseSkipped !== undefined) state.remotePoseSkipped = opts.poseSkipped
  if (opts.animSkipped !== undefined) state.remoteAnimSkipped = opts.animSkipped
  if (opts.nameTagsShown !== undefined) state.nameTagsShown = opts.nameTagsShown
  if (opts.remoteUpdateMs !== undefined) state.remoteUpdateMs = opts.remoteUpdateMs
  if (opts.remoteAnimMs !== undefined) state.remoteAnimMs = opts.remoteAnimMs
  if (opts.lodNear !== undefined) state.lodNear = opts.lodNear
  if (opts.lodMid !== undefined) state.lodMid = opts.lodMid
  if (opts.lodFar !== undefined) state.lodFar = opts.lodFar
}

export function perfNoteComposeMs(ms: number): void {
  state.lastComposeMs = ms
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
    remoteAnimSkipped: state.remoteAnimSkipped,
    nameTagsShown: state.nameTagsShown,
    remoteUpdateMs: state.remoteUpdateMs,
    remoteAnimMs: state.remoteAnimMs,
    lastComposeMs: state.lastComposeMs,
    lodNear: state.lodNear,
    lodMid: state.lodMid,
    lodFar: state.lodFar,
    movementSent: state.movementSent,
    movementSkippedIdle: state.movementSkippedIdle,
    movementSentPerSec: sentPerSec,
    movementSkippedPerSec: skippedPerSec
  }
}
