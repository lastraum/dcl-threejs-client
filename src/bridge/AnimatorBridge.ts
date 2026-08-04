import * as THREE from 'three'
import type { Entity } from '@dcl/ecs'
import type { ResolvedScene } from '../dcl/content/types'
import type { AssetCache } from '../rendering/AssetCache'
import { resolveGltfSrcHash } from '../rendering/DclTextureResolver'
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
 * Unused when Preferences → Advanced → Full-rate scene animators is on.
 */
const SLEEP_OFF_FRUSTUM_M = 40
/**
 * Default-autoplay bind distance (promote instanced rest → clone + mixer).
 * Full-rate mode still uses this for *first bind*; once bound, always ticks.
 */
const DEFAULT_AUTOPLAY_BIND_M = 48
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
 * Default-autoplay promote (instance→clone) budget per frame.
 * Full-rate mode uses a higher cap so more props start animating sooner.
 */
const MAX_DEFAULT_BINDS_PER_FRAME = 3
const MAX_DEFAULT_BINDS_FULL_RATE = 12
/** Never let near layer eat the whole budget while fair in-view units exist. */
const FAIR_BUDGET_RESERVE_MIN = 4

/** Graphics Advanced: full scene-tick sampling for primary (default on). */
function primaryFullRateAnimators(): boolean {
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

/** @deprecated name — use hasRunningClip / isPartPhysxCandidate */
function hasPartColliderWork(entry: AnimEntry): boolean {
  return isPartPhysxCandidate(entry)
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
   */
  private markShapeMotionAfterSample(entity: Entity, entry: AnimEntry): void {
    const part = isPartPhysxCandidate(entry)
    if (entry.hasSkinned) {
      entry.root.traverse((obj) => {
        const sk = obj as THREE.SkinnedMesh
        if (sk.isSkinnedMesh && sk.skeleton) sk.skeleton.update()
      })
    }
    // Decorative rigid loops: skip forced updateMatrixWorld — scene graph pass is enough.
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
    const BIND_BUDGET = 8
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
      if (newBinds >= BIND_BUDGET) {
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
    const hasExplicitAnimator = Animator.has(entity)
    if (!hasExplicitAnimator && this.staticGltfNoClips.has(entity) && !this.entries.has(entity)) {
      return 'skip'
    }
    // Default autoplay (DCL first-clip): defer until near-camera sample path so far
    // plaza props stay GPU-instanced rest poses (visibility intact, no 3k clones).
    if (!hasExplicitAnimator && !this.allowDefaultAutoplayBind && !this.entries.has(entity)) {
      this.pendingBind.add(entity)
      return 'waiting'
    }

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

    // Instanced rest-pose → private clone so mixer can bind.
    let mesh = node.getObjectByName(`__mesh_${entity}`) as THREE.Object3D | null
    if (node.userData.dclInstanced || !mesh || mesh.userData.dclInstanceMarker) {
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
    mesh.traverse((o) => {
      o.matrixAutoUpdate = true
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
        gltfHash: hash,
        gltfSrc: src,
        deferredSampleDt: 0,
        hasSkinned,
        sleeping: false,
        poseNodes: collectPoseNodes(mesh),
        loopingOnly: false,
        shareableLooping: false
      }
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
   * Legacy path (flag off): shared-hash + fair phase + off-frustum sleep for CBD FPS.
   *
   * `delta === 0` (post-bind pose): sample active work so doors get first pose.
   * Tertiary multi-scene still uses {@link setAllSleeping} (force freeze).
   */
  update(delta: number, view?: ProjectionView, sampleCtx?: AnimatorSampleContext): void {
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

    // Promote + bind deferred default autoplay (amortized — no plaza bind storm).
    this.allowDefaultAutoplayBind = true
    const bindSq = DEFAULT_AUTOPLAY_BIND_M * DEFAULT_AUTOPLAY_BIND_M
    const bindCap = fullRate ? MAX_DEFAULT_BINDS_FULL_RATE : MAX_DEFAULT_BINDS_PER_FRAME
    let bindsThisFrame = 0
    for (const entity of [...this.pendingBind]) {
      if (bindsThisFrame >= bindCap) break
      if (this.entries.has(entity)) {
        this.pendingBind.delete(entity)
        continue
      }
      const node = this.getNodes()?.get(entity)
      if (!node) continue
      // Frozen/instanced roots may have stale matrixWorld until the render walk —
      // force one update so near-camera tests match the live scene pose.
      node.updateMatrixWorld(true)
      _worldPos.setFromMatrixPosition(node.matrixWorld)
      const dx = _worldPos.x - _camPos.x
      const dy = _worldPos.y - _camPos.y
      const dz = _worldPos.z - _camPos.z
      const distSq = dx * dx + dy * dy + dz * dz
      // Bind near camera always; also bind farther if roughly in expanded frustum.
      if (distSq > bindSq) {
        _sphere.center.copy(_worldPos)
        _sphere.radius = FRUSTUM_EXPAND_M
        if (!_frustum.intersectsSphere(_sphere)) continue
        // Cap far frustum autoplay bind so we don't clone the whole plaza at once.
        if (distSq > bindSq * 2.25) continue
      }
      const result = this.bindAndApplyEntity(entity)
      if (result === 'bound') {
        this.pendingBind.delete(entity)
        bindsThisFrame++
      } else if (result === 'skip') {
        this.pendingBind.delete(entity)
      }
    }
    this.allowDefaultAutoplayBind = false

    // --- Full-rate primary path: every active mixer, every frame, full delta ---
    if (fullRate) {
      let sampled = 0
      let active = 0
      for (const [entity, entry] of this.entries) {
        if (entry.sleeping) {
          entry.sleeping = false
          entry.mixer.timeScale = 1
          entry.deferredSampleDt = 0
        }
        if (!mixerHasActiveWork(entry)) {
          entry.deferredSampleDt = 0
          continue
        }
        active++
        entry.deferredSampleDt = 0
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
    const wake = (entry: AnimEntry): void => {
      if (!entry.sleeping) return
      entry.sleeping = false
      entry.mixer.timeScale = 1
      entry.deferredSampleDt = 0
      // Wall-clock phase so shared-hash groups rejoin in sync.
      snapLoopingActionsToWallClock(entry, performance.now() / 1000)
    }

    for (const [entity, entry] of this.entries) {
      if (!mixerHasActiveWork(entry) && !entry.sleeping) {
        entry.deferredSampleDt = 0
        continue
      }
      const { priority, distSq, inFrustum } = this.samplePriority(entry, sampleCtx!)
      const isPart = hasPartColliderWork(entry)
      // Sleep only when off-frustum and far — in-view props stay awake (user goal).
      if (!isPart && priority < 2 && !inFrustum && distSq > sleepOffSq) {
        putToSleep(entry)
        continue
      }
      wake(entry)
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
   * priority ≥ 2 → try every-frame (near / PART).
   * priority 1 → frustum (fair / shared-hash).
   * priority 0 → off-cam fair ring (may sleep if far).
   */
  private samplePriority(
    entry: AnimEntry,
    _ctx: AnimatorSampleContext
  ): { priority: number; distSq: number; inFrustum: boolean } {
    const anchor = entry.root.parent ?? entry.root
    _worldPos.setFromMatrixPosition(anchor.matrixWorld)

    const dx = _worldPos.x - _camPos.x
    const dy = _worldPos.y - _camPos.y
    const dz = _worldPos.z - _camPos.z
    const distSq = dx * dx + dy * dy + dz * dz
    const nearSq = NEAR_PLAYER_FULL_RATE_M * NEAR_PLAYER_FULL_RATE_M

    _sphere.center.copy(_worldPos)
    _sphere.radius = FRUSTUM_EXPAND_M
    const inFrustum = _frustum.intersectsSphere(_sphere)

    // PART / one-shot doors near camera — highest.
    if (hasPartColliderWork(entry) && distSq <= nearSq * 2.25) {
      return { priority: 3, distSq, inFrustum: true }
    }
    if (distSq <= nearSq) return { priority: 2, distSq, inFrustum: true }
    if (inFrustum) return { priority: 1, distSq, inFrustum: true }

    return { priority: 0, distSq, inFrustum: false }
  }
}