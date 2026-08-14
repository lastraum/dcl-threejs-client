import * as THREE from 'three'
import type { Entity } from '@dcl/ecs'
import type { ResolvedScene } from '../dcl/content/types'
import type { AssetCache } from '../rendering/AssetCache'
import { isEmoteAnchorGltfSrc, resolveGltfSrcHash } from '../rendering/DclTextureResolver'
import { renderQuality } from '../rendering/RenderQualitySettings'
import { clientDebugLog } from '../client/debug/ClientDebugLog'
import type { MirrorComponents } from './mirrorComponents'
import type { ProjectionView } from './ProjectionView'
import { isAnimatorVerbose } from './animatorConfig'
import { deriveDefaultAnimatorStates } from './implicitAnimator'
import { isInBlimpSubtree, isMotionFocusActive, matchesMotionFocusSrc } from './motionFocus'

type AnimEntry = {
  mixer: THREE.AnimationMixer
  actions: Map<string, THREE.AnimationAction>
  root: THREE.Object3D
  /** Entity pose Group — sleep/near LOD must use this world, not drawRoot. */
  poseNode: THREE.Object3D | null
  gltfHash: string
  gltfSrc: string
  /** Last applied ECS/default animator states — skip stop/play when unchanged. */
  lastAppliedSignature?: string
  /** Accumulated dt while sample was deferred (time-correct catch-up — never freezes clock). */
  deferredSampleDt: number
  /** Bound root has SkinnedMesh — needs skeleton.update after sample. */
  hasSkinned: boolean
  /** Far decorative — paused, not sampled until camera approaches. */
  sleeping: boolean
  /**
   * Depth-first node list (includes root) for shared-pose fan-out.
   * Same-hash SkeletonUtils clones share topology → index-aligned copy is O(nodes).
   */
  poseNodes: THREE.Object3D[]
  /**
   * All playing clips are looping (decorative). Safe for wall-clock phase + share
   * when also rigid; PART PhysX is skipped for looping-only even if skinned.
   */
  loopingOnly: boolean
  /** Rigid + loopingOnly — one mixer sample fans out to same-hash clones. */
  shareableLooping: boolean
  /**
   * performance.now() deadline: keep PART PhysX follow after a one-shot ends so the
   * final clamped pose (open door / raised curtain) is cooked. Without this, the last
   * running-clip frame may miss the cook gate and the hull stays at bind pose.
   */
  partSettleUntil?: number
  /** Mixer 'finished' listener — one-shot PART settle. */
  partFinishedHooked?: boolean
  /** Present-rAF sample generation — async skips so we do not double-advance. */
  lastPresentGen: number
  /**
   * Rest-pose local sphere (not the whole flight path). HighDrone2 rest sits
   * ~160 m from the entity origin — we test this center, not (0,0,0).
   */
  cullCenter: THREE.Vector3
  cullRadius: number
  /** Nodes with position tracks — current local pos for in-flight frustum tests. */
  travelNodes: THREE.Object3D[]
}

/** Sample scheduling context — near camera / frustum bias for fair phase slice. */
export type AnimatorSampleContext = {
  camera: THREE.Camera
  /** Player feet / focus (world space). */
  playerWorld: THREE.Vector3
}

/** Last scheduled sample tick — for top-right HUD. */
export type AnimatorSampleStats = {
  /** Bound mixers (with or without active clips). */
  bound: number
  /** Active clips this frame (running / weight) — excludes sleeping far props. */
  active: number
  /** Far decorative mixers paused (timeScale 0) until camera approaches. */
  sleeping: number
  near: number
  fair: number
  /** Unique shared-pose groups sampled (hash+clip) — one mixer.update per group. */
  sharedGroups: number
  /** Entities that received pose via fan-out (no mixer.update). */
  sharedFanout: number
  sampled: number
  deferred: number
  budget: number
  nearCap: number
  /**
   * Estimated sample rate for a typical in-view fair mixer (Hz).
   * With shared groups, this tracks unique-hash sample rate (target ≥30).
   */
  fairSampleHz: number
  /** Wall-clock estimate of main-loop FPS from last frame dt. */
  displayFps: number
  /** Frame dt used for this sample pass (seconds). */
  frameDt: number
  disabled: boolean
}

/** Always-sample (or 2× fair share) within this radius of the camera. */
const NEAR_PLAYER_FULL_RATE_M = 16
/** Sphere radius added around entity root for expanded-frustum tests (turn without pop). */
const FRUSTUM_EXPAND_M = 8
/**
 * Off-frustum decorative mixers sleep beyond this distance (timeScale 0).
 * In-frustum looping clips stay awake at any range (CBD drone / tube shuttle).
 * Unused when Preferences → Advanced → Full-rate scene animators is on.
 */
const SLEEP_OFF_FRUSTUM_M = 40
/**
 * Target sample Hz for in-view (fair) unique groups. Near/PART stay at display rate.
 * Unused when full-rate primary animators is on.
 */
const TARGET_VIEW_SAMPLE_HZ = 30
/**
 * Hard ceiling on **mixer.update** calls per frame (after shared-hash collapse).
 * Unused when full-rate primary animators is on (all active mixers sample).
 */
const MAX_SAMPLES_PER_FRAME = 48
/** Near / PART absolute ceiling (adaptive near cap is lower under load). */
const MAX_NEAR_ALWAYS_PER_FRAME = 16
/**
 * After a non-loop clip finishes, keep PART hull follow this long so the final
 * open/raised pose is world-cooked (curtains ~0.75s Open; doors similar).
 * Short: long settle + full multi-shape re-expand every frame murdered FPS (~13).
 */
const PART_SETTLE_MS = 200
/**
 * Default-autoplay promote (instance→clone) budget per frame.
 * Full-rate mode uses a higher cap so more props start animating sooner.
 */
const MAX_DEFAULT_BINDS_PER_FRAME = 3
const MAX_DEFAULT_BINDS_FULL_RATE = 12
/** Never let near layer eat the whole budget while fair in-view units exist. */
const FAIR_BUDGET_RESERVE_MIN = 4

/** Graphics Advanced: full scene-tick sampling for primary. Default off (fair budget). */
function primaryFullRateAnimators(): boolean {
  if (typeof location !== 'undefined') {
    const q = location.search
    if (/(?:^|[?&])fullanim(?:=|&|$)/i.test(q)) return true
    if (/(?:^|[?&])nofullanim(?:=|&|$)/i.test(q)) return false
  }
  return renderQuality.getPrimaryFullRateAnimators()
}

/**
 * Scale sample count from last frame's wall dt so we recover FPS instead of
 * locking into a death spiral (low fps → large dt → expensive samples → lower fps).
 * Floors are higher than the pre-share era because each sample can cover many entities.
 */
function adaptiveSampleBudget(frameDt: number): { budget: number; nearCap: number } {
  // ≥100ms (~10 fps): emergency — keep doors/near barely alive
  if (frameDt >= 0.1) return { budget: 8, nearCap: 4 }
  // ~20 fps
  if (frameDt >= 0.05) return { budget: 16, nearCap: 6 }
  // ~30 fps
  if (frameDt >= 0.033) return { budget: 24, nearCap: 8 }
  // ~45–50 fps
  if (frameDt >= 0.022) return { budget: 36, nearCap: 12 }
  // ≥60 fps headroom
  return { budget: MAX_SAMPLES_PER_FRAME, nearCap: MAX_NEAR_ALWAYS_PER_FRAME }
}

/** Depth-first list including root — topology-stable for same-hash clones. */
function collectPoseNodes(root: THREE.Object3D): THREE.Object3D[] {
  const nodes: THREE.Object3D[] = []
  root.traverse((o) => {
    nodes.push(o)
  })
  return nodes
}

let fanOutMismatchLogged = false

/** Copy local TRS by parallel topology index (same-hash clones). */
function fanOutLocalPose(leaderNodes: THREE.Object3D[], followerNodes: THREE.Object3D[]): void {
  if (leaderNodes.length !== followerNodes.length) {
    // Topology mismatch — refuse silent wrong poses (modifiers / partial rebind).
    if (!fanOutMismatchLogged) {
      fanOutMismatchLogged = true
      console.warn(
        `[animator] shared-pose fan-out skipped (topology mismatch ${leaderNodes.length}≠${followerNodes.length})`
      )
    }
    return
  }
  const n = leaderNodes.length
  for (let i = 0; i < n; i++) {
    const src = leaderNodes[i]!
    const dst = followerNodes[i]!
    if (src === dst) continue
    dst.position.copy(src.position)
    dst.quaternion.copy(src.quaternion)
    dst.scale.copy(src.scale)
  }
}

