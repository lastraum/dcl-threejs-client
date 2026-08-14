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
  gltfInstances: number
  gltfInstanceBuckets: number
  gltfInstanceDraws: number
  /** Remote peers tracked / with pose / neon shell / full body. */
  remotePeerTotal: number
  remotePlaceholder: number
  /** Compose queue gate (hold / hydration / wait count). */
  remoteComposeWaiting: number
  remoteComposeHold: number
  remoteComposeHydration: number
  remoteComposePressure: number
  remoteComposeGapMs: number
  // --- Main-thread frame pie (split of former "other") ---
  /** Completed rAF wall ms (sync + render + loop overhead). */
  frameMs: number
  /** Rolling display FPS (~1s window from SceneHost). */
  fps: number
  /** onSyncFrame wall ms. */
  syncMs: number
  /** WebGL main pass + name tags wall ms. */
  renderMs: number
  /** Last onAsyncFrame wall ms (does not always sit on the sync rAF). */
  asyncMs: number
  /** Player CCT / input update wall ms (subset of sync). */
  playerMs: number
  /** Platform motion / PE VC select wall ms (subset of sync). */
  platformMs: number
  /** ParticleSystemBridge.update wall ms (subset of sync / motion). */
  particleMs: number
  /** Last main CRDT apply wall ms (worker→main; may be outside this rAF). */
  applyMs: number
  /**
   * Unmetered inside sync after known sub-buckets (clamped ≥0).
   */
  syncRestMs: number
  /**
   * Unmetered outside sync/render: frame − sync − render (clamped ≥0).
   * Browser/GC/DevTools, frameListeners, clock — residual loop "other".
   */
  loopRestMs: number
  // --- sync+ sub-split ---
  /** Ocean / grass / env / lights at top of onSyncFrame. */
  envMs: number
  /** Pet leash + remote pets. */
  petMs: number
  /** PE + live-secondary motion bridges. */
  peMs: number
  /** tickPlayFrame + multiScene.tickSync + client entity sync + triggers. */
  sceneTickMs: number
  /** AOI tertiary + scene promote. */
  aoiMs: number
  /** Pointer raycast prep + PE pointer edges (sync tail). */
  pointerMs: number
  /** SceneLoop send / receive / apply (host guest clock). */
  sceneLoopSendMs: number
  sceneLoopReceiveMs: number
  sceneLoopApplyMs: number
  sceneLoopInFlight: number
  sceneLoopDue: number
  sceneLoopGuests: number
  sceneLoopSent: number
  // --- render sub-split ---
  /** WebGL scene pass (forward or bloom path). */
  renderMainMs: number
  /** NameTagRenderer CSS/3D labels. */
  renderTagsMs: number
  /**
   * Beauty geometry wall (ms). Includes three.js shadow maps when shadows on
   * (baked into renderer.render). Bloom-fast: whole composer lives here.
   */
  renderSceneMs: number
  /** Selective bloom: material-swap + half-res emissive extract. */
  renderExtractMs: number
  /** Selective composite / additive pure-bloom blit (0 on fast — folded into scene). */
  renderBloomMs: number
  /** MSAA resolve blit (forward only). */
  renderBlitMs: number
  /** forward | bloom-fast | bloom-selective */
  renderMode: string
  /** renderer.shadowMap.enabled this frame. */
  renderShadowOn: number
  /** WebGLRenderer.info.render.calls after main pass. */
  renderDrawCalls: number
  /** WebGLRenderer.info.render.triangles after main pass. */
  renderTriangles: number
  // --- async~ sub-split (last onAsyncFrame) ---
  /** syncRenderer / CRDT peel drain. */
  asyncPeelMs: number
  /** Async pointer prepare (subset; often ~0). */
  asyncPtrMs: number
  /** syncCollision + applyPhysicsColliders. */
  asyncCollisionMs: number
  /** syncAsyncBridges + animator PART poses. */
  asyncBridgesMs: number
  /** multiScene.tickAsync + PE/secondary collider cook. */
  asyncMultiMs: number
  /** async total − known subs (clamped ≥0). */
  asyncRestMs: number
  // --- async coll sub-split ---
  /** syncCollision (structure extract + pose dirty). */
  asyncCollSyncMs: number
  /** applyColliderPoseSlides into PhysX. */
  asyncCollPoseMs: number
  /** maybeDiscoverMissingColliderActors. */
  asyncCollDiscoverMs: number
  /** reconcile cook queue + schedule drain. */
  asyncCollCookMs: number
  /** SQ soft probe / heal (throttled). */
  asyncCollWatchMs: number
  /** Health log + getAllPhysicsColliderDescs walk. */
  asyncCollHealthMs: number
  /** coll total − known coll subs. */
  asyncCollRestMs: number
  /** Live PhysX cook queue depth (for coll thrash diagnosis). */
  colliderCookQueueSize: number
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
  meshRendererBuckets: 0,
  gltfInstances: 0,
  gltfInstanceBuckets: 0,
  gltfInstanceDraws: 0,
  remotePeerTotal: 0,
  remotePlaceholder: 0,
  remoteComposeWaiting: 0,
  remoteComposeHold: 0,
  remoteComposeHydration: 0,
  remoteComposePressure: 0,
  remoteComposeGapMs: 0,
  frameMs: 0,
  fps: 0,
  syncMs: 0,
  renderMs: 0,
  asyncMs: 0,
  playerMs: 0,
  platformMs: 0,
  particleMs: 0,
  applyMs: 0,
  syncRestMs: 0,
  loopRestMs: 0,
  envMs: 0,
  petMs: 0,
  peMs: 0,
  sceneTickMs: 0,
  aoiMs: 0,
  pointerMs: 0,
  sceneLoopSendMs: 0,
  sceneLoopReceiveMs: 0,
  sceneLoopApplyMs: 0,
  sceneLoopInFlight: 0,
  sceneLoopDue: 0,
  sceneLoopGuests: 0,
  sceneLoopSent: 0,
  renderMainMs: 0,
  renderTagsMs: 0,
  renderSceneMs: 0,
  renderExtractMs: 0,
  renderBloomMs: 0,
  renderBlitMs: 0,
  renderMode: 'forward',
  renderShadowOn: 0,
  renderDrawCalls: 0,
  renderTriangles: 0,
  asyncPeelMs: 0,
  asyncPtrMs: 0,
  asyncCollisionMs: 0,
  asyncBridgesMs: 0,
  asyncMultiMs: 0,
  asyncRestMs: 0,
  asyncCollSyncMs: 0,
  asyncCollPoseMs: 0,
  asyncCollDiscoverMs: 0,
  asyncCollCookMs: 0,
  asyncCollWatchMs: 0,
  asyncCollHealthMs: 0,
  asyncCollRestMs: 0,
  colliderCookQueueSize: 0
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
  peerTotal?: number
  placeholder?: number
  composeWaiting?: number
  composeHold?: boolean
  composeHydration?: boolean
  composePressure?: boolean
  composeGapMs?: number
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
  if (opts.peerTotal !== undefined) state.remotePeerTotal = opts.peerTotal
  if (opts.placeholder !== undefined) state.remotePlaceholder = opts.placeholder
  if (opts.composeWaiting !== undefined) state.remoteComposeWaiting = opts.composeWaiting
  if (opts.composeHold !== undefined) state.remoteComposeHold = opts.composeHold ? 1 : 0
  if (opts.composeHydration !== undefined) {
    state.remoteComposeHydration = opts.composeHydration ? 1 : 0
  }
  if (opts.composePressure !== undefined) {
    state.remoteComposePressure = opts.composePressure ? 1 : 0
  }
  if (opts.composeGapMs !== undefined) state.remoteComposeGapMs = opts.composeGapMs
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
export function perfSetMeshRendererInstanceStats(opts: {
  instances: number
  buckets: number
  gltfInstances?: number
  gltfBuckets?: number
  gltfDraws?: number
}): void {
  state.meshRendererInstances = opts.instances
  state.meshRendererBuckets = opts.buckets
  if (opts.gltfInstances !== undefined) state.gltfInstances = opts.gltfInstances
  if (opts.gltfBuckets !== undefined) state.gltfInstanceBuckets = opts.gltfBuckets
  if (opts.gltfDraws !== undefined) state.gltfInstanceDraws = opts.gltfDraws
}

/** ParticleSystemBridge.update wall (subset of sync / motion bridges). */
export function perfNoteParticleMs(ms: number): void {
  state.particleMs = ms
}

/** Player CCT + platform motion walls from World.sync (subset of sync). */
export function perfNoteSyncSubsystems(opts: { playerMs?: number; platformMs?: number }): void {
  if (opts.playerMs !== undefined) state.playerMs = opts.playerMs
  if (opts.platformMs !== undefined) state.platformMs = opts.platformMs
}

/**
 * sync+ sub-buckets (mutually exclusive slices of onSyncFrame; rem/player/plat separate).
 * `part` lives inside platform motion (pumpMotionBridges) — not re-added here.
 */
export function perfNoteSyncPlus(opts: {
  envMs?: number
  petMs?: number
  peMs?: number
  sceneTickMs?: number
  aoiMs?: number
  pointerMs?: number
}): void {
  if (opts.envMs !== undefined) state.envMs = opts.envMs
  if (opts.petMs !== undefined) state.petMs = opts.petMs
  if (opts.peMs !== undefined) state.peMs = opts.peMs
  if (opts.sceneTickMs !== undefined) state.sceneTickMs = opts.sceneTickMs
  if (opts.aoiMs !== undefined) state.aoiMs = opts.aoiMs
  if (opts.pointerMs !== undefined) state.pointerMs = opts.pointerMs
}

/** Last main-thread CRDT apply wall (worker→main batch). */
export function perfNoteApplyMs(ms: number): void {
  state.applyMs = ms
}

/** Host SceneLoop phase walls (send on sync, apply on async peel). */
export function perfNoteSceneLoop(opts: {
  sendMs: number
  receiveMs: number
  applyMs: number
  leftoverMs?: number
  inFlight: number
  due: number
  guests: number
  sent: number
}): void {
  state.sceneLoopSendMs = opts.sendMs
  state.sceneLoopReceiveMs = opts.receiveMs
  state.sceneLoopApplyMs = opts.applyMs
  state.sceneLoopInFlight = opts.inFlight
  state.sceneLoopDue = opts.due
  state.sceneLoopGuests = opts.guests
  state.sceneLoopSent = opts.sent
}

/** SceneHost render sub-split (main pass vs name tags + scene/bloom/extract). */
export function perfNoteRenderSplit(opts: {
  mainMs: number
  tagsMs: number
  sceneMs?: number
  extractMs?: number
  bloomMs?: number
  blitMs?: number
  mode?: string
  shadowOn?: boolean
  drawCalls?: number
  triangles?: number
}): void {
  state.renderMainMs = opts.mainMs
  state.renderTagsMs = opts.tagsMs
  state.renderSceneMs = opts.sceneMs ?? 0
  state.renderExtractMs = opts.extractMs ?? 0
  state.renderBloomMs = opts.bloomMs ?? 0
  state.renderBlitMs = opts.blitMs ?? 0
  state.renderMode = opts.mode ?? 'forward'
  state.renderShadowOn = opts.shadowOn ? 1 : 0
  state.renderDrawCalls = opts.drawCalls ?? 0
  state.renderTriangles = opts.triangles ?? 0
}

/**
 * Last onAsyncFrame sub-split. Also refreshes {@link state.asyncMs} to the full wall
 * so HUD matches the breakdown (SceneHost lastAsync can lag one frame).
 */
export function perfNoteAsyncSplit(opts: {
  totalMs: number
  peelMs: number
  ptrMs?: number
  collisionMs: number
  bridgesMs: number
  multiMs: number
}): void {
  state.asyncMs = opts.totalMs
  state.asyncPeelMs = opts.peelMs
  state.asyncPtrMs = opts.ptrMs ?? 0
  state.asyncCollisionMs = opts.collisionMs
  state.asyncBridgesMs = opts.bridgesMs
  state.asyncMultiMs = opts.multiMs
  const known =
    state.asyncPeelMs +
    state.asyncPtrMs +
    state.asyncCollisionMs +
    state.asyncBridgesMs +
    state.asyncMultiMs
  state.asyncRestMs = Math.max(0, opts.totalMs - known)
  // Keep pipeline health line in sync.
  state.syncRendererMs = opts.peelMs
}

/** Sub-split of {@link state.asyncCollisionMs} (last applyPhysicsColliders). */
export function perfNoteAsyncCollSplit(opts: {
  syncMs: number
  poseMs: number
  discoverMs: number
  cookMs: number
  watchMs: number
  healthMs: number
  totalMs: number
  queueSize?: number
}): void {
  state.asyncCollSyncMs = opts.syncMs
  state.asyncCollPoseMs = opts.poseMs
  state.asyncCollDiscoverMs = opts.discoverMs
  state.asyncCollCookMs = opts.cookMs
  state.asyncCollWatchMs = opts.watchMs
  state.asyncCollHealthMs = opts.healthMs
  if (opts.queueSize !== undefined) state.colliderCookQueueSize = opts.queueSize
  const known =
    opts.syncMs + opts.poseMs + opts.discoverMs + opts.cookMs + opts.watchMs + opts.healthMs
  state.asyncCollRestMs = Math.max(0, opts.totalMs - known)
}

/**
 * SceneHost rAF host pie — recomputes syncRest / loopRest from latest subsystem samples.
 * Call once per completed frame after sync/render walls are known.
 *
 * Accounting (no double-count): rem + player + platform cover major paths;
 * particle is nested under platform (pumpMotionBridges). sync+ subs are nested
 * under the residual (env/pet/pe/scene/aoi/pointer) for HUD only — residual is
 * still frame math against rem+player+plat.
 */
/** Last completed rAF wall ms (0 before the first frame). */
export function getLastFrameMs(): number {
  return state.frameMs
}

export function perfNoteFrameHost(opts: {
  frameMs: number
  syncMs: number
  renderMs: number
  asyncMs?: number
  fps?: number
}): void {
  state.frameMs = opts.frameMs
  state.syncMs = opts.syncMs
  state.renderMs = opts.renderMs
  if (opts.asyncMs !== undefined) state.asyncMs = opts.asyncMs
  if (opts.fps !== undefined) state.fps = opts.fps

  // part is inside platform — do not subtract twice.
  const syncAccounted = state.remoteUpdateMs + state.playerMs + state.platformMs
  state.syncRestMs = Math.max(0, state.syncMs - syncAccounted)
  state.loopRestMs = Math.max(0, state.frameMs - state.syncMs - state.renderMs)
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
    meshRendererBuckets: state.meshRendererBuckets,
    gltfInstances: state.gltfInstances,
    gltfInstanceBuckets: state.gltfInstanceBuckets,
    gltfInstanceDraws: state.gltfInstanceDraws,
    remotePeerTotal: state.remotePeerTotal,
    remotePlaceholder: state.remotePlaceholder,
    remoteComposeWaiting: state.remoteComposeWaiting,
    remoteComposeHold: state.remoteComposeHold,
    remoteComposeHydration: state.remoteComposeHydration,
    remoteComposePressure: state.remoteComposePressure,
    remoteComposeGapMs: state.remoteComposeGapMs,
    frameMs: state.frameMs,
    fps: state.fps,
    syncMs: state.syncMs,
    renderMs: state.renderMs,
    asyncMs: state.asyncMs,
    playerMs: state.playerMs,
    platformMs: state.platformMs,
    particleMs: state.particleMs,
    applyMs: state.applyMs,
    syncRestMs: state.syncRestMs,
    loopRestMs: state.loopRestMs,
    envMs: state.envMs,
    petMs: state.petMs,
    peMs: state.peMs,
    sceneTickMs: state.sceneTickMs,
    aoiMs: state.aoiMs,
    pointerMs: state.pointerMs,
    sceneLoopSendMs: state.sceneLoopSendMs,
    sceneLoopReceiveMs: state.sceneLoopReceiveMs,
    sceneLoopApplyMs: state.sceneLoopApplyMs,
    sceneLoopInFlight: state.sceneLoopInFlight,
    sceneLoopDue: state.sceneLoopDue,
    sceneLoopGuests: state.sceneLoopGuests,
    sceneLoopSent: state.sceneLoopSent,
    renderMainMs: state.renderMainMs,
    renderTagsMs: state.renderTagsMs,
    renderSceneMs: state.renderSceneMs,
    renderExtractMs: state.renderExtractMs,
    renderBloomMs: state.renderBloomMs,
    renderBlitMs: state.renderBlitMs,
    renderMode: state.renderMode,
    renderShadowOn: state.renderShadowOn,
    renderDrawCalls: state.renderDrawCalls,
    renderTriangles: state.renderTriangles,
    asyncPeelMs: state.asyncPeelMs,
    asyncPtrMs: state.asyncPtrMs,
    asyncCollisionMs: state.asyncCollisionMs,
    asyncBridgesMs: state.asyncBridgesMs,
    asyncMultiMs: state.asyncMultiMs,
    asyncRestMs: state.asyncRestMs,
    asyncCollSyncMs: state.asyncCollSyncMs,
    asyncCollPoseMs: state.asyncCollPoseMs,
    asyncCollDiscoverMs: state.asyncCollDiscoverMs,
    asyncCollCookMs: state.asyncCollCookMs,
    asyncCollWatchMs: state.asyncCollWatchMs,
    asyncCollHealthMs: state.asyncCollHealthMs,
    asyncCollRestMs: state.asyncCollRestMs,
    colliderCookQueueSize: state.colliderCookQueueSize
  }
}
