import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import {
  AVATAR_EMOTE_DOUBLE_JUMP,
  AVATAR_EMOTE_GLIDE,
  AVATAR_EMOTE_IDLE,
  AVATAR_EMOTE_JOG,
  AVATAR_EMOTE_JUMP,
  AVATAR_EMOTE_RUN,
  AVATAR_EMOTE_WALK
} from './constants'
import { AvatarLocomotionVfx } from './AvatarLocomotionVfx'
import {
  emoteNeedsPropScene,
  bindEmoteParticleMeshes,
  cloneEmotePropRoots,
  prepareEmotePropRoot,
  splitEmoteClips
} from './emotePlayback'
import { remapClipToAvatar } from './emoteBoneMap'
import { reanchorEmoteHipPositions } from './emoteHipRetarget'
import {
  collectParallelWearableStates,
  findBodyShapeRoot,
  syncParallelWearableStates,
  type ParallelWearableState
} from './loadWearable'
import { getRemappedLocomotionClip } from './locomotionClipCache'
import type { AssetCache, CachedGltf } from '../rendering/AssetCache'
import { yieldToIdle } from '../rendering/mainThreadYield'
import { stabilizeSkinnedMeshes } from '../rendering/skinnedMeshInstance'
import type { LocomotionMode } from '../player/locomotion'
import { DCL_LOCOMOTION_DEFAULTS } from '../player/locomotion'
import { loadLocomotionEmoteGltf, type LocomotionEmoteSlug } from './profileEmotes'
import { DoubleJumpTwirl } from './doubleJumpTwirl'
import type { BodyShape } from './types'
import { isAvatarVerbose } from '../client/debug/ClientDebugLog'
import { isAppleTouchDevice } from '../util/appleTouch'

export type AvatarLocomotionState = {
  horizontalSpeed: number
  grounded: boolean
  /** Wide ground probe — walk blend when grounded flickers near the floor. */
  nearGround?: boolean
  /** Capsule vertical velocity — keeps walk when probe flickers against walls. */
  verticalVelocity?: number
  locomotionMode: LocomotionMode
  jumping: boolean
  doubleJumping: boolean
  /** One frame — air-jump impulse applied (procedural twirl + spin puff). */
  doubleJumpTriggered?: boolean
  falling: boolean
  /** Hold-Space glider open (Explorer) — Glide_Avatar arms-hold pose. */
  gliding?: boolean
  /** Planar move axis in avatar-local space (+X right, -Z forward) for VRM directional locomotion. */
  moveAxisX?: number
  moveAxisZ?: number
  /** Capsule target speed for active locomotion mode — stabilizes VRM foot cadence vs raw velocity. */
  targetLocomotionSpeed?: number
}

/** DCL locomotion emotes retargeted to the composed avatar skeleton (Forge / wearable-preview). */
export class AvatarAnimations {
  private avatarRoot: THREE.Object3D | null = null
  private attachParent: THREE.Object3D | null = null
  private vfxScene: THREE.Scene | null = null
  private mixer: THREE.AnimationMixer | null = null
  private propMixer: THREE.AnimationMixer | null = null
  private propRoot: THREE.Object3D | null = null
  private locomotionVfx: AvatarLocomotionVfx | null = null
  private idleAction: THREE.AnimationAction | null = null
  private walkAction: THREE.AnimationAction | null = null
  /** Dedicated Explorer Jog clip; null → jog falls back to runAction slowed. */
  private jogAction: THREE.AnimationAction | null = null
  private runAction: THREE.AnimationAction | null = null
  private jumpAction: THREE.AnimationAction | null = null
  private doubleJumpAction: THREE.AnimationAction | null = null
  /** Glide_Avatar — arms on glider handles (from glide.glb). */
  private glideAction: THREE.AnimationAction | null = null
  /** True when double_jump.glb (or Catalyst clip) loaded — not jump.glb fallback. */
  private hasDedicatedDoubleJumpClip = false
  private profileAction: THREE.AnimationAction | null = null
  private propAction: THREE.AnimationAction | null = null
  private profileActive = false
  private profileEmoteLoop = false
  private activeProfileEmoteKey: string | null = null
  /** Fired when a one-shot profile emote finishes (cast → Fishing_Idle queue). */
  private onOneShotFinished: (() => void) | null = null
  private doubleJumpPlaying = false
  private readonly twirl = new DoubleJumpTwirl()
  private walkBlend = 0
  private jogBlend = 0
  private runBlend = 0
  private jumpBlend = 0
  private glideBlend = 0
  private bindGeneration = 0
  /** Parallel-skeleton wearable states cached at bind (no traverse per frame). */
  private parallelWearables: ParallelWearableState[] = []
  private poseLogFrames = 0

  setVfxScene(scene: THREE.Scene | null): void {
    this.vfxScene = scene
    if (scene && this.avatarRoot && !this.locomotionVfx) {
      this.locomotionVfx = new AvatarLocomotionVfx()
      this.locomotionVfx.bind(this.avatarRoot, scene)
    }
  }