/** Snap looping actions to wall-clock phase so shared leaders stay phase-aligned. */
function snapLoopingActionsToWallClock(entry: AnimEntry, wallSec: number): void {
  for (const action of entry.actions.values()) {
    if (!action.isRunning() && !action.isScheduled()) continue
    if (action.loop !== THREE.LoopRepeat) continue
    const dur = action.getClip().duration
    if (dur <= 1e-3) continue
    const speed = action.getEffectiveTimeScale()
    if (Math.abs(speed) < 1e-6) continue
    // Phase in clip space; speed scales how fast wall maps into the loop.
    action.time = ((wallSec * speed) % dur + dur) % dur
  }
}

const _frustum = new THREE.Frustum()
const _projScreen = new THREE.Matrix4()
const _worldPos = new THREE.Vector3()
const _sphere = new THREE.Sphere()
const _camPos = new THREE.Vector3()
const _cullScale = new THREE.Vector3()
const _bindBox = new THREE.Box3()
const _bindSphere = new THREE.Sphere()
const _bindInv = new THREE.Matrix4()

const MAX_TRAVEL_NODES = 8

/**
 * Rest-pose local sphere only. Do not union clip translation keys — that made
 * CBD/plaza flight paths hundreds of meters wide so every mixer looked in-view
 * and present sync jumped to ~800 ms.
 */
function computeMixerCullSphere(mesh: THREE.Object3D, outCenter: THREE.Vector3): number {
  mesh.updateMatrixWorld(true)
  _bindBox.setFromObject(mesh)
  if (_bindBox.isEmpty()) {
    outCenter.set(0, 0, 0)
    return FRUSTUM_EXPAND_M
  }
  _bindBox.applyMatrix4(_bindInv.copy(mesh.matrixWorld).invert())
  _bindBox.getBoundingSphere(_bindSphere)
  if (!Number.isFinite(_bindSphere.radius) || _bindSphere.radius <= 0) {
    outCenter.set(0, 0, 0)
    return FRUSTUM_EXPAND_M
  }
  outCenter.copy(_bindSphere.center)
  return Math.max(FRUSTUM_EXPAND_M, _bindSphere.radius)
}

/** Child nodes driven by clip `.position` tracks (HighDrone2 / tram). */
function collectTravelNodes(
  mesh: THREE.Object3D,
  clips: readonly THREE.AnimationClip[]
): THREE.Object3D[] {
  const names = new Set<string>()
  for (const clip of clips) {
    for (const track of clip.tracks) {
      if (!track.name.endsWith('.position')) continue
      names.add(track.name.slice(0, -'.position'.length))
      if (names.size >= MAX_TRAVEL_NODES) break
    }
    if (names.size >= MAX_TRAVEL_NODES) break
  }
  if (names.size === 0) return []
  const nodes: THREE.Object3D[] = []
  mesh.traverse((obj) => {
    if (nodes.length >= MAX_TRAVEL_NODES) return
    if (names.has(obj.name)) nodes.push(obj)
  })
  return nodes
}

/**
 * Resolve scene GLB path → content hash.
 * Must match ThreeBridge (case-insensitive): scenes often use `models/` while the
 * manifest has `Models/` (Spring in the Snow). Exact-match only left Animator
 * unbound while meshes still attached → rest scale ~0.003 needles.
 */
function hashFromSrc(src: string, scene: ResolvedScene): string | null {
  const trimmed = src.trim()
  if (/^(bafy|bafkre|Qm)/i.test(trimmed)) return trimmed
  return resolveGltfSrcHash(scene.content, trimmed)
}

type AnimatorStateView = Readonly<{
  clip?: string
  playing?: boolean
  loop?: boolean
  speed?: number
  weight?: number
  shouldReset?: boolean
}>

/** Highlight blimp / fire / propeller assets in verbose logs (`?animatorverbose`). */
const ANIMATOR_FOCUS_SRC = /blimp|propeller|prop_|fireparticle|fire_particle|campfire/i

function isAnimatorFocusSrc(src: string): boolean {
  return ANIMATOR_FOCUS_SRC.test(src)
}

/** True if mixer needs update this frame (running, scheduled, or non-zero weight fade). */
function mixerHasActiveWork(entry: AnimEntry): boolean {
  for (const action of entry.actions.values()) {
    if (action.isRunning() || action.isScheduled()) return true
    if (action.getEffectiveWeight() > 1e-3) return true
    if (action.enabled && action.weight > 1e-3) return true
  }
  return false
}

/**
 * Clip is **actually advancing** (running/scheduled).
 * Residual weight after clamp/finish must NOT count — that re-cooked hulls every frame.
 */
function hasRunningClip(entry: AnimEntry): boolean {
  for (const action of entry.actions.values()) {
    if (action.isRunning() || action.isScheduled()) return true
  }
  return false
}

/**
 * PART PhysX candidates — **doors / one-shots only** (non-loop running clips).
 *
 * CBD tax: every decorative looping mixer used to enter PART via getActiveMixerEntities,
 * forcing collider matrix refresh + fp cook path for hundreds of plaza props.
 * Looping-only (rigid or skinned decorative) keeps entity-root colliders fixed —
 * mesh/skeleton decoration does not need PART hull follow every frame.
 */
function isPartPhysxCandidate(entry: AnimEntry): boolean {
  if (entry.sleeping) return false
  if (!hasRunningClip(entry)) return false
  // Looping decorative (incl. skinned ambient props) — never PART.
  if (entry.loopingOnly) return false
  // One-shots / non-loop / mixed ECS states — PART while running.
  return true
}

/** Running one-shot OR post-finish settle window (final open pose cook). */
function needsPartPhysxWork(entry: AnimEntry, now = performance.now()): boolean {
  if (isPartPhysxCandidate(entry)) return true
  if (entry.partSettleUntil != null && now < entry.partSettleUntil) return true
  return false
}

/** @deprecated name — use hasRunningClip / isPartPhysxCandidate */
function hasPartColliderWork(entry: AnimEntry): boolean {
  return needsPartPhysxWork(entry)
}

/** One name→node map per bind — per-track traverse was O(tracks × nodes) on huge characters. */
function buildNodeNameMap(root: THREE.Object3D): Map<string, THREE.Object3D> {
  const byName = new Map<string, THREE.Object3D>()
  root.traverse((obj) => {
    if (obj.name && !byName.has(obj.name)) byName.set(obj.name, obj)
  })
  return byName
}

/**
 * Rebind cached GLTF clip tracks from source UUIDs → cloned instance nodes.
 * Clips stay in mesh-local space from GLTFLoader (already RH). Entity-root DCL→Three
 * conversion is only on ECS Transform via applyDclLocalTransform — do not re-reflect tracks
 * (that flipped continuous spins / skinned props).
 */
function retargetAnimationClip(
  clip: THREE.AnimationClip,
  root: THREE.Object3D,
  nodeByName?: Map<string, THREE.Object3D>
): THREE.AnimationClip {
  const nameMap = nodeByName ?? buildNodeNameMap(root)
  const tracks: THREE.KeyframeTrack[] = []
  for (const track of clip.tracks) {
    const parsed = THREE.PropertyBinding.parseTrackName(track.name)
    const nodeName = parsed.nodeName
    if (!nodeName) {
      tracks.push(track)
      continue
    }
    const target = nameMap.get(nodeName) ?? root.getObjectByName(nodeName) ?? undefined
    if (!target) {
      continue
    }
    const named = track.clone()
    const dot = track.name.indexOf('.')
    named.name = dot >= 0 ? `${target.uuid}${track.name.slice(dot)}` : track.name
    tracks.push(named)
  }
  return new THREE.AnimationClip(clip.name, clip.duration, tracks, clip.blendMode)
}

function formatAnimatorStates(states: readonly AnimatorStateView[]): string {
  if (!states.length) return '(none)'
  return states
    .map((s) => {
      const clip = s.clip ?? '?'
      const playing = s.playing !== false ? 'play' : 'stop'
      const loop = s.loop !== false ? 'loop' : 'once'
      const speed = s.speed ?? 1
      const weight = s.weight ?? 1
      const reset = s.shouldReset ? ',reset' : ''
      return `${clip}(${playing},${loop},spd=${speed},w=${weight}${reset})`
    })
    .join('; ')
}

function animatorStateSignature(
  states: readonly AnimatorStateView[],
  usingDefaultAutoPlay: boolean
): string {
  return `${usingDefaultAutoPlay ? 'default:' : ''}${formatAnimatorStates(states)}`
}

