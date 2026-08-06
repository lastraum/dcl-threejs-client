/**
 * Lightweight frame counters for Help → RenderStats and `?perfdebug` health lines.
 * Hot path: number assigns only; no object alloc on record.
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
  // --- Frame pipeline (COD / AAA budget) ---
  pendingDiffSize: number
  pendingDiffAgeMaxMs: number
  peelMaterialMs: number
  peelTransformMs: number
  peelGltfMs: number
  peelEntities: number
  pointerEdgeMs: number
  pointerFullDump: number
  syncRendererMs: number
  uiMountPostsPerSec: number
  /** Worker posts dropped by content/rate dedupe (should not include content-blind). */
  uiMountDropsPerSec: number
  /** Main reseed skips when content fp matched (healthy thrash suppression). */
  uiMountReseedSkipsPerSec: number
  vcHydratePerSec: number
  vcPoseLivePerSec: number
  /** PhysX static SQ sealed (1) after boot seal. */
  physxStaticSealed: number
  /** forceDynamicTreeRebuild count after seal — must stay 0 (COD E1). */
  physxPostSealRebuild: number
  /** MeshRenderer GPU instance live count (G2 density). */
  meshRendererInstances: number
  meshRendererBuckets: number
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
  movementSkippedIdle: 0,
  pendingDiffSize: 0,
  pendingDiffAgeMaxMs: 0,
  peelMaterialMs: 0,
  peelTransformMs: 0,
  peelGltfMs: 0,
  peelEntities: 0,
  pointerEdgeMs: 0,
  pointerFullDump: 0,
  syncRendererMs: 0,
  physxStaticSealed: 0,
  physxPostSealRebuild: 0,
  meshRendererInstances: 0,
  meshRendererBuckets: 0
}

let windowSent = 0
let windowSkipped = 0
let windowStart = 0
let sentPerSec = 0
let skippedPerSec = 0

let uiMountWindow = 0
let uiMountDropWindow = 0
let uiMountReseedSkipWindow = 0
let vcHydrateWindow = 0
let vcPoseLiveWindow = 0
let rateWindowStart = 0
let uiMountPerSec = 0
let uiMountDropsPerSec = 0
let uiMountReseedSkipsPerSec = 0
let vcHydratePerSec = 0
let vcPoseLivePerSec = 0

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

/** Latest pendingDiff size + age of oldest entry (ms since first fold). */
export function perfSetPendingDiff(size: number, ageMaxMs: number): void {
  state.pendingDiffSize = size
  state.pendingDiffAgeMaxMs = ageMaxMs
}

/** Material / Transform / Gltf peels this frame (overwrite; last writer wins within frame). */
export function perfNotePeels(opts: {
  materialMs?: number
  transformMs?: number
  gltfMs?: number
  entities?: number
}): void {
  if (opts.materialMs !== undefined) state.peelMaterialMs = opts.materialMs
  if (opts.transformMs !== undefined) state.peelTransformMs = opts.transformMs
  if (opts.gltfMs !== undefined) state.peelGltfMs = opts.gltfMs
  if (opts.entities !== undefined) state.peelEntities = opts.entities
}

/**
 * Last pointer edge wall ms on main (finishPointerDelivery / post path).
 * `fullDump` is **this edge only** (0/1), not a sticky session counter — was latching
 * fullDump=1 forever after one slow peel and looking like a full pendingDiff dump.
 */
export function perfNotePointerEdge(ms: number, fullDump: boolean): void {
  state.pointerEdgeMs = ms
  state.pointerFullDump = fullDump ? 1 : 0
}

export function perfNoteSyncRendererMs(ms: number): void {
  state.syncRendererMs = ms
}

export function perfNoteUiMountPost(): void {
  uiMountWindow++
  rollRateWindow()
}

/** Worker/main dropped an identical or rate-limited UI mount post. */
export function perfNoteUiMountDrop(): void {
  uiMountDropWindow++
  rollRateWindow()
}

/** Main skipped clear+reseed because content fingerprint matched. */
export function perfNoteUiMountReseedSkip(): void {
  uiMountReseedSkipWindow++
  rollRateWindow()
}

export function perfNoteVcHydrate(): void {
  vcHydrateWindow++
  rollRateWindow()
}

export function perfNoteVcPoseLive(): void {
  vcPoseLiveWindow++
  rollRateWindow()
}

/** COD E1 — seal state + post-seal rebuild count (must stay 0 after boot). */
export function perfSetPhysxSeal(opts: { sealed: boolean; postSealRebuild: number }): void {
  state.physxStaticSealed = opts.sealed ? 1 : 0
  state.physxPostSealRebuild = opts.postSealRebuild
}

/** G2 — MeshRenderer GPU instancing density. */
export function perfSetMeshRendererInstanceStats(opts: { instances: number; buckets: number }): void {
  state.meshRendererInstances = opts.instances
  state.meshRendererBuckets = opts.buckets
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

function rollRateWindow(): void {
  const now = performance.now()
  if (rateWindowStart <= 0) {
    rateWindowStart = now
    return
  }
  const elapsed = now - rateWindowStart
  if (elapsed < 1000) return
  const sec = elapsed / 1000
  uiMountPerSec = uiMountWindow / sec
  uiMountDropsPerSec = uiMountDropWindow / sec
  uiMountReseedSkipsPerSec = uiMountReseedSkipWindow / sec
  vcHydratePerSec = vcHydrateWindow / sec
  vcPoseLivePerSec = vcPoseLiveWindow / sec
  uiMountWindow = 0
  uiMountDropWindow = 0
  uiMountReseedSkipWindow = 0
  vcHydrateWindow = 0
  vcPoseLiveWindow = 0
  rateWindowStart = now
}

export function perfSnapshot(): PerfSnapshot {
  rollWindow()
  rollRateWindow()
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
    movementSkippedPerSec: skippedPerSec,
    pendingDiffSize: state.pendingDiffSize,
    pendingDiffAgeMaxMs: state.pendingDiffAgeMaxMs,
    peelMaterialMs: state.peelMaterialMs,
    peelTransformMs: state.peelTransformMs,
    peelGltfMs: state.peelGltfMs,
    peelEntities: state.peelEntities,
    pointerEdgeMs: state.pointerEdgeMs,
    pointerFullDump: state.pointerFullDump,
    syncRendererMs: state.syncRendererMs,
    uiMountPostsPerSec: uiMountPerSec,
    uiMountDropsPerSec: uiMountDropsPerSec,
    uiMountReseedSkipsPerSec: uiMountReseedSkipsPerSec,
    vcHydratePerSec: vcHydratePerSec,
    vcPoseLivePerSec: vcPoseLivePerSec,
    physxStaticSealed: state.physxStaticSealed,
    physxPostSealRebuild: state.physxPostSealRebuild,
    meshRendererInstances: state.meshRendererInstances,
    meshRendererBuckets: state.meshRendererBuckets
  }
}