  setOnOneShotFinished(handler: (() => void) | null): void {
    this.onOneShotFinished = handler
  }

  async bind(
    avatarRoot: THREE.Object3D,
    attachParent?: THREE.Object3D,
    options?: { bodyShape?: BodyShape; peerUrl?: string; assetCache?: AssetCache | null }
  ): Promise<void> {
    this.dispose()
    const generation = this.bindGeneration
    this.avatarRoot = avatarRoot
    const animationRoot = findBodyShapeRoot(avatarRoot)
    this.attachParent = attachParent ?? avatarRoot.parent ?? avatarRoot
    this.parallelWearables = collectParallelWearableStates(avatarRoot)
    this.mixer = new THREE.AnimationMixer(animationRoot)
    this.mixer.addEventListener('finished', this.onMixerFinished)

    if (this.vfxScene) {
      this.locomotionVfx = new AvatarLocomotionVfx()
      this.locomotionVfx.bind(avatarRoot, this.vfxScene)
    }

    const bodyShape = options?.bodyShape ?? 'male'
    const cache = options?.assetCache
    const peerUrl = options?.peerUrl

    /** Load clip; for double_jump do **not** fall back to jump (that looked like a normal jump). */
    const loadSlug = async (
      slug: LocomotionEmoteSlug,
      opts?: { allowJumpFallback?: boolean }
    ): Promise<THREE.AnimationClip | null> => {
      if (cache && peerUrl) {
        const gltf = await loadLocomotionEmoteGltf(slug, bodyShape, peerUrl, cache)
        if (gltf?.animations[0]) return gltf.animations[0]
        if (slug === 'double_jump' && opts?.allowJumpFallback) {
          const jumpGltf = await loadLocomotionEmoteGltf('jump', bodyShape, peerUrl, cache)
          return jumpGltf?.animations[0] ?? null
        }
        return null
      }
      const path =
        slug === 'idle'
          ? AVATAR_EMOTE_IDLE
          : slug === 'walk'
            ? AVATAR_EMOTE_WALK
            : slug === 'jog'
              ? AVATAR_EMOTE_JOG
              : slug === 'run'
                ? AVATAR_EMOTE_RUN
                : slug === 'double_jump'
                  ? AVATAR_EMOTE_DOUBLE_JUMP
                  : AVATAR_EMOTE_JUMP
      try {
        const loader = new GLTFLoader()
        const gltf = await loader.loadAsync(path)
        if (gltf.animations[0]) return gltf.animations[0]
      } catch {
        if (slug === 'double_jump' && opts?.allowJumpFallback) {
          try {
            const loader = new GLTFLoader()
            const gltf = await loader.loadAsync(AVATAR_EMOTE_JUMP)
            return gltf.animations[0] ?? null
          } catch {
            return null
          }
        }
      }
      return null
    }

    const [idleClip, walkClip, jogClip, runClip, jumpClip, doubleJumpClip, glideClip] =
      await Promise.all([
        loadSlug('idle'),
        loadSlug('walk'),
        loadSlug('jog'),
        loadSlug('run'),
        loadSlug('jump'),
        // Dedicated clip only — missing file → procedural twirl (Explorer hard-coded keyframe).
        loadSlug('double_jump', { allowJumpFallback: false }),
        loadGlideAvatarClip()
      ])

    if (generation !== this.bindGeneration || !this.mixer) return

    if (!idleClip) {
      throw new Error('locomotion idle emote unavailable')
    }

    // Grounded gaits keep the authored hip bob; air clips stay position-stripped
    // (physics owns vertical travel there and clip offsets would fight the capsule).
    this.idleAction = this.playLoop(idleClip, animationRoot, bodyShape, 1, { keepHipBob: true })
    if (!this.idleAction) {
      throw new Error('locomotion idle remapped to 0 tracks — avatar stays bind-pose without this')
    }
    this.walkAction = this.playLoop(walkClip ?? undefined, animationRoot, bodyShape, 0, {
      keepHipBob: true
    })
    this.jogAction = this.playLoop(jogClip ?? undefined, animationRoot, bodyShape, 0, {
      keepHipBob: true
    })
    this.runAction = this.playLoop(runClip ?? undefined, animationRoot, bodyShape, 0, {
      keepHipBob: true
    })
    this.jumpAction = this.playLoop(jumpClip ?? undefined, animationRoot, bodyShape, 0)
    this.hasDedicatedDoubleJumpClip = Boolean(doubleJumpClip)
    this.doubleJumpAction = doubleJumpClip
      ? this.playOneShot(doubleJumpClip, animationRoot, bodyShape)
      : null
    // Hold pose (short clip) — clamp last frame while gliding.
    this.glideAction = glideClip
      ? this.playHold(glideClip, animationRoot, bodyShape)
      : null

    if (!this.walkAction || !this.runAction || !this.jumpAction || !this.jogAction) {
      console.warn('[avatar] locomotion bind:', {
        walk: !!this.walkAction,
        jog: !!this.jogAction,
        run: !!this.runAction,
        jump: !!this.jumpAction,
        doubleJumpClip: this.hasDedicatedDoubleJumpClip,
        doubleJumpProcedural: !this.hasDedicatedDoubleJumpClip,
        glide: !!this.glideAction,
        idle: !!this.idleAction
      })
    } else if (!this.glideAction) {
      console.warn('[avatar] Glide_Avatar missing — glider uses frozen jump pose')
    }

    this.advancePose(0)
  }

  triggerDoubleJump(): void {
    if (this.profileActive || !this.avatarRoot) return
    this.doubleJumpPlaying = true
    if (this.hasDedicatedDoubleJumpClip && this.doubleJumpAction) {
      // Bundled/Catalyst Double_Jump clip — play as oneshot only (no extra spin).
      this.doubleJumpAction.reset()
      this.doubleJumpAction.setEffectiveWeight(1)
      this.doubleJumpAction.play()
    } else {
      // Explorer parity: hard-coded clockwise Y twirl + jump pose.
      this.twirl.start(this.avatarRoot)
      if (this.jumpAction) {
        this.jumpAction.reset()
        this.jumpAction.setEffectiveWeight(1)
        this.jumpAction.play()
      }
    }
    this.locomotionVfx?.triggerAirJumpPuff()
  }

  /** Remapped avatar clips by emote key — second play skips track retarget. */
  private readonly remappedProfileClips = new Map<string, THREE.AnimationClip>()

  /**
   * Profile emote from full GLB — avatar retarget + prop meshes.
   * Prefer {@link playProfileEmoteFromGltfAsync} on the play path (yields between heavy steps).
   */
  playProfileEmoteFromGltf(gltf: CachedGltf, loop = false, emoteKey?: string): boolean {
    // Sync path for backpack preview — still used; cold play should use async.
    return this.applyProfileEmoteFromGltf(gltf, loop, emoteKey)
  }

  /**
   * Same as playProfileEmoteFromGltf but yields between split / prop clone / retarget so
   * first-time watering-can / sit does not hard-freeze the rAF loop.
   */
  async playProfileEmoteFromGltfAsync(
    gltf: CachedGltf,
    loop = false,
    emoteKey?: string,
    isCancelled?: () => boolean
  ): Promise<boolean> {
    if (!this.mixer || !this.avatarRoot || !this.attachParent) return false

    const key = emoteKey ?? gltf.animations.map((clip) => clip.name).join('|')
    if (this.profileActive && this.activeProfileEmoteKey === key && this.profileEmoteLoop === loop) {
      return true
    }

    this.teardownProfileEmotePlayback()
    this.profileEmoteLoop = loop
    if (isCancelled?.()) return false

    await yieldToIdle(24)
    if (isCancelled?.() || !this.mixer || !this.avatarRoot || !this.attachParent) return false

    const { avatarClip, propClip, propTrackTargets } = splitEmoteClips(gltf, this.avatarRoot)
    const needsPropScene = !!propClip || emoteNeedsPropScene(gltf, propTrackTargets)
    if (!avatarClip && !needsPropScene) {
      console.warn(
        `[avatar] emote has no playable avatar or prop tracks (${gltf.animations.map((a) => a.name).join(', ')})`
      )
      this.finishProfileEmoteStop()
      return false
    }

    await yieldToIdle(24)
    if (isCancelled?.() || !this.mixer || !this.avatarRoot || !this.attachParent) return false

    if (needsPropScene) {
      // SkeletonUtils clone of prop armatures is the main first-play hitch for watering/sit.
      this.propRoot = cloneEmotePropRoots(gltf.root)
      await yieldToIdle(24)
      if (isCancelled?.() || !this.mixer || !this.avatarRoot || !this.attachParent) {
        this.teardownProfileEmotePlayback()
        return false
      }
      bindEmoteParticleMeshes(this.propRoot)
      prepareEmotePropRoot(this.propRoot, propTrackTargets)
      stabilizeSkinnedMeshes(this.propRoot)
      this.attachParent.add(this.propRoot)
      this.propMixer = new THREE.AnimationMixer(this.propRoot)
      this.propMixer.addEventListener('finished', this.onProfileFinished)
      if (propClip) {
        this.propAction = this.propMixer.clipAction(propClip)
        this.propAction.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, loop ? Infinity : 1)
        this.propAction.clampWhenFinished = !loop
        this.propAction.reset()
        this.propAction.enabled = true
        this.propAction.setEffectiveWeight(1)
        this.propAction.play()
      }
    }

    await yieldToIdle(24)
    if (isCancelled?.() || !this.mixer || !this.avatarRoot) {
      this.teardownProfileEmotePlayback()
      return false
    }

    if (avatarClip) {
      let remapped = this.remappedProfileClips.get(key)
      if (!remapped) {
        remapped = this.remapProfileEmoteClip(avatarClip, gltf.root) ?? undefined
        if (remapped) this.remappedProfileClips.set(key, remapped)
      }
      if (remapped) {
        this.profileAction = this.mixer.clipAction(remapped)
        this.profileAction.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, loop ? Infinity : 1)
        this.profileAction.clampWhenFinished = !loop
        this.profileAction.reset()
        this.profileAction.enabled = true
        this.profileAction.setEffectiveWeight(1)
        this.profileAction.play()
      }
    }

    if (!this.profileAction && !this.propAction) {
      this.finishProfileEmoteStop()
      return false
    }

    this.activeProfileEmoteKey = key
    this.profileActive = true
    this.applyProfileEmoteWeights()
    this.advancePose(0)
    return true
  }

  private applyProfileEmoteFromGltf(gltf: CachedGltf, loop: boolean, emoteKey?: string): boolean {
    if (!this.mixer || !this.avatarRoot || !this.attachParent) return false

    const key = emoteKey ?? gltf.animations.map((clip) => clip.name).join('|')
    if (this.profileActive && this.activeProfileEmoteKey === key && this.profileEmoteLoop === loop) {
      return true
    }

    this.teardownProfileEmotePlayback()
    this.profileEmoteLoop = loop
    const { avatarClip, propClip, propTrackTargets } = splitEmoteClips(gltf, this.avatarRoot)
    const needsPropScene = !!propClip || emoteNeedsPropScene(gltf, propTrackTargets)
    if (!avatarClip && !needsPropScene) {
      console.warn(
        `[avatar] emote has no playable avatar or prop tracks (${gltf.animations.map((a) => a.name).join(', ')})`
      )
      this.finishProfileEmoteStop()
      return false
    }

    if (needsPropScene) {
      this.propRoot = cloneEmotePropRoots(gltf.root)
      bindEmoteParticleMeshes(this.propRoot)
      prepareEmotePropRoot(this.propRoot, propTrackTargets)
      stabilizeSkinnedMeshes(this.propRoot)
      this.attachParent.add(this.propRoot)
      this.propMixer = new THREE.AnimationMixer(this.propRoot)
      this.propMixer.addEventListener('finished', this.onProfileFinished)
      if (propClip) {
        this.propAction = this.propMixer.clipAction(propClip)
        this.propAction.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, loop ? Infinity : 1)
        this.propAction.clampWhenFinished = !loop
        this.propAction.reset()
        this.propAction.enabled = true
        this.propAction.setEffectiveWeight(1)
        this.propAction.play()
      }
    }

    if (avatarClip) {
      let remapped = this.remappedProfileClips.get(key)
      if (!remapped) {
        remapped = this.remapProfileEmoteClip(avatarClip, gltf.root) ?? undefined
        if (remapped) this.remappedProfileClips.set(key, remapped)
      }
      if (remapped) {
        this.profileAction = this.mixer.clipAction(remapped)
        this.profileAction.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, loop ? Infinity : 1)
        this.profileAction.clampWhenFinished = !loop
        this.profileAction.reset()
        this.profileAction.enabled = true
        this.profileAction.setEffectiveWeight(1)
        this.profileAction.play()
      }
    }

    if (!this.profileAction && !this.propAction) {
      this.finishProfileEmoteStop()
      return false
    }

    this.activeProfileEmoteKey = key
    this.profileActive = true
    this.applyProfileEmoteWeights()
    this.advancePose(0)
    return true
  }

  /**
   * Bone-name remap + sit/chair hips re-anchor (cm-scale emote → meter avatar rest).
   * Locomotion keeps its own hip-bob path in {@link getRemappedLocomotionClip}.
   */
  private remapProfileEmoteClip(
    clip: THREE.AnimationClip,
    emoteRoot: THREE.Object3D
  ): THREE.AnimationClip | null {
    if (!this.avatarRoot) return null
    const body = findBodyShapeRoot(this.avatarRoot)
    const remapped = remapClipToAvatar(clip, body)
    if (!remapped) return null
    return reanchorEmoteHipPositions(remapped, emoteRoot, body)
  }

  /** One-shot or loop profile emote — locomotion clips only (no prop scene). */
  playProfileEmote(clip: THREE.AnimationClip, loop = false, emoteKey?: string): boolean {
    if (!this.mixer || !this.avatarRoot) return false

    const key = emoteKey ?? clip.name
    if (this.profileActive && this.activeProfileEmoteKey === key && this.profileEmoteLoop === loop) {
      return true
    }

    this.teardownProfileEmotePlayback()
    // No emote GLB root — cannot re-anchor hips; rotations-only remap.
    const remapped = remapClipToAvatar(clip, findBodyShapeRoot(this.avatarRoot))
    if (!remapped) {
      console.warn(`[avatar] emote "${clip.name}" has no matching bone tracks`)
      this.finishProfileEmoteStop()
      return false
    }

    const action = this.mixer.clipAction(remapped)
    action.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, loop ? Infinity : 1)
    action.clampWhenFinished = !loop
    action.reset()
    action.enabled = true
    action.setEffectiveWeight(1)
    action.play()

    this.profileAction = action
    this.profileEmoteLoop = loop
    this.activeProfileEmoteKey = key
    this.profileActive = true
    this.applyProfileEmoteWeights()
    this.advancePose(0)
    return true
  }

  stopProfileEmote(opts?: { silent?: boolean }): void {
    const wasOneShot = this.profileActive && !this.profileEmoteLoop
    this.teardownProfileEmotePlayback()
    this.finishProfileEmoteStop()
    if (wasOneShot && !opts?.silent) {
      this.onOneShotFinished?.()
    }
  }

  isProfileEmoteActive(): boolean {
    return this.profileActive
  }

  /** Apply mixer, then drive any parallel-skeleton wearables from the body pose. */
  private advancePose(delta: number): void {
    this.mixer?.update(delta)
    this.propMixer?.update(delta)
    if (!this.parallelWearables.length && this.avatarRoot) {
      this.parallelWearables = collectParallelWearableStates(this.avatarRoot)
    }
    if (this.parallelWearables.length) {
      this.avatarRoot.updateMatrixWorld(true)
      syncParallelWearableStates(this.parallelWearables)
    } else if (isAppleTouchDevice()) {
      // iOS: mixer writes bone locals; force world matrices so merged hair skins this frame.
      this.avatarRoot?.updateMatrixWorld(true)
    }
    this.maybeLogHeadPose()
  }

  private maybeLogHeadPose(): void {
    if (!isAvatarVerbose() || !isAppleTouchDevice() || !this.avatarRoot) return
    this.poseLogFrames++
    if (this.poseLogFrames % 45 !== 1) return
    const root = this.avatarRoot
    let head: THREE.Bone | null = null
    let hips: THREE.Bone | null = null
    const extras: string[] = []
    root.traverse((obj) => {
      if (obj instanceof THREE.Bone) {
        if (!head && /^(Avatar_Head|Head)$/i.test(obj.name)) head = obj
        if (!hips && /Hips/i.test(obj.name)) hips = obj
      }
      const parallel = obj.userData?.dclParallelWearable
      const named = /hair|facial|hat|helmet|head_base|skeleton_head|mesh0/i.test(obj.name)
      const mergedChild = obj instanceof THREE.SkinnedMesh && obj.parent === root
      if (
        obj instanceof THREE.SkinnedMesh &&
        (parallel || named || mergedChild || /head/i.test(obj.name))
      ) {
        obj.updateWorldMatrix(false, false)
        const y = new THREE.Vector3().setFromMatrixPosition(obj.matrixWorld).y
        extras.push(
          `${obj.name}<${obj.parent?.name ?? 'null'}>y=${y.toFixed(3)}par=${parallel ? '1' : '0'}`
        )
      }
    })
    head?.updateWorldMatrix(true, false)
    hips?.updateWorldMatrix(true, false)
    const headY = head
      ? new THREE.Vector3().setFromMatrixPosition(head.matrixWorld).y
      : null
    const hipsY = hips
      ? new THREE.Vector3().setFromMatrixPosition(hips.matrixWorld).y
      : null
    const dy = headY != null && hipsY != null ? (headY - hipsY).toFixed(3) : '?'
    console.info(
      `[avatar] pose parallel=${this.parallelWearables.length} ` +
        `head=${head?.name ?? 'none'}@${headY?.toFixed(3) ?? '?'} ` +
        `hips=${hips?.name ?? 'none'}@${hipsY?.toFixed(3) ?? '?'} dy=${dy} ` +
        `extras=${extras.slice(0, 8).join('|') || 'none'}`
    )
  }

  update(delta: number, state: AvatarLocomotionState): void {
    if (!this.mixer) return

    if (state.doubleJumpTriggered && !state.gliding) {
      this.triggerDoubleJump()
    }

    if (this.profileActive) {
      this.twirl.reset()
      this.applyProfileEmoteWeights()
      this.advancePose(delta)
      return
    }

    // Landed or gliding — stop double-jump oneshot / twirl so it cannot loop in air.
    if ((state.grounded || state.gliding) && (this.twirl.active || this.doubleJumpPlaying)) {
      this.twirl.reset()
      this.doubleJumpPlaying = false
      this.doubleJumpAction?.stop()
    }

    const twirling = this.twirl.update(delta)
    if (twirling === false && this.doubleJumpPlaying && !this.hasDedicatedDoubleJumpClip) {
      this.doubleJumpPlaying = false
    }
    if (!state.gliding && (this.doubleJumpPlaying || twirling)) {
      this.idleAction?.setEffectiveWeight(0)
      this.walkAction?.setEffectiveWeight(0)
      this.jogAction?.setEffectiveWeight(0)
      this.runAction?.setEffectiveWeight(0)
      if (this.hasDedicatedDoubleJumpClip && this.doubleJumpAction) {
        this.jumpAction?.setEffectiveWeight(0)
        this.doubleJumpAction.setEffectiveWeight(1)
      } else {
        // Procedural twirl + jump pose (no fake double_jump = jump.glb oneshot).
        this.doubleJumpAction?.setEffectiveWeight(0)
        this.jumpAction?.setEffectiveWeight(1)
      }
      this.advancePose(delta)
      return
    }

    // Asymmetric blend: stop walk/run faster than start (remote idle lag fix).
    const kIn = 1 - Math.exp(-14 * delta)
    const kOut = 1 - Math.exp(-32 * delta)
    const blendToward = (cur: number, target: number): number =>
      cur + (target - cur) * (target < cur - 1e-4 ? kOut : kIn)
    let targetWalk = 0
    let targetJog = 0
    let targetRun = 0
    let targetJump = 0
    let targetGlide = 0

    const vy = state.verticalVelocity ?? 0
    // Glide owns the upper body — never treat WASD glide as grounded locomotion.
    const locomotionGrounded =
      !state.gliding &&
      (state.grounded ||
        state.nearGround === true ||
        (state.horizontalSpeed > 0.12 &&
          !state.jumping &&
          !state.doubleJumping &&
          !state.falling &&
          vy > -3))

    if (state.gliding) {
      // Priority: full glide pose. Walk/run must not keep arm tracks (drops arms on WASD).
      if (this.glideAction) {
        targetGlide = 1
      } else {
        targetJump = 1
      }
    } else if (!locomotionGrounded) {
      if (state.jumping || state.falling || state.doubleJumping) {
        targetJump = 1
      }
    } else if (state.horizontalSpeed > 0.05) {
      if (state.locomotionMode === 'walk' && this.walkAction) {
        targetWalk = Math.min(1, state.horizontalSpeed / DCL_LOCOMOTION_DEFAULTS.walkSpeed)
      } else if (state.locomotionMode === 'jog' && this.jogAction) {
        targetJog = Math.min(1, state.horizontalSpeed / DCL_LOCOMOTION_DEFAULTS.jogSpeed)
      } else if (this.runAction) {
        const ref =
          state.locomotionMode === 'run'
            ? DCL_LOCOMOTION_DEFAULTS.runSpeed
            : DCL_LOCOMOTION_DEFAULTS.jogSpeed
        targetRun = Math.min(1, state.horizontalSpeed / ref)
      }
    }

    if (state.gliding) {
      // Snap loco blends off so residual walk/run weight cannot pull arms down.
      this.walkBlend = 0
      this.jogBlend = 0
      this.runBlend = 0
      this.jumpBlend = targetJump
      this.glideBlend = blendToward(this.glideBlend, targetGlide)
    } else {
      this.walkBlend = blendToward(this.walkBlend, targetWalk)
      this.jogBlend = blendToward(this.jogBlend, targetJog)
      this.runBlend = blendToward(this.runBlend, targetRun)
      this.jumpBlend = blendToward(this.jumpBlend, targetJump)
      this.glideBlend = blendToward(this.glideBlend, targetGlide)
      // Snap residual walk when fully stopped — avoids multi-second moonwalk after remote halt.
      if (
        targetWalk === 0 &&
        targetJog === 0 &&
        targetRun === 0 &&
        this.walkBlend + this.jogBlend + this.runBlend < 0.06
      ) {
        this.walkBlend = 0
        this.jogBlend = 0
        this.runBlend = 0
      }
    }

    const airBlend = Math.max(this.jumpBlend, this.glideBlend)
    const locomotion = Math.max(this.walkBlend, this.jogBlend, this.runBlend)
    const idleWeight = Math.max(0, 1 - locomotion - airBlend)

    if (state.gliding && this.glideAction) {
      this.idleAction?.setEffectiveWeight(0)
      this.walkAction?.setEffectiveWeight(0)
      this.jogAction?.setEffectiveWeight(0)
      this.runAction?.setEffectiveWeight(0)
      this.jumpAction?.setEffectiveWeight(0)
      this.glideAction.setEffectiveWeight(1)
      this.doubleJumpAction?.setEffectiveWeight(0)
    } else {
      this.idleAction?.setEffectiveWeight(idleWeight)
      this.walkAction?.setEffectiveWeight(this.walkBlend)
      this.jogAction?.setEffectiveWeight(this.jogBlend)
      this.runAction?.setEffectiveWeight(this.runBlend)
      this.jumpAction?.setEffectiveWeight(this.jumpBlend)
      this.glideAction?.setEffectiveWeight(this.glideBlend)
      this.doubleJumpAction?.setEffectiveWeight(0)
    }

    if (this.walkAction && state.locomotionMode === 'walk' && !state.gliding) {
      const ref = Math.max(DCL_LOCOMOTION_DEFAULTS.walkSpeed, 0.001)
      this.walkAction.setEffectiveTimeScale(Math.max(0.35, state.horizontalSpeed / ref))
    }
    if (this.jogAction && state.locomotionMode === 'jog' && !state.gliding) {
      // Dedicated Explorer Jog clip — authored cadence at full jog speed.
      const ref = Math.max(DCL_LOCOMOTION_DEFAULTS.jogSpeed, 0.001)
      this.jogAction.setEffectiveTimeScale(Math.max(0.6, state.horizontalSpeed / ref))
    }
    if (this.runAction && !state.gliding) {
      if (state.locomotionMode === 'run') {
        const ref = Math.max(DCL_LOCOMOTION_DEFAULTS.runSpeed, 0.001)
        // Desktop parity: unity-explorer never scales animator speed by velocity —
        // Run.anim plays at 1× at full run speed (blend value expresses speed instead).
        this.runAction.setEffectiveTimeScale(Math.max(0.6, state.horizontalSpeed / ref))
      } else if (state.locomotionMode === 'jog' && !this.jogAction) {
        const ref = Math.max(DCL_LOCOMOTION_DEFAULTS.jogSpeed, 0.001)
        // Fallback when jog.glb is unavailable: run.glb slowed — not walk.glb sped up.
        this.runAction.setEffectiveTimeScale(Math.max(0.78, (state.horizontalSpeed / ref) * 0.88))
      }
    }
    if (this.jumpAction) {
      this.jumpAction.paused = false
      this.jumpAction.setEffectiveTimeScale(1)
    }
    if (this.glideAction && state.gliding) {
      if (!this.glideAction.isRunning()) {
        this.glideAction.reset()
        this.glideAction.play()
      }
      // Static hold — freeze at end of clip.
      const dur = this.glideAction.getClip().duration
      if (this.glideAction.time >= dur - 1e-4) {
        this.glideAction.time = dur
        this.glideAction.paused = true
      }
    } else if (this.glideAction) {
      this.glideAction.paused = false
    }

    this.locomotionVfx?.update(delta, {
      locomotionMode: state.locomotionMode,
      horizontalSpeed: state.horizontalSpeed,
      grounded: state.grounded,
      nearGround: state.nearGround
    })

    this.advancePose(delta)
  }

  dispose(): void {
    this.bindGeneration++
    this.twirl.reset()
    this.parallelWearables = []
    if (this.mixer) {
      this.mixer.removeEventListener('finished', this.onMixerFinished)
      this.mixer.stopAllAction()
    }
    this.onOneShotFinished = null
    this.stopProfileEmote({ silent: true })
    this.locomotionVfx?.dispose()
    this.locomotionVfx = null
    this.mixer = null
    this.avatarRoot = null
    this.attachParent = null
    this.idleAction = null
    this.walkAction = null
    this.jogAction = null
    this.runAction = null
    this.jumpAction = null
    this.doubleJumpAction = null
    this.glideAction = null
    this.hasDedicatedDoubleJumpClip = false
    this.activeProfileEmoteKey = null
    this.doubleJumpPlaying = false
    this.walkBlend = 0
    this.jogBlend = 0
    this.runBlend = 0
    this.jumpBlend = 0
    this.glideBlend = 0
  }

  private onMixerFinished = (event: THREE.Event & { action: THREE.AnimationAction }): void => {
    if (event.action === this.doubleJumpAction) {
      this.doubleJumpPlaying = false
      this.doubleJumpAction?.stop()
      return
    }
    this.onProfileFinished(event)
  }

  private onProfileFinished = (event: THREE.Event & { action: THREE.AnimationAction }): void => {
    if (this.profileEmoteLoop) return
    if (event.action !== this.profileAction && event.action !== this.propAction) return
    if (this.profileAction && this.propAction) {
      if (event.action === this.profileAction && this.propAction.isRunning()) return
      if (event.action === this.propAction && this.profileAction.isRunning()) return
    }
    // SDK one-shots end and release — queue may re-fire Fishing_Idle via onOneShotFinished.
    this.stopProfileEmote()
  }

  /** Stop profile/prop playback without restoring locomotion — used when swapping emotes. */
  private teardownProfileEmotePlayback(): void {
    if (this.profileAction) {
      this.profileAction.stop()
      this.mixer?.uncacheClip(this.profileAction.getClip())
    }
    this.profileAction = null
    if (this.propMixer) {
      this.propMixer.removeEventListener('finished', this.onProfileFinished)
    }
    if (this.propAction) {
      this.propAction.stop()
      this.propMixer?.uncacheClip(this.propAction.getClip())
    }
    this.propAction = null
    this.propMixer = null

    if (this.propRoot) {
      this.propRoot.removeFromParent()
      this.propRoot = null
    }
  }

  /** Clear emote state and restore locomotion weights (avoids bind-pose flash). */
  private finishProfileEmoteStop(): void {
    this.profileActive = false
    this.profileEmoteLoop = false
    this.activeProfileEmoteKey = null
    this.restoreLocomotionWeights()
  }

  private applyProfileEmoteWeights(): void {
    const hasAvatarTrack = !!this.profileAction
    const hasPropTrack = !!this.propAction
    this.idleAction?.setEffectiveWeight(hasAvatarTrack ? 0 : 1)
    this.walkAction?.setEffectiveWeight(0)
    this.jogAction?.setEffectiveWeight(0)
    this.runAction?.setEffectiveWeight(0)
    this.jumpAction?.setEffectiveWeight(0)
    this.doubleJumpAction?.setEffectiveWeight(0)
    this.glideAction?.setEffectiveWeight(0)
    this.profileAction?.setEffectiveWeight(hasAvatarTrack ? 1 : 0)
    this.propAction?.setEffectiveWeight(hasPropTrack ? 1 : 0)
  }

  private restoreLocomotionWeights(): void {
    this.idleAction?.setEffectiveWeight(1)
    this.walkAction?.setEffectiveWeight(0)
    this.jogAction?.setEffectiveWeight(0)
    this.runAction?.setEffectiveWeight(0)
    this.jumpAction?.setEffectiveWeight(0)
    this.doubleJumpAction?.setEffectiveWeight(0)
    this.glideAction?.setEffectiveWeight(0)
    this.glideBlend = 0
    this.idleAction?.play()
    this.walkAction?.play()
    this.jogAction?.play()
    this.runAction?.play()
    this.jumpAction?.play()
    this.doubleJumpAction?.play()
    this.glideAction?.play()
    this.mixer?.update(0)
  }

  private playLoop(
    clip: THREE.AnimationClip | undefined,
    avatarRoot: THREE.Object3D,
    bodyShape: BodyShape,
    weight = 1,
    options?: { keepHipBob?: boolean }
  ): THREE.AnimationAction | null {
    const remapped = getRemappedLocomotionClip(clip, avatarRoot, bodyShape, options)
    if (!remapped || !this.mixer) return null
    const action = this.mixer.clipAction(remapped)
    action.setLoop(THREE.LoopRepeat, Infinity)
    action.enabled = true
    action.setEffectiveWeight(weight)
    action.play()
    return action
  }

  private playOneShot(
    clip: THREE.AnimationClip | undefined,
    avatarRoot: THREE.Object3D,
    bodyShape: BodyShape
  ): THREE.AnimationAction | null {
    const remapped = getRemappedLocomotionClip(clip, avatarRoot, bodyShape)
    if (!remapped || !this.mixer) return null
    const action = this.mixer.clipAction(remapped)
    action.setLoop(THREE.LoopOnce, 1)
    action.clampWhenFinished = true
    action.enabled = true
    action.setEffectiveWeight(0)
    action.setEffectiveTimeScale(1.35)
    return action
  }

  /**
   * Glide_Avatar hold pose — upper-body rotations only, frozen last frame.
   * Full clip jitters: Hips.rotation sways ~180° and positions are export-scale garbage.
   */
  private playHold(
    clip: THREE.AnimationClip | undefined,
    avatarRoot: THREE.Object3D,
    bodyShape: BodyShape
  ): THREE.AnimationAction | null {
    const remapped = getRemappedLocomotionClip(clip, avatarRoot, bodyShape)
    if (!remapped || !this.mixer) return null

    const keepBone = /Shoulder|Arm|ForeArm|Hand|Spine|Neck|Head/i
    const dropBone = /Hips|UpLeg|Leg|Foot|Toe/i
    const tracks: THREE.KeyframeTrack[] = []
    for (const track of remapped.tracks) {
      if (!/\.quaternion$/.test(track.name)) continue
      if (dropBone.test(track.name) || !keepBone.test(track.name)) continue
      // Collapse to a single static key (last frame) — no interpolation sway.
      const v = track.values
      const stride = track.getValueSize()
      if (v.length < stride) continue
      const last = Array.from(v.slice(v.length - stride))
      tracks.push(new THREE.QuaternionKeyframeTrack(track.name, [0], last))
    }
    if (tracks.length === 0) return null

    const hold = new THREE.AnimationClip(`${remapped.name}_hold`, 0.01, tracks)
    const action = this.mixer.clipAction(hold)
    action.setLoop(THREE.LoopOnce, 1)
    action.clampWhenFinished = true
    action.enabled = true
    action.setEffectiveWeight(0)
    action.play()
    return action
  }
}

/**
 * Shared glide.glb load — file is ~3.2MB. Previously every AvatarAnimations.bind()
 * (local + each remote) hit GLTFLoader again → Network tab stacks of glide.glb
 * (even 304 revalidation) and multi-second avatar compose stalls.
 */
let sharedGlideClip: THREE.AnimationClip | null | undefined
let sharedGlideClipLoad: Promise<THREE.AnimationClip | null> | null = null

/** Load `Glide_Avatar` from bundled glide.glb (Explorer arms-on-handles body). */
async function loadGlideAvatarClip(): Promise<THREE.AnimationClip | null> {
  if (sharedGlideClip !== undefined) {
    // Clone so each mixer owns an independent clip instance.
    return sharedGlideClip ? sharedGlideClip.clone() : null
  }
  if (!sharedGlideClipLoad) {
    sharedGlideClipLoad = (async () => {
      try {
        const loader = new GLTFLoader()
        const gltf = await loader.loadAsync(AVATAR_EMOTE_GLIDE)
        const named = gltf.animations.find((c) => /glide[_\s-]?avatar/i.test(c.name))
        const clip = named ?? gltf.animations[0] ?? null
        sharedGlideClip = clip
        return clip
      } catch {
        sharedGlideClip = null
        return null
      } finally {
        // Keep resolved promise; only clear on hard failure path if we want retry.
      }
    })().catch(() => {
      sharedGlideClipLoad = null
      sharedGlideClip = null
      return null
    })
  }
  const clip = await sharedGlideClipLoad
  return clip ? clip.clone() : null
}