/** glTF clip playback from ECS `Animator` or DCL default auto-play on `GltfContainer`. */
export class AnimatorBridge {
  private readonly entries = new Map<Entity, AnimEntry>()
  private readonly verbose = isAnimatorVerbose()
  private readonly loggedSkips = new Set<string>()
  /** GLBs probed with no ECS Animator and zero embedded clips — skip re-probing each sync. */
  private readonly staticGltfNoClips = new Set<Entity>()
  /**
   * Animator / GltfContainer CRDT or attach since last successful bind+apply.
   * Re-apply even when state signature is unchanged (getMutable + shouldReset one-shots).
   * Also drives dirty-only async `sync()` — never full-scene GltfContainer walks.
   */
  private readonly dirtyReplay = new Set<Entity>()
  /**
   * Waiting for scene node / __mesh_* / GLB template cache — retry on next async sync only.
   * Without this, dirty-only would drop entities that saw Animator CRDT before mesh attach.
   */
  private readonly pendingBind = new Set<Entity>()
  private motionFocusView: ProjectionView | null = null
  /**
   * Active Animator PART candidates this frame (doors) — World poses PhysX multi-shapes (cook once).
   * Looping decorative mixers are intentionally excluded (plaza soft / toggle).
   */
  private readonly shapeMotionEntities = new Set<Entity>()
  /** Monotonic frame counter for off-screen sample stride. */
  private sampleFrame = 0
  /** Bumped each present rAF that samples PART / in-view decor. */
  private presentSampleGen = 0
  /** Rotating start index into the fair (non-near) active set. */
  private fairRingCursor = 0
  /**
   * When false, default autoplay (no ECS Animator) stays pending — GLB can remain
   * GPU-instanced rest pose until camera is near.
   */
  private allowDefaultAutoplayBind = false
  private lastStats: AnimatorSampleStats = {
    bound: 0,
    active: 0,
    sleeping: 0,
    near: 0,
    fair: 0,
    sharedGroups: 0,
    sharedFanout: 0,
    sampled: 0,
    deferred: 0,
    budget: MAX_SAMPLES_PER_FRAME,
    nearCap: MAX_NEAR_ALWAYS_PER_FRAME,
    fairSampleHz: 0,
    displayFps: 0,
    frameDt: 0,
    disabled: false
  }
  /** Previous frame wall dt — drives adaptive budget (death-spiral brake). */
  private prevFrameDt = 1 / 60
  /**
   * Tertiary resident LOD — force all mixers sleeping (timeScale 0) until
   * promoted back to secondary/primary. No per-frame sample work.
   */
  private forceAllSleeping = false

  /** Latest fair phase-slice counters (always updated on scheduled ticks). */
  getSampleStats(): AnimatorSampleStats {
    return { ...this.lastStats }
  }

  /** True when async pose-0 sample is needed (door bind / pending ECS Animator). */
  hasIdlePoseWork(): boolean {
    return this.dirtyReplay.size > 0 || this.pendingBind.size > 0
  }

  /**
   * Bulk sleep/wake for multi-scene tertiary residents.
   * When true: every mixer paused, update() early-outs (zero sample cost).
   */
  setAllSleeping(v: boolean): void {
    this.forceAllSleeping = v
    for (const entry of this.entries.values()) {
      if (v) {
        if (!entry.sleeping) {
          entry.sleeping = true
          entry.deferredSampleDt = 0
          entry.mixer.timeScale = 0
        }
      } else if (entry.sleeping) {
        entry.sleeping = false
        entry.mixer.timeScale = 1
        entry.deferredSampleDt = 0
      }
    }
  }

  constructor(
    private readonly ecs: MirrorComponents,
    private readonly cache: AssetCache,
    private readonly sceneConfig: ResolvedScene,
    private readonly getNodes: () => Map<Entity, THREE.Group> | undefined,
    /**
     * Promote GPU InstancedMesh rest-pose → private clone for mixer bind.
     * Required when decorative clips use default autoplay near camera.
     */
    private readonly ensureCloneMesh?: (entity: Entity) => THREE.Object3D | null
  ) {
    if (this.verbose) {
      const hint = isMotionFocusActive()
        ? 'Motion focus — filtered animator logs (?blimpdebug); use ?animatorverbose for all'
        : 'Animator verbose — logging bind, clips, and playback (?animatorverbose)'
      clientDebugLog.log('animator', hint, { level: 'info', alsoConsole: true })
    }
  }

  /**
   * Animator / GltfContainer put or attach — must bind or re-apply even if signature matches.
   * Call from projection fold / GLB attach. Does **not** mean Transform moved.
   */
  markDirty(entity: Entity): void {
    this.dirtyReplay.add(entity)
  }

  /** Drop mixer when GltfContainer is removed (dirty-only sync no longer full-scans). */
  markRemoved(entity: Entity): void {
    this.dirtyReplay.delete(entity)
    this.pendingBind.delete(entity)
    this.staticGltfNoClips.delete(entity)
    const entry = this.entries.get(entity)
    if (!entry) return
    entry.mixer.stopAllAction()
    this.entries.delete(entity)
    this.logAnimator(`Animator removed — entity ${entity}`, { entity })
  }

  getActiveEntities(): Entity[] {
    return [...this.entries.keys()]
  }

  pendingShapeMotionEntities(): ReadonlySet<Entity> {
    return this.shapeMotionEntities
  }

  consumeShapeMotionEntities(): ReadonlySet<Entity> {
    const out = new Set(this.shapeMotionEntities)
    this.shapeMotionEntities.clear()
    return out
  }

  /**
   * PART PhysX candidates only (doors / one-shots / skinned) — never decorative loops.
   * Used by getPhysMotionSets → pushColliderPartPoses.
   */
  getActiveMixerEntities(): Entity[] {
    const out: Entity[] = []
    for (const [entity, entry] of this.entries) {
      if (isPartPhysxCandidate(entry)) out.push(entity)
    }
    return out
  }

  /**
   * Running one-shot PART **or** post-finish settle — PhysX hull follow set for this frame.
   * Prefer this over {@link pendingShapeMotionEntities} alone (that only has mixers sampled
   * this tick; a finished clamp pose still needs one cook).
   */
  getPartColliderEntities(): Entity[] {
    const now = performance.now()
    const out: Entity[] = []
    for (const [entity, entry] of this.entries) {
      if (needsPartPhysxWork(entry, now)) out.push(entity)
    }
    return out
  }

  /**
   * Apply ECS Animator states for already-bound mixers that were markDirty'd.
   * Must run on the **sync motion path** — full `sync()` only runs async, which left
   * door open/close one frame late and often missed shape-slide samples.
   */
  applyDirtyBoundStates(view: ProjectionView): void {
    this.motionFocusView = view
    if (!this.dirtyReplay.size || !this.entries.size) return
    const { Animator } = this.ecs
    for (const entity of [...this.dirtyReplay]) {
      const entry = this.entries.get(entity)
      if (!entry || !Animator.has(entity)) continue
      const states = (Animator.get(entity).states ?? []) as readonly AnimatorStateView[]
      // forceApply: CRDT markDirty always re-applies (door open/close).
      this.applyStatesToEntry(entity, entry, states, entry.gltfSrc, false, true)
      this.dirtyReplay.delete(entity)
    }
  }

  /**
   * After mixer sample: only pay matrix/skeleton when needed.
   * Decorative rigid loops: mixer writes local TRS; renderer scene updateMatrixWorld
   * covers them next frame. PART doors + skinned need same-frame matrix/skeleton.
   *
   * One-shot settle: after Open/Close finishes, keep PART for {@link PART_SETTLE_MS}
   * so the clamped end pose is world-cooked (curtains raise ~3.4m under Bone).
   */
  private markShapeMotionAfterSample(entity: Entity, entry: AnimEntry): void {
    const now = performance.now()
    const runningPart = isPartPhysxCandidate(entry)
    if (runningPart) {
      // Extend settle window while the one-shot is still advancing.
      entry.partSettleUntil = now + PART_SETTLE_MS
    }
    const part = needsPartPhysxWork(entry, now)
    if (entry.hasSkinned) {
      entry.root.traverse((obj) => {
        const sk = obj as THREE.SkinnedMesh
        if (sk.isSkinnedMesh && sk.skeleton) sk.skeleton.update()
      })
    }
    // Decorative rigid loops: skip forced updateMatrixWorld — scene graph pass is enough.
    // PART / settle / skinned: same-frame hierarchy so bone-parented panels move PhysX.
    if (part || entry.hasSkinned) {
      const entityNode = entry.root.parent
      if (entityNode) entityNode.updateMatrixWorld(true)
      else entry.root.updateMatrixWorld(true)
    }
    // PART set: World gates actual PhysX writes on collider mesh pose change.
    if (part) {
      this.shapeMotionEntities.add(entity)
    }
  }

  /** Hook mixer finished once — one-shots must PART-cook their final clamped pose. */
  private ensurePartFinishedHook(entity: Entity, entry: AnimEntry): void {
    if (entry.partFinishedHooked) return
    entry.partFinishedHooked = true
    entry.mixer.addEventListener('finished', () => {
      // Clip ended (or loop boundary). Arm settle so pushColliderPartPoses runs once more.
      entry.partSettleUntil = performance.now() + PART_SETTLE_MS
      // Pose is already at clamp end — refresh matrices and mark PART this frame if possible.
      const entityNode = entry.root.parent
      if (entityNode) entityNode.updateMatrixWorld(true)
      else entry.root.updateMatrixWorld(true)
      this.shapeMotionEntities.add(entity)
      this.logAnimator(
        `Animator finished → PART settle ${PART_SETTLE_MS}ms — entity ${entity} · ${entry.gltfSrc}`,
        { entity, throttleMs: 200 }
      )
    })
  }

  private applyStatesToEntry(
    entity: Entity,
    bound: AnimEntry,
    states: readonly AnimatorStateView[],
    src: string,
    usingDefaultAutoPlay: boolean,
    forceApply = false
  ): void {
    const stateSignature = animatorStateSignature(states, usingDefaultAutoPlay)
    const forceReplay = forceApply || this.dirtyReplay.has(entity)
    this.dirtyReplay.delete(entity)
    if (!forceApply && bound.lastAppliedSignature === stateSignature) {
      const oneShotRefire =
        forceReplay && states.some((s) => s.shouldReset === true && s.playing !== false)
      if (!oneShotRefire) return
    }

    for (const action of bound.actions.values()) {
      action.stop()
      action.enabled = false
      action.paused = false
      action.setEffectiveTimeScale(1)
    }

    const playingClips: string[] = []
    const missingClips: string[] = []
    for (const state of states) {
      const clipName = state.clip ?? ''
      const action = bound.actions.get(clipName)
      if (!action) {
        if (clipName) missingClips.push(clipName)
        continue
      }
      const loop = state.loop !== false
      const weight = state.weight ?? 1
      action.enabled = true
      action.paused = false
      action.setEffectiveWeight(weight)
      action.setEffectiveTimeScale(state.speed ?? 1)
      action.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, Infinity)
      action.clampWhenFinished = !loop
      if (state.playing !== false) {
        // One-shots (Spring flower mesh scale tracks, doors): always start at t=0 even when
        // shouldReset is omitted — otherwise re-bind can sit at clamp end (rest scale ~0.003).
        // Default autoplay loops also reset on first apply so fire/FX don't sit on a dead
        // keyframe after a deferred near-camera bind (ABC fireparticles rest scale ~0.001).
        if (state.shouldReset || !loop || usingDefaultAutoPlay) action.reset()
        action.play()
        playingClips.push(clipName)
      }
    }

    if (missingClips.length) {
      this.logAnimator(
        `Animator clip missing — entity ${entity} · ${src} · requested [${missingClips.join(', ')}] · available [${[...bound.actions.keys()].join(', ')}]`,
        { entity, level: 'warn', throttleMs: 1500 }
      )
    }

    const logSignature = `${stateSignature}|playing:${playingClips.join(',')}`
    if (bound.lastAppliedSignature !== logSignature) {
      this.logAnimator(
        `Animator states — entity ${entity} · ${src} · ${formatAnimatorStates(states)} · active clips [${playingClips.join(', ') || '(none)'}]${usingDefaultAutoPlay ? ' · default auto-play' : ''}`,
        { entity }
      )
    }
    bound.lastAppliedSignature = stateSignature
    // Looping-only decorative: no PART; rigid also share one mixer sample across clones.
    bound.loopingOnly =
      playingClips.length > 0 &&
      states.length > 0 &&
      states.every((s) => s.playing === false || s.loop !== false)
    bound.shareableLooping = !bound.hasSkinned && bound.loopingOnly
    // One-shots (doors/curtains): listen for finished so final pose still PART-cooks.
    if (!bound.loopingOnly) {
      this.ensurePartFinishedHook(entity, bound)
    }
    // Sample current pose immediately so PhysX can track the first open frame.
    if (playingClips.length || mixerHasActiveWork(bound)) {
      bound.mixer.update(0)
      this.markShapeMotionAfterSample(entity, bound)
    }
  }

  private logAnimator(
    message: string,
    options: { level?: 'info' | 'warn' | 'success'; throttleMs?: number; entity?: Entity } = {}
  ): void {
    // Quiet by default — enable with `?animatorverbose` / localStorage, then Help →
    // “Mirror → browser console” (or `?consolelogs`) to print.
    if (!this.verbose && options.level !== 'warn') return
    if (
      isMotionFocusActive() &&
      options.entity !== undefined &&
      this.motionFocusView &&
      !isInBlimpSubtree(options.entity, this.ecs, this.motionFocusView) &&
      !matchesMotionFocusSrc(message) &&
      !isAnimatorFocusSrc(message)
    ) {
      return
    }
    const key = options.entity !== undefined ? `animator:${options.entity}` : 'animator'
    clientDebugLog.log('animator', message, {
      level: options.level ?? 'info',
      throttleKey: key,
      throttleMs: options.throttleMs
    })
  }

  /**
   * Bind + play as soon as `__mesh_*` exists. Call from GLB attach — Animator CRDT often
   * lands before the mesh; waiting for the 12-frame async bridge stride leaves grow clips
   * (Spring flowers rest scale ~0.003) stuck as black needles.
   */
  syncEntity(entity: Entity, view: ProjectionView): boolean {
    this.motionFocusView = view
    const result = this.bindAndApplyEntity(entity)
    if (result === 'bound') {
      this.dirtyReplay.delete(entity)
      this.pendingBind.delete(entity)
      return true
    }
    if (result === 'waiting') {
      this.pendingBind.add(entity)
      return false
    }
    this.dirtyReplay.delete(entity)
    this.pendingBind.delete(entity)
    return false
  }

  /**
   * Attach-time bind that also allows DCL default first-clip autoplay (no ECS Animator).
   * Used for fireparticles / decorative loops that only ship embedded clips.
   */
  syncEntityAllowDefaultAutoplay(entity: Entity, view: ProjectionView): boolean {
    const prev = this.allowDefaultAutoplayBind
    this.allowDefaultAutoplayBind = true
    try {
      return this.syncEntity(entity, view)
    } finally {
      this.allowDefaultAutoplayBind = prev
    }
  }

  /**
   * Dirty-only bind/apply — O(dirty + pending + bound), not O(all GltfContainers).
   * Plaza CBD: full getEntitiesWith(GltfContainer) every async stride was the noanim smoking gun.
   * First bind is attach `syncEntity` + Animator/Gltf CRDT markDirty; this only retries those.
   */
  async sync(view: ProjectionView): Promise<void> {
    this.motionFocusView = view
    const { GltfContainer } = this.ecs
    if (!this.getNodes()) return

    const toProcess = new Set<Entity>()
    for (const e of this.dirtyReplay) toProcess.add(e)
    for (const e of this.pendingBind) toProcess.add(e)

    // Cap new mixer binds per async tick — unbound storm on play-ready
    // (clone + AnimationMixer + retarget) was multi-second bridges= spikes.
    // Already-bound dirtyReplay applies are cheap; always process those first.
    const BIND_BUDGET = 6
    const BIND_BUDGET_MS = 8
    const t0 = performance.now()
    let newBinds = 0

    // Pass 1: already-bound dirty apply (open/close doors must not wait for bind budget).
    for (const entity of toProcess) {
      if (!GltfContainer.has(entity)) {
        this.markRemoved(entity)
        continue
      }
      if (!this.entries.has(entity)) continue
      const result = this.bindAndApplyEntity(entity)
      if (result === 'bound') {
        this.dirtyReplay.delete(entity)
        this.pendingBind.delete(entity)
      } else if (result === 'waiting') {
        this.dirtyReplay.delete(entity)
        this.pendingBind.add(entity)
      } else {
        this.dirtyReplay.delete(entity)
        this.pendingBind.delete(entity)
      }
    }

    // Pass 2: first-time binds (expensive clone path) under budget.
    for (const entity of toProcess) {
      if (this.entries.has(entity)) continue
      if (!GltfContainer.has(entity)) {
        this.markRemoved(entity)
        continue
      }
      if (newBinds >= BIND_BUDGET || performance.now() - t0 >= BIND_BUDGET_MS) {
        this.dirtyReplay.delete(entity)
        this.pendingBind.add(entity)
        continue
      }
      const result = this.bindAndApplyEntity(entity)
      if (result === 'bound') {
        this.dirtyReplay.delete(entity)
        this.pendingBind.delete(entity)
        newBinds++
      } else if (result === 'waiting') {
        this.dirtyReplay.delete(entity)
        this.pendingBind.add(entity)
      } else {
        this.dirtyReplay.delete(entity)
        this.pendingBind.delete(entity)
      }
    }

    // O(bound mixers) prune — entities deleted without a component fold reaching us.
    for (const entity of [...this.entries.keys()]) {
      if (!GltfContainer.has(entity)) this.markRemoved(entity)
    }
    for (const entity of [...this.staticGltfNoClips]) {
      if (!GltfContainer.has(entity)) this.staticGltfNoClips.delete(entity)
    }
  }

  /**
   * @returns `bound` mixer ready · `waiting` retry later (no node/mesh/cache) · `skip` permanent for now
   */
  private bindAndApplyEntity(entity: Entity): 'bound' | 'waiting' | 'skip' {
    const { Animator, GltfContainer } = this.ecs
    if (!GltfContainer.has(entity)) return 'skip'
    const { src } = GltfContainer.get(entity)
    // Sit-spot sources (Puff_Idle_*_emote.glb): clips target Avatar_* bones.
    // They play on the player via AvatarEmote, not as a scene mixer on this entity.
    if (isEmoteAnchorGltfSrc(src)) return 'skip'
    const hasExplicitAnimator = Animator.has(entity)
    if (!hasExplicitAnimator && this.staticGltfNoClips.has(entity) && !this.entries.has(entity)) {
      const hashNow = hashFromSrc(src, this.sceneConfig)
      const templateNow = hashNow
        ? (this.cache.peekCached(hashNow) ?? this.cache.peekCached(this.sceneConfig.assetUrl(hashNow)))
        : undefined
      if (!templateNow?.animations.length) return 'skip'
      // Cache gained clips after first peek (IDB/worker inflate) — retry bind.
      this.staticGltfNoClips.delete(entity)
    }
    // Default first-clip is allowed — bindAndApply still skips no-clip statics.
    // Blocking it left Spring flowers at bind scale 1 and froze the how-to arrow / blimp props.

    const nodes = this.getNodes()
    const node = nodes?.get(entity)
    if (!node) {
      const skipKey = `no-node:${entity}:${src}`
      if (!this.loggedSkips.has(skipKey)) {
        this.loggedSkips.add(skipKey)
        this.logAnimator(`Animator skip — entity ${entity} · ${src} (no scene node)`, {
          entity,
          level: 'warn'
        })
      }
      return 'waiting'
    }

    const hash = hashFromSrc(src, this.sceneConfig)
    if (!hash) {
      this.logAnimator(`Animator skip — entity ${entity} · ${src} (unresolved hash)`, {
        entity,
        throttleMs: 2000,
        level: 'warn'
      })
      return 'skip'
    }

    // Instanced rest-pose → private clone only when we will actually play clips.
    // Never force-promote static instances during probe (that orphaned markers and
    // wiped INSTANCE_COLLIDER_SHAPES → terrain/plaza colliders disappeared).
    let mesh = ((node.userData.dclDrawVisual as THREE.Object3D | undefined) ??
      node.getObjectByName(`__mesh_${entity}`)) as THREE.Object3D | null
    const needsPrivateClone =
      !!node.userData.dclInstanced || !mesh || !!mesh.userData.dclInstanceMarker
    if (needsPrivateClone) {
      // Peek: only promote when template has clips or ECS Animator is present.
      if (!hasExplicitAnimator) {
        const template =
          this.cache.peekCached(hash) ??
          this.cache.peekCached(this.sceneConfig.assetUrl(hash))
        if (!template?.animations.length) {
          // Static GPU instance / orphan marker — never promote. Promoting wiped
          // INSTANCE_COLLIDER_SHAPES and left empty __mesh_* → 0 terrain colliders.
          this.staticGltfNoClips.add(entity)
          return 'skip'
        }
      }
      mesh = this.ensureCloneMesh?.(entity) ?? mesh
    }
    if (!mesh || mesh.userData.dclInstanceMarker || node.userData.dclInstanced) {
      this.logAnimator(
        `Animator wait mesh — entity ${entity} · ${src} (need private clone; inst=${node.userData.dclInstanced ? 1 : 0} marker=${mesh?.userData.dclInstanceMarker ? 1 : 0})`,
        { entity, throttleMs: 2000, level: 'warn' }
      )
      return 'waiting'
    }
    // Mixer writes position/quaternion/scale — frozen leaves (matrixAutoUpdate=false)
    // never rebuild matrices, so fire/FX rest-pose stays invisible (scale tracks ~0.001).
    node.matrixAutoUpdate = true
    mesh.matrixAutoUpdate = true
    mesh.userData.dclDrawAnimated = true
    mesh.userData.dclDrawStatic = false
    mesh.traverse((o) => {
      o.matrixAutoUpdate = true
      o.userData.dclDrawStatic = false
    })

    let entry = this.entries.get(entity)
    const rebinding = !entry || entry.gltfHash !== hash || entry.root !== mesh
    if (rebinding) {
      const template =
        this.cache.peekCached(hash) ?? this.cache.peekCached(this.sceneConfig.assetUrl(hash))
      if (!template) {
        if (this.cache.hasGivenUp(hash)) return 'skip'
        if (!this.cache.isResolving(hash)) {
          void this.cache
            .load(this.sceneConfig.assetUrl(hash), hash, { quiet: true })
            .catch(() => {})
        }
        return 'waiting'
      }
      entry?.mixer.stopAllAction()
      const loaded = template
      const clipNames = loaded.animations.map((c) => c.name)
      let hasSkinned = false
      mesh.traverse((obj) => {
        if ((obj as THREE.SkinnedMesh).isSkinnedMesh) hasSkinned = true
      })
      entry = {
        mixer: new THREE.AnimationMixer(mesh),
        actions: new Map(),
        root: mesh,
        poseNode: node,
        gltfHash: hash,
        gltfSrc: src,
        deferredSampleDt: 0,
        hasSkinned,
        sleeping: false,
        poseNodes: collectPoseNodes(mesh),
        loopingOnly: false,
        shareableLooping: false,
        partSettleUntil: undefined,
        partFinishedHooked: false,
        lastPresentGen: 0,
        cullCenter: new THREE.Vector3(),
        cullRadius: FRUSTUM_EXPAND_M,
        travelNodes: []
      }
      entry.cullRadius = computeMixerCullSphere(mesh, entry.cullCenter)
      entry.travelNodes = collectTravelNodes(mesh, loaded.animations)
      const nodeByName = loaded.animations.length ? buildNodeNameMap(mesh) : undefined
      let retargetedTracks = 0
      for (const clip of loaded.animations) {
        const instanceClip = retargetAnimationClip(clip, mesh, nodeByName)
        retargetedTracks += instanceClip.tracks.length
        entry.actions.set(clip.name, entry.mixer.clipAction(instanceClip, mesh))
      }
      if (clipNames.length > 0 && retargetedTracks === 0) {
        this.logAnimator(
          `Animator retarget empty — entity ${entity} · ${src} · clips [${clipNames.join(', ')}] but 0 tracks bound (node names mismatch?)`,
          { entity, level: 'warn' }
        )
      }
      if (!hasExplicitAnimator && !clipNames.length) {
        this.staticGltfNoClips.add(entity)
        return 'skip'
      }
      this.staticGltfNoClips.delete(entity)
      entry.lastAppliedSignature = undefined
      this.entries.set(entity, entry)
      const focus = isAnimatorFocusSrc(src)
      this.logAnimator(
        `Animator bind — entity ${entity} · ${src} · clips [${clipNames.join(', ') || '(none)'}] · mesh children ${mesh.children.length}`,
        { entity, level: clipNames.length ? 'success' : 'warn', throttleMs: focus ? 0 : undefined }
      )
      if (!clipNames.length) {
        this.logAnimator(`Animator no clips in GLB — entity ${entity} · ${src}`, {
          entity,
          level: 'warn'
        })
      }
    }

    const bound = this.entries.get(entity)
    if (!bound) return 'skip'

    const clipNames = [...bound.actions.keys()]
    let states: readonly AnimatorStateView[]
    let usingDefaultAutoPlay = false
    if (Animator.has(entity)) {
      states = (Animator.get(entity).states ?? []) as readonly AnimatorStateView[]
    } else {
      states = deriveDefaultAnimatorStates(clipNames)
      usingDefaultAutoPlay = states.length > 0
      if (usingDefaultAutoPlay) {
        this.logAnimator(
          `Animator default — entity ${entity} · ${src} · auto-play first clip [${states[0]?.clip ?? '?'}] (DCL spec, no ECS Animator)`,
          { entity, level: 'info', throttleMs: isAnimatorFocusSrc(src) ? 0 : 5000 }
        )
      }
    }
    if (!states.length) return 'skip'

    if (rebinding) bound.lastAppliedSignature = undefined
    this.applyStatesToEntry(
      entity,
      bound,
      states,
      src,
      usingDefaultAutoPlay,
      rebinding || this.dirtyReplay.has(entity)
    )
    this.dirtyReplay.delete(entity)
    return 'bound'
  }

  /**
   * Advance mixers for the **primary** scene.
   *
   * When {@link PRIMARY_FULL_RATE_ANIMATORS}: every bound mixer with active work
   * gets full `delta` every frame (no distance sleep / fair skip / adaptive budget).
   *
   * Legacy path (flag off): shared-hash + fair phase + off-frustum sleep (in-view stays live).
   *
   * `delta === 0` (post-bind pose): sample active work so doors get first pose.
   * Tertiary multi-scene still uses {@link setAllSleeping} (force freeze).
   */
  update(
    delta: number,
    view?: ProjectionView,
    sampleCtx?: AnimatorSampleContext,
    opts?: { partOnly?: boolean; presentDecor?: boolean; skipPresentSampled?: boolean }
  ): void {
    if (!this.entries.size) {
      this.lastStats = {
        ...this.lastStats,
        bound: 0,
        active: 0,
        sleeping: 0,
        near: 0,
        fair: 0,
        sharedGroups: 0,
        sharedFanout: 0,
        sampled: 0,
        deferred: 0,
        frameDt: delta,
        displayFps: delta > 1e-6 ? 1 / delta : 0,
        fairSampleHz: 0,
        disabled: false
      }
      return
    }
    // Tertiary multi-scene LOD — no sample / no dirty apply (CPU free for primary).
    if (this.forceAllSleeping) {
      this.shapeMotionEntities.clear()
      this.lastStats = {
        ...this.lastStats,
        bound: this.entries.size,
        active: 0,
        sleeping: this.entries.size,
        near: 0,
        fair: 0,
        sharedGroups: 0,
        sharedFanout: 0,
        sampled: 0,
        deferred: 0,
        frameDt: delta,
        displayFps: delta > 1e-6 ? 1 / delta : 0,
        fairSampleHz: 0,
        disabled: false
      }
      return
    }
    // PART set is frame-local — only entities sampled/applied this tick.
    this.shapeMotionEntities.clear()

    // Door open/close CRDT often lands between async sync ticks — apply dirty before sample.
    if (view) this.applyDirtyBoundStates(view)

    // Present rAF: PART hulls every frame + in-view looping props (shared-hash).
    if (opts?.partOnly || opts?.presentDecor) {
      this.presentSampleGen++
      const now = performance.now()
      let sampled = 0
      for (const [entity, entry] of this.entries) {
        if (!needsPartPhysxWork(entry, now) && !isPartPhysxCandidate(entry)) continue
        const dt = delta + entry.deferredSampleDt
        entry.deferredSampleDt = 0
        if (entry.sleeping) {
          entry.sleeping = false
          entry.mixer.timeScale = 1
        }
        entry.mixer.update(dt)
        entry.lastPresentGen = this.presentSampleGen
        this.markShapeMotionAfterSample(entity, entry)
        sampled++
      }
      if (opts?.presentDecor && sampleCtx) {
        this.retryPendingBinds(2)
        sampled += this.samplePresentDecoratives(delta, sampleCtx)
      }
      this.lastStats = {
        ...this.lastStats,
        sampled,
        frameDt: delta,
        displayFps: delta > 1e-6 ? 1 / delta : 0
      }
      return
    }

    this.sampleFrame++
    const schedule = delta > 1e-8 && sampleCtx != null

    // delta=0 pose pass after async bind.
    if (!schedule) {
      let poseN = 0
      const fullRate = primaryFullRateAnimators()
      const POSE_BUDGET = fullRate ? 128 : 24
      for (const [entity, entry] of this.entries) {
        if (!mixerHasActiveWork(entry)) continue
        if (poseN >= POSE_BUDGET) break
        entry.mixer.update(0)
        this.markShapeMotionAfterSample(entity, entry)
        poseN++
      }
      return
    }

    sampleCtx!.camera.updateMatrixWorld(true)
    _camPos.setFromMatrixPosition(sampleCtx!.camera.matrixWorld)
    _projScreen.multiplyMatrices(
      sampleCtx!.camera.projectionMatrix,
      sampleCtx!.camera.matrixWorldInverse
    )
    _frustum.setFromProjectionMatrix(_projScreen)

    const fullRate = primaryFullRateAnimators()

    // Retry pending binds (ECS Animator + default first-clip). bindAndApply still
    // skips no-clip statics so terrain stays instanced.
    const bindCap = fullRate ? MAX_DEFAULT_BINDS_FULL_RATE : MAX_DEFAULT_BINDS_PER_FRAME
    let bindsThisFrame = 0
    for (const entity of [...this.pendingBind]) {
      if (bindsThisFrame >= bindCap) break
      if (this.entries.has(entity)) {
        this.pendingBind.delete(entity)
        continue
      }
      const result = this.bindAndApplyEntity(entity)
      if (result === 'bound') {
        this.pendingBind.delete(entity)
        bindsThisFrame++
      } else if (result === 'skip') {
        this.pendingBind.delete(entity)
      }
    }

    // --- Full-rate primary path: every active mixer, every frame, full delta ---
    if (fullRate) {
      let sampled = 0
      let active = 0
      const now = performance.now()
      const skipPresent = opts?.skipPresentSampled === true
      for (const [entity, entry] of this.entries) {
        if (skipPresent && entry.lastPresentGen === this.presentSampleGen) {
          entry.deferredSampleDt = 0
          continue
        }
        if (entry.sleeping) {
          entry.sleeping = false
          entry.mixer.timeScale = 1
          entry.deferredSampleDt = 0
        }
        const settleOnly =
          !mixerHasActiveWork(entry) &&
          entry.partSettleUntil != null &&
          now < entry.partSettleUntil
        if (!mixerHasActiveWork(entry) && !settleOnly) {
          entry.deferredSampleDt = 0
          continue
        }
        active++
        entry.deferredSampleDt = 0
        if (settleOnly) {
          // Clip finished — hold end pose, still PART-cook hull to match visuals.
          entry.mixer.update(0)
          this.markShapeMotionAfterSample(entity, entry)
          sampled++
          continue
        }
        if (delta > 1e-8) {
          entry.mixer.update(delta)
          sampled++
          this.markShapeMotionAfterSample(entity, entry)
        }
      }
      this.prevFrameDt = delta
      const displayFps = delta > 1e-6 ? 1 / delta : 0
      this.lastStats = {
        bound: this.entries.size,
        active,
        sleeping: 0,
        near: active,
        fair: 0,
        sharedGroups: 0,
        sharedFanout: 0,
        sampled,
        deferred: 0,
        budget: sampled,
        nearCap: sampled,
        fairSampleHz: displayFps,
        displayFps,
        frameDt: delta,
        disabled: false
      }
      return
    }

    type Cand = {
      entity: Entity
      entry: AnimEntry
      priority: number
      distSq: number
      inFrustum: boolean
    }
    const near: Cand[] = []
    const fair: Cand[] = []
    let sleeping = 0
    const sleepOffSq = SLEEP_OFF_FRUSTUM_M * SLEEP_OFF_FRUSTUM_M

    const putToSleep = (entry: AnimEntry): void => {
      if (!entry.sleeping) {
        entry.sleeping = true
        entry.deferredSampleDt = 0
        entry.mixer.timeScale = 0
      }
      sleeping++
    }
    /**
     * Become-near / become-live: snap visual from wall clock or ECS — do not replay
     * skipped frames. Land color is Material CRDT (always applied); this is Animator only.
     */
    const wake = (entity: Entity, entry: AnimEntry): void => {
      if (!entry.sleeping) return
      entry.sleeping = false
      entry.mixer.timeScale = 1
      entry.deferredSampleDt = 0
      // Looping decorative clips: wall-clock phase (shared-hash groups rejoin in sync).
      snapLoopingActionsToWallClock(entry, performance.now() / 1000)
      // One-shots / doors: re-apply ECS Animator so end pose is correct after sleep.
      if (!entry.shareableLooping && this.ecs.Animator.has(entity)) {
        const states = (this.ecs.Animator.get(entity).states ?? []) as readonly AnimatorStateView[]
        this.applyStatesToEntry(entity, entry, states, entry.gltfSrc, false, true)
        entry.mixer.update(0)
      } else {
        entry.mixer.update(0)
      }
    }

    const nowFair = performance.now()
    const skipPresent = opts?.skipPresentSampled === true
    for (const [entity, entry] of this.entries) {
      if (skipPresent && entry.lastPresentGen === this.presentSampleGen) {
        entry.deferredSampleDt = 0
        continue
      }
      const settleOnly =
        !mixerHasActiveWork(entry) &&
        entry.partSettleUntil != null &&
        nowFair < entry.partSettleUntil
      if (!mixerHasActiveWork(entry) && !entry.sleeping && !settleOnly) {
        entry.deferredSampleDt = 0
        continue
      }
      if (settleOnly) {
        // Final open pose — force near/PART sample without replaying the clip.
        entry.deferredSampleDt = 0
        entry.mixer.update(0)
        this.markShapeMotionAfterSample(entity, entry)
        continue
      }
      const { priority, distSq, inFrustum } = this.samplePriority(entry, sampleCtx!)
      const isPart = hasPartColliderWork(entry)
      // Sleep decorative mixers only when off-camera and far. In-view loops
      // (CBD drone / tube shuttle) stay awake at any distance.
      if (!isPart && priority < 2 && !inFrustum && distSq > sleepOffSq) {
        putToSleep(entry)
        continue
      }
      wake(entity, entry)
      entry.deferredSampleDt += delta
      const cand: Cand = { entity, entry, priority, distSq, inFrustum }
      if (priority >= 2) near.push(cand)
      else fair.push(cand)
    }

    // Near: closer / PART first.
    near.sort((a, b) => b.priority - a.priority || a.distSq - b.distSq)
    // Fair: nearest first (stable share leaders tend to be near).
    fair.sort((a, b) => a.distSq - b.distSq)

    // Budget from *previous* frame length so a hitch this frame doesn't double-dip.
    const { budget, nearCap } = adaptiveSampleBudget(this.prevFrameDt)
    this.prevFrameDt = delta
    // Reserve sample slots for fair/in-view so near solos cannot starve goal ≥30 Hz.
    const fairReserve = Math.min(budget, Math.max(FAIR_BUDGET_RESERVE_MIN, Math.ceil(budget * 0.35)))
    const nearBudget = Math.max(1, budget - fairReserve)

    let sampled = 0
    let deferred = 0
    let nearSampled = 0
    let fairSampled = 0
    let sharedGroups = 0
    let sharedFanout = 0
    const wallSec = performance.now() / 1000

    const runMixerSample = (
      entity: Entity,
      entry: AnimEntry,
      layer: 'near' | 'fair',
      useWallClock: boolean
    ): void => {
      const step = entry.deferredSampleDt
      entry.deferredSampleDt = 0
      if (useWallClock && entry.shareableLooping) {
        snapLoopingActionsToWallClock(entry, wallSec)
        entry.mixer.update(0)
      } else {
        const clamped = Math.min(step, 0.25)
        if (clamped > 1e-8) entry.mixer.update(clamped)
      }
      sampled++
      if (layer === 'near') nearSampled++
      else fairSampled++
      this.markShapeMotionAfterSample(entity, entry)
    }

    // --- Layer 1: near / PART — shareable hashes collapse; PART/skinned stay solo ---
    {
      type NearShare = { leader: Cand; followers: Cand[] }
      const nearShares: NearShare[] = []
      const nearShareIdx = new Map<string, number>()
      const nearSolo: Cand[] = []
      for (const cand of near) {
        const entry = cand.entry
        const canShare =
          entry.shareableLooping &&
          !entry.hasSkinned &&
          !hasPartColliderWork(entry) &&
          entry.lastAppliedSignature != null
        if (!canShare) {
          nearSolo.push(cand)
          continue
        }
        const key = `${entry.gltfHash}|${entry.lastAppliedSignature}`
        const idx = nearShareIdx.get(key)
        if (idx === undefined) {
          nearShareIdx.set(key, nearShares.length)
          nearShares.push({ leader: cand, followers: [] })
        } else {
          nearShares[idx]!.followers.push(cand)
        }
      }

      const nearUnits: Array<
        | { kind: 'share'; group: NearShare }
        | { kind: 'solo'; cand: Cand }
      > = [
        ...nearShares.map((group) => ({ kind: 'share' as const, group })),
        ...nearSolo.map((cand) => ({ kind: 'solo' as const, cand }))
      ]
      // Prefer PART/solo first (nearSolo already at end of shares — re-sort units).
      nearUnits.sort((a, b) => {
        const pa = a.kind === 'solo' ? a.cand.priority : a.group.leader.priority
        const pb = b.kind === 'solo' ? b.cand.priority : b.group.leader.priority
        const da = a.kind === 'solo' ? a.cand.distSq : a.group.leader.distSq
        const db = b.kind === 'solo' ? b.cand.distSq : b.group.leader.distSq
        return pb - pa || da - db
      })

      for (const unit of nearUnits) {
        if (sampled >= nearCap || sampled >= nearBudget) {
          if (unit.kind === 'share') {
            fair.push(unit.group.leader, ...unit.group.followers)
          } else {
            fair.push(unit.cand)
          }
          continue
        }
        if (unit.kind === 'share') {
          const { leader, followers } = unit.group
          runMixerSample(leader.entity, leader.entry, 'near', true)
          sharedGroups++
          if (followers.length && leader.entry.poseNodes.length) {
            for (const f of followers) {
              f.entry.deferredSampleDt = 0
              if (f.entry.poseNodes.length) {
                fanOutLocalPose(leader.entry.poseNodes, f.entry.poseNodes)
              }
              sharedFanout++
            }
          }
        } else {
          runMixerSample(
            unit.cand.entity,
            unit.cand.entry,
            'near',
            unit.cand.entry.shareableLooping
          )
        }
      }
    }

    // --- Layer 2: fair ring collapsed by share key (hash + clip signature) ---
    type ShareGroup = { leader: Cand; followers: Cand[] }
    const shareGroups: ShareGroup[] = []
    const shareIndex = new Map<string, number>()
    const unshared: Cand[] = []

    for (const cand of fair) {
      // Already sampled as near overflow path may have cleared dt — still OK.
      const entry = cand.entry
      const canShare =
        entry.shareableLooping &&
        !entry.hasSkinned &&
        !hasPartColliderWork(entry) &&
        entry.lastAppliedSignature != null
      if (!canShare) {
        unshared.push(cand)
        continue
      }
      const key = `${entry.gltfHash}|${entry.lastAppliedSignature}`
      const idx = shareIndex.get(key)
      if (idx === undefined) {
        shareIndex.set(key, shareGroups.length)
        shareGroups.push({ leader: cand, followers: [] })
      } else {
        shareGroups[idx]!.followers.push(cand)
      }
    }

    // Unique sample units: one per share group + each unshared entity.
    const fairUnits: Array<
      | { kind: 'share'; group: ShareGroup }
      | { kind: 'solo'; cand: Cand }
    > = [
      ...shareGroups.map((group) => ({ kind: 'share' as const, group })),
      ...unshared.map((cand) => ({ kind: 'solo' as const, cand }))
    ]

    const displayFps = delta > 1e-6 ? 1 / delta : 0
    // Aim for TARGET_VIEW_SAMPLE_HZ: at 60fps sample ~half the units each frame.
    const period =
      displayFps > TARGET_VIEW_SAMPLE_HZ + 1
        ? Math.max(1, Math.round(displayFps / TARGET_VIEW_SAMPLE_HZ))
        : 1
    const unitsPerFrameIdeal =
      fairUnits.length === 0 ? 0 : Math.ceil(fairUnits.length / period)
    const budgetLeft = Math.max(0, budget - sampled)
    const fairQuota = Math.min(budgetLeft, Math.max(unitsPerFrameIdeal, fairUnits.length > 0 ? 1 : 0))

    if (fairUnits.length > 0 && fairQuota > 0) {
      const n = fairUnits.length
      const start = this.fairRingCursor % n
      this.fairRingCursor = (start + fairQuota) % n
      for (let i = 0; i < fairQuota; i++) {
        const unit = fairUnits[(start + i) % n]!
        if (unit.kind === 'share') {
          const { leader, followers } = unit.group
          if (leader.entry.deferredSampleDt < 1e-8 && followers.every((f) => f.entry.deferredSampleDt < 1e-8)) {
            continue
          }
          runMixerSample(leader.entity, leader.entry, 'fair', true)
          sharedGroups++
          // Fan-out leader local pose to same-hash clones (skip their mixer.update).
          if (followers.length && leader.entry.poseNodes.length) {
            for (const f of followers) {
              f.entry.deferredSampleDt = 0
              if (f.entry.poseNodes.length) {
                fanOutLocalPose(leader.entry.poseNodes, f.entry.poseNodes)
              }
              sharedFanout++
              // Followers are decorative rigid — no PART / skinned work.
            }
          }
        } else {
          if (unit.cand.entry.deferredSampleDt < 1e-8) continue
          runMixerSample(unit.cand.entity, unit.cand.entry, 'fair', unit.cand.entry.shareableLooping)
        }
      }
      deferred += Math.max(0, n - fairQuota)
    } else if (fairUnits.length) {
      deferred += fairUnits.length
    }

    // fairSampleHz: unique fair units sampled this frame vs unit count.
    const fairN = fair.length
    const fairUnitsN = fairUnits.length
    const fairPeriod =
      fairUnitsN > 0 && fairSampled > 0 ? Math.max(1, fairUnitsN / Math.max(1, fairSampled)) : 0
    const fairSampleHz =
      fairPeriod > 0 ? displayFps / fairPeriod : fairUnitsN === 0 ? displayFps : 0

    this.lastStats = {
      bound: this.entries.size,
      active: near.length + fairN,
      sleeping,
      near: near.length,
      fair: fairN,
      sharedGroups,
      sharedFanout,
      sampled,
      deferred,
      budget,
      nearCap,
      fairSampleHz,
      displayFps,
      frameDt: delta,
      disabled: false
    }

    if (!this.verbose) return
    this.logAnimator(
      `Animator tick — ${this.entries.size} mixers · near=${near.length} fair=${fairN} ` +
        `units=${fairUnitsN} shared=${sharedGroups}+${sharedFanout} ` +
        `sampled=${sampled} (n=${nearSampled}/f=${fairSampled}) deferred=${deferred} ` +
        `budget=${budget}/${nearCap} fairHz≈${fairSampleHz.toFixed(0)}`,
      { throttleMs: 3000 }
    )
  }

  /**
   * Present: finish a few already-pending mixer binds. Do not scan every
   * static-no-clip GLB — that promoted the whole plaza on rAF (~1 fps).
   */
  private retryPendingBinds(cap: number): void {
    if (cap <= 0) return
    let bound = 0
    for (const entity of [...this.pendingBind]) {
      if (bound >= cap) return
      if (this.entries.has(entity)) {
        this.pendingBind.delete(entity)
        continue
      }
      const result = this.bindAndApplyEntity(entity)
      if (result === 'bound') {
        this.pendingBind.delete(entity)
        bound++
      } else if (result === 'skip') {
        this.pendingBind.delete(entity)
      }
    }
  }

  /**
   * In-view looping props at display rate (any distance). Shared-hash = one
   * mixer.update + fan-out. No binds, no PART (already sampled). Caps solo mixers.
   */
  private samplePresentDecoratives(delta: number, sampleCtx: AnimatorSampleContext): number {
    if (delta <= 1e-8) return 0
    sampleCtx.camera.updateMatrixWorld(true)
    _camPos.setFromMatrixPosition(sampleCtx.camera.matrixWorld)
    _projScreen.multiplyMatrices(
      sampleCtx.camera.projectionMatrix,
      sampleCtx.camera.matrixWorldInverse
    )
    _frustum.setFromProjectionMatrix(_projScreen)

    type DecorCand = { entity: Entity; entry: AnimEntry; distSq: number }
    const shareable: DecorCand[] = []
    const solo: DecorCand[] = []
    const now = performance.now()

    for (const [entity, entry] of this.entries) {
      if (entry.lastPresentGen === this.presentSampleGen) continue
      if (needsPartPhysxWork(entry, now)) continue
      if (!mixerHasActiveWork(entry) && !entry.sleeping) continue
      const { priority, distSq, inFrustum } = this.samplePriority(entry, sampleCtx)
      // In-frustum looping clips play at any range. Off-camera stays skipped.
      if (!inFrustum && priority < 2) continue
      if (entry.sleeping) {
        entry.sleeping = false
        entry.mixer.timeScale = 1
        entry.deferredSampleDt = 0
      }
      const cand: DecorCand = { entity, entry, distSq }
      // Signature may be unset on default autoplay — still share by hash.
      if (entry.shareableLooping && !entry.hasSkinned) {
        shareable.push(cand)
      } else if (entry.loopingOnly) {
        solo.push(cand)
      } else {
        solo.push(cand)
      }
    }

    const groups = new Map<string, { leader: DecorCand; followers: DecorCand[] }>()
    for (const cand of shareable) {
      const key = `${cand.entry.gltfHash}|${cand.entry.lastAppliedSignature ?? 'loop'}`
      const existing = groups.get(key)
      if (!existing) groups.set(key, { leader: cand, followers: [] })
      else existing.followers.push(cand)
    }

    const wallSec = now / 1000
    const SOLO_CAP = 12
    const GROUP_CAP = 24
    let sampled = 0
    const mark = (entry: AnimEntry): void => {
      entry.lastPresentGen = this.presentSampleGen
      entry.deferredSampleDt = 0
      if (entry.mixer.timeScale !== 1) entry.mixer.timeScale = 1
    }
    const sampleLooping = (entry: AnimEntry): void => {
      if (entry.loopingOnly || entry.shareableLooping) {
        snapLoopingActionsToWallClock(entry, wallSec)
        entry.mixer.update(0)
      } else {
        const step = Math.min(delta + entry.deferredSampleDt, 0.25)
        if (step > 1e-8) entry.mixer.update(step)
      }
    }

    const groupList = [...groups.values()].sort((a, b) => a.leader.distSq - b.leader.distSq)
    for (let gi = 0; gi < groupList.length; gi++) {
      if (gi >= GROUP_CAP) break
      const group = groupList[gi]!
      sampleLooping(group.leader.entry)
      mark(group.leader.entry)
      sampled++
      if (group.leader.entry.poseNodes.length) {
        for (const follower of group.followers) {
          if (follower.entry.poseNodes.length) {
            fanOutLocalPose(group.leader.entry.poseNodes, follower.entry.poseNodes)
          } else {
            sampleLooping(follower.entry)
          }
          mark(follower.entry)
        }
      } else {
        for (const follower of group.followers) {
          sampleLooping(follower.entry)
          mark(follower.entry)
          sampled++
        }
      }
    }

    solo.sort((a, b) => a.distSq - b.distSq)
    for (const cand of solo) {
      if (sampled >= SOLO_CAP && !cand.entry.loopingOnly) break
      if (sampled >= SOLO_CAP + 8) break
      sampleLooping(cand.entry)
      mark(cand.entry)
      sampled++
    }

    return sampled
  }

  /**
   * priority ≥ 2 → try every-frame (near / PART).
   * priority 1 → frustum (fair / shared-hash).
   * priority 0 → off-cam fair ring (may sleep if far).
   */
  private samplePriority(
    entry: AnimEntry,
    _ctx: AnimatorSampleContext
  ): { priority: number; distSq: number; inFrustum: boolean } {
    // Draw visual world is written every present. Pose matrixWorld is only
    // refreshed in renderMainPass *after* this sample — using it slept plaza
    // props at the origin (~60 m off-frustum) so they only advanced on async
    // with a 16 ms delta → ~⅓ speed.
    const pose =
      entry.poseNode ?? (entry.root.userData.dclPoseNode as THREE.Object3D | undefined)
    const visual = entry.root
    const visualAlive =
      visual.matrixWorld.elements[12] !== 0 ||
      visual.matrixWorld.elements[13] !== 0 ||
      visual.matrixWorld.elements[14] !== 0
    const anchor = visualAlive ? visual : (pose ?? visual)
    _worldPos.setFromMatrixPosition(anchor.matrixWorld)

    const dx = _worldPos.x - _camPos.x
    const dy = _worldPos.y - _camPos.y
    const dz = _worldPos.z - _camPos.z
    const distSq = dx * dx + dy * dy + dz * dz
    const nearSq = NEAR_PLAYER_FULL_RATE_M * NEAR_PLAYER_FULL_RATE_M

    // Rest-pose sphere (HighDrone2 rest is ~160 m from the entity origin).
    _cullScale.setFromMatrixScale(anchor.matrixWorld)
    const worldScale = Math.max(
      Math.abs(_cullScale.x),
      Math.abs(_cullScale.y),
      Math.abs(_cullScale.z),
      1e-3
    )
    _sphere.center.copy(entry.cullCenter).applyMatrix4(anchor.matrixWorld)
    _sphere.radius =
      (entry.cullRadius > 0 ? entry.cullRadius : FRUSTUM_EXPAND_M) * worldScale + FRUSTUM_EXPAND_M
    let inFrustum = _frustum.intersectsSphere(_sphere)
    // In-flight: current travel-node locals (not the whole clip AABB).
    if (!inFrustum && entry.travelNodes.length) {
      _sphere.radius = FRUSTUM_EXPAND_M * worldScale
      for (const node of entry.travelNodes) {
        _sphere.center.copy(node.position).applyMatrix4(anchor.matrixWorld)
        if (_frustum.intersectsSphere(_sphere)) {
          inFrustum = true
          break
        }
      }
    }

    // PART / one-shot doors — always highest priority (any distance). Hull follow must
    // not wait for the fair ring while a curtain/door is opening 30m away.
    if (hasPartColliderWork(entry)) {
      return { priority: 3, distSq, inFrustum: true }
    }
    if (distSq <= nearSq) return { priority: 2, distSq, inFrustum: true }
    if (inFrustum) return { priority: 1, distSq, inFrustum: true }

    return { priority: 0, distSq, inFrustum: false }
  }
}