import * as THREE from 'three'
import type { Entity } from '@dcl/ecs'
import type { ResolvedScene } from '../dcl/content/types'
import type { AssetCache } from '../rendering/AssetCache'
import { resolveGltfSrcHash } from '../rendering/DclTextureResolver'
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
  /** Active clips this frame (running / weight). */
  active: number
  near: number
  fair: number
  sampled: number
  deferred: number
  budget: number
  nearCap: number
  /**
   * Estimated sample rate for a typical fair-ring mixer (Hz), given current
   * display frame interval and fair budget share. Time-correct: still 1× speed.
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
const FRUSTUM_EXPAND_M = 6
/**
 * Hard ceiling — adaptive budget is almost always lower.
 * 64 full mixer.update()s per frame was crushing CBD to ~10 FPS (HUD showed
 * sampled 64/64 @ 10 display fps). Fair ring still advances all clips with
 * accumulated dt; we just spend fewer samples when the frame is already long.
 */
const MAX_SAMPLES_PER_FRAME = 32
/** Near / PART absolute ceiling (adaptive near cap is lower under load). */
const MAX_NEAR_ALWAYS_PER_FRAME = 12

/**
 * Scale sample count from last frame's wall dt so we recover FPS instead of
 * locking into a death spiral (low fps → large dt → expensive samples → lower fps).
 */
function adaptiveSampleBudget(frameDt: number): { budget: number; nearCap: number } {
  // ≥100ms (~10 fps): emergency — keep doors/near barely alive
  if (frameDt >= 0.1) return { budget: 6, nearCap: 3 }
  // ~20 fps
  if (frameDt >= 0.05) return { budget: 10, nearCap: 4 }
  // ~30 fps
  if (frameDt >= 0.033) return { budget: 14, nearCap: 6 }
  // ~45–50 fps
  if (frameDt >= 0.022) return { budget: 20, nearCap: 8 }
  // ≥60 fps headroom
  return { budget: MAX_SAMPLES_PER_FRAME, nearCap: MAX_NEAR_ALWAYS_PER_FRAME }
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

/** Highlight blimp / propeller assets in verbose logs (`?animatorverbose`). */
const ANIMATOR_FOCUS_SRC = /blimp|propeller|prop_/i

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
 * PART PhysX candidates: clip is **actually advancing** (running/scheduled).
 * Residual weight after clamp/finish must NOT keep entities in PART forever —
 * that + float noise re-cooked hulls every frame (~50 FPS thrash).
 */
function hasPartColliderWork(entry: AnimEntry): boolean {
  for (const action of entry.actions.values()) {
    if (action.isRunning() || action.isScheduled()) return true
  }
  return false
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
  private lastStats: AnimatorSampleStats = {
    bound: 0,
    active: 0,
    near: 0,
    fair: 0,
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

  /** Latest fair phase-slice counters (always updated on scheduled ticks). */
  getSampleStats(): AnimatorSampleStats {
    return { ...this.lastStats }
  }

  constructor(
    private readonly ecs: MirrorComponents,
    private readonly cache: AssetCache,
    private readonly sceneConfig: ResolvedScene,
    private readonly getNodes: () => Map<Entity, THREE.Group> | undefined
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
   * PART candidates: mixers with a running/scheduled clip (not residual weight).
   * Used by getPhysMotionSets → pushColliderPartPoses.
   */
  getActiveMixerEntities(): Entity[] {
    const out: Entity[] = []
    for (const [entity, entry] of this.entries) {
      if (hasPartColliderWork(entry)) out.push(entity)
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
    const part = hasPartColliderWork(entry)
    if (entry.hasSkinned) {
      entry.root.traverse((obj) => {
        const sk = obj as THREE.SkinnedMesh
        if (sk.isSkinnedMesh && sk.skeleton) sk.skeleton.update()
      })
    }
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
        if (state.shouldReset || !loop) action.reset()
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
    if (!this.verbose) return
    if (
      isMotionFocusActive() &&
      options.entity !== undefined &&
      this.motionFocusView &&
      !isInBlimpSubtree(options.entity, this.ecs, this.motionFocusView) &&
      !matchesMotionFocusSrc(message)
    ) {
      return
    }
    const key = options.entity !== undefined ? `animator:${options.entity}` : 'animator'
    clientDebugLog.log('animator', message, {
      level: options.level ?? 'info',
      throttleKey: key,
      throttleMs: options.throttleMs,
      alsoConsole: true
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

    for (const entity of toProcess) {
      if (!GltfContainer.has(entity)) {
        this.markRemoved(entity)
        continue
      }
      const result = this.bindAndApplyEntity(entity)
      if (result === 'bound') {
        this.dirtyReplay.delete(entity)
        this.pendingBind.delete(entity)
      } else if (result === 'waiting') {
        // Keep in pending; drop dirtyReplay so we don't thrash markDirty bookkeeping.
        this.dirtyReplay.delete(entity)
        this.pendingBind.add(entity)
      } else {
        // skip — no clips / static / given up
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

    const mesh = node.getObjectByName(`__mesh_${entity}`)
    if (!mesh) {
      this.logAnimator(`Animator wait mesh — entity ${entity} · ${src} (no __mesh_${entity} yet)`, {
        entity,
        throttleMs: 2000
      })
      return 'waiting'
    }

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
        hasSkinned
      }
      const nodeByName = loaded.animations.length ? buildNodeNameMap(mesh) : undefined
      for (const clip of loaded.animations) {
        const instanceClip = retargetAnimationClip(clip, mesh, nodeByName)
        entry.actions.set(clip.name, entry.mixer.clipAction(instanceClip, mesh))
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
   * Advance mixers with **fair phase-sliced sampling** (all clips keep running).
   *
   * Problem: CBD has hundreds of active mixers. Sampling all every frame kills FPS.
   * Old hard-cap starved mid-plaza props (first 48 near cam only).
   *
   * Solution — two layers, nothing permanently stopped:
   * 1) **Near/PART** (≤16m or doors): sample every frame up to {@link MAX_NEAR_ALWAYS_PER_FRAME}.
   * 2) **Fair ring**: remaining active mixers share leftover budget via a rotating cursor.
   *    Each sample uses accumulated `deferredSampleDt` so wall-clock is correct
   *    (2× dt every 2 frames ≈ same motion as 1× dt every frame).
   *
   * `delta === 0` (post-bind pose): sample all active work (no cull) so doors get first pose.
   */
  update(delta: number, view?: ProjectionView, sampleCtx?: AnimatorSampleContext): void {
    if (!this.entries.size) {
      this.lastStats = {
        ...this.lastStats,
        bound: 0,
        active: 0,
        near: 0,
        fair: 0,
        sampled: 0,
        deferred: 0,
        frameDt: delta,
        displayFps: delta > 1e-6 ? 1 / delta : 0,
        fairSampleHz: 0,
        disabled: false
      }
      return
    }
    // Door open/close CRDT often lands between async sync ticks — apply dirty before sample.
    if (view) this.applyDirtyBoundStates(view)

    this.sampleFrame++
    const schedule = delta > 1e-8 && sampleCtx != null

    // delta=0 pose pass — no budget (bind just applied).
    if (!schedule) {
      for (const [entity, entry] of this.entries) {
        if (!mixerHasActiveWork(entry)) continue
        entry.mixer.update(0)
        this.markShapeMotionAfterSample(entity, entry)
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

    type Cand = { entity: Entity; entry: AnimEntry; priority: number; distSq: number }
    const near: Cand[] = []
    const fair: Cand[] = []

    for (const [entity, entry] of this.entries) {
      if (!mixerHasActiveWork(entry)) {
        entry.deferredSampleDt = 0
        continue
      }
      // Everyone accumulates wall time; sampled entries clear their debt.
      entry.deferredSampleDt += delta
      const { priority, distSq } = this.samplePriority(entry, sampleCtx!)
      const cand: Cand = { entity, entry, priority, distSq }
      // priority ≥ 2: near camera or PART door — try every-frame.
      if (priority >= 2) near.push(cand)
      else fair.push(cand)
    }

    // Near: closer / PART first.
    near.sort((a, b) => b.priority - a.priority || a.distSq - b.distSq)
    // Fair ring: stable order by entity id so phase is deterministic.
    fair.sort((a, b) => (a.entity as number) - (b.entity as number))

    // Budget from *previous* frame length so a hitch this frame doesn't double-dip.
    const { budget, nearCap } = adaptiveSampleBudget(this.prevFrameDt)
    this.prevFrameDt = delta

    let sampled = 0
    let deferred = 0
    let nearSampled = 0
    let fairSampled = 0

    const runSample = (entity: Entity, entry: AnimEntry, layer: 'near' | 'fair'): void => {
      const step = entry.deferredSampleDt
      entry.deferredSampleDt = 0
      // Cap single jump so one hitch doesn't blow a multi-second sample (still time-correct overall).
      const clamped = Math.min(step, 0.25)
      if (clamped > 1e-8) entry.mixer.update(clamped)
      sampled++
      if (layer === 'near') nearSampled++
      else fairSampled++
      this.markShapeMotionAfterSample(entity, entry)
    }

    // --- Layer 1: near / PART (smooth view + doors) ---
    for (const cand of near) {
      if (sampled >= nearCap) {
        // Overflow near → fair ring still advances them this or next frames.
        fair.push(cand)
        continue
      }
      if (sampled >= budget) {
        deferred++
        continue
      }
      runSample(cand.entity, cand.entry, 'near')
    }

    // --- Layer 2: fair phase slice over remaining budget ---
    const budgetLeft = Math.max(0, budget - sampled)
    if (fair.length > 0 && budgetLeft > 0) {
      // Cursor walks the fair ring so every mixer is sampled every ceil(n/budget) frames.
      const n = fair.length
      const start = this.fairRingCursor % n
      this.fairRingCursor = (start + budgetLeft) % n
      for (let i = 0; i < budgetLeft; i++) {
        const cand = fair[(start + i) % n]!
        // Skip if already sampled as near this frame (shouldn't be in fair).
        if (cand.entry.deferredSampleDt < 1e-8) continue
        runSample(cand.entity, cand.entry, 'fair')
      }
      deferred += Math.max(0, n - budgetLeft)
    } else if (fair.length) {
      deferred += fair.length
    }

    const displayFps = delta > 1e-6 ? 1 / delta : 0
    // Each fair mixer is hit every ceil(fairN / fairSamples) frames → Hz = fps / period.
    const fairN = fair.length
    const fairPeriod = fairN > 0 && fairSampled > 0 ? Math.max(1, fairN / fairSampled) : 0
    const fairSampleHz = fairPeriod > 0 ? displayFps / fairPeriod : fairN === 0 ? displayFps : 0

    this.lastStats = {
      bound: this.entries.size,
      active: near.length + fair.length,
      near: near.length,
      fair: fairN,
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
      `Animator tick — ${this.entries.size} mixers · near=${near.length} fair=${fair.length} ` +
        `sampled=${sampled} (n=${nearSampled}/f=${fairSampled}) deferred=${deferred} ` +
        `budget=${budget}/${nearCap} fairHz≈${fairSampleHz.toFixed(0)}`,
      { throttleMs: 3000 }
    )
  }

  /**
   * priority ≥ 2 → try every-frame (near / PART).
   * priority 1 → frustum (fair ring, slightly prefer via sort if we ever dual-queue).
   * priority 0 → off-cam fair ring.
   */
  private samplePriority(
    entry: AnimEntry,
    _ctx: AnimatorSampleContext
  ): { priority: number; distSq: number } {
    const anchor = entry.root.parent ?? entry.root
    _worldPos.setFromMatrixPosition(anchor.matrixWorld)

    const dx = _worldPos.x - _camPos.x
    const dy = _worldPos.y - _camPos.y
    const dz = _worldPos.z - _camPos.z
    const distSq = dx * dx + dy * dy + dz * dz
    const nearSq = NEAR_PLAYER_FULL_RATE_M * NEAR_PLAYER_FULL_RATE_M

    // PART / one-shot doors near camera — highest.
    if (hasPartColliderWork(entry) && distSq <= nearSq * 2.25) {
      return { priority: 3, distSq }
    }
    if (distSq <= nearSq) return { priority: 2, distSq }

    _sphere.center.copy(_worldPos)
    _sphere.radius = FRUSTUM_EXPAND_M
    if (_frustum.intersectsSphere(_sphere)) return { priority: 1, distSq }

    return { priority: 0, distSq }
  }
}