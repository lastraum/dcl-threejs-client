import * as THREE from 'three'
import type { AvatarLocomotionState } from '../AvatarAnimations'
import { DoubleJumpTwirl } from '../doubleJumpTwirl'
import type { EmotePropAttachment } from '../emotePlayback'
import { DCL_LOCOMOTION_DEFAULTS } from '../../player/locomotion'
import { buildOdkRestCorrection } from './odkRetarget'
import { loadMmlUeClipForOdk } from './odkMmlAnimLoader'
import { ODK_MML_LOCOMOTION } from './odkMmlLocomotionPaths'
import { vrmLocomotionTimeScale } from '../vrm/vrmLocomotionSpeed'
import { logOdkBoneDiagnostics } from './odkBoneDebug'
import { updateOdkSkinnedMeshes } from './odkSkeleton'

export type ProfileEmoteProps = EmotePropAttachment & {
  attachParent: THREE.Object3D
}

/**
 * UE5 Manny locomotion from MML worlds — native bone tracks, no Mixamo retarget.
 * Double jump: same clockwise Y twirl as DCL/VRM (not MML flip clip).
 */
export class OdkLocomotionAnimations {
  private mixer: THREE.AnimationMixer | null = null
  private idleAction: THREE.AnimationAction | null = null
  private walkAction: THREE.AnimationAction | null = null
  private jogAction: THREE.AnimationAction | null = null
  private runAction: THREE.AnimationAction | null = null
  private jumpAction: THREE.AnimationAction | null = null
  private fallAction: THREE.AnimationAction | null = null
  private profileEmoteAction: THREE.AnimationAction | null = null
  private profileEmoteActive = false
  private profileEmoteLoop = false
  private propMixer: THREE.AnimationMixer | null = null
  private propRoot: THREE.Object3D | null = null
  private propAction: THREE.AnimationAction | null = null
  /** Fired when a one-shot profile emote finishes (cast → Fishing_Idle queue). */
  private onOneShotFinished: (() => void) | null = null
  private walkBlend = 0
  private jogBlend = 0
  private runBlend = 0
  private jumpBlend = 0
  private fallBlend = 0
  private doubleJumpPlaying = false
  private readonly twirl = new DoubleJumpTwirl()
  private wasGrounded = true
  private bindGeneration = 0
  private speedSmooth = 0
  private restCorrection: Map<string, THREE.Quaternion> | null = null
  private avatarRoot: THREE.Object3D | null = null

  async bind(avatarRoot: THREE.Object3D): Promise<void> {
    this.dispose()
    const generation = ++this.bindGeneration

    const [idle, jog, run, air] = await Promise.all([
      loadMmlUeClipForOdk(ODK_MML_LOCOMOTION.idle, avatarRoot, 'idle'),
      loadMmlUeClipForOdk(ODK_MML_LOCOMOTION.jog, avatarRoot, 'jog'),
      loadMmlUeClipForOdk(ODK_MML_LOCOMOTION.run, avatarRoot, 'run'),
      loadMmlUeClipForOdk(ODK_MML_LOCOMOTION.air, avatarRoot, 'air').catch(() => null)
    ])

    if (generation !== this.bindGeneration) return
    if (idle.tracks.length === 0) {
      throw new Error('[odk] locomotion bind failed — idle clip has no matching UE tracks')
    }

    this.restCorrection = buildOdkRestCorrection(idle, avatarRoot)
    this.avatarRoot = avatarRoot

    if (generation !== this.bindGeneration) return

    console.info(
      `[odk] locomotion ready — source=mml-ue5 idle=${idle.tracks.length}, jog=${jog.tracks.length}, run=${run.tracks.length} (native UE tracks)`
    )

    void logOdkBoneDiagnostics(avatarRoot, {
      idleClip: idle,
      walkClip: jog,
      mixamoIdleUrl: ODK_MML_LOCOMOTION.idle,
      retargetedTrackCount: idle.tracks.length
    })

    this.mixer = new THREE.AnimationMixer(avatarRoot)
    this.mixer.addEventListener('finished', this.onMixerFinished)

    this.idleAction = this.mixer.clipAction(idle)
    this.idleAction.setLoop(THREE.LoopRepeat, Infinity)
    this.idleAction.play()

    this.walkAction = this.mixer.clipAction(jog)
    this.walkAction.setLoop(THREE.LoopRepeat, Infinity)
    this.walkAction.play()

    this.jogAction = this.mixer.clipAction(jog)
    this.jogAction.setLoop(THREE.LoopRepeat, Infinity)
    this.jogAction.play()

    this.runAction = this.mixer.clipAction(run)
    this.runAction.setLoop(THREE.LoopRepeat, Infinity)
    this.runAction.play()

    if (air) {
      this.jumpAction = this.mixer.clipAction(air)
      this.jumpAction.setLoop(THREE.LoopRepeat, Infinity)
      this.jumpAction.play()

      this.fallAction = this.mixer.clipAction(air)
      this.fallAction.setLoop(THREE.LoopRepeat, Infinity)
      this.fallAction.play()
    }

    this.mixer.update(0)
    updateOdkSkinnedMeshes(avatarRoot)
  }

  setOnOneShotFinished(handler: (() => void) | null): void {
    this.onOneShotFinished = handler
  }

  playProfileEmote(
    clip: THREE.AnimationClip,
    loop: boolean,
    props?: ProfileEmoteProps | null
  ): boolean {
    if (!this.mixer) return false
    this.stopProfileEmote({ silent: true })
    this.profileEmoteAction = this.mixer.clipAction(clip)
    this.profileEmoteAction.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, loop ? Infinity : 1)
    this.profileEmoteAction.clampWhenFinished = !loop
    this.profileEmoteAction.reset()
    this.profileEmoteAction.setEffectiveWeight(1)
    this.profileEmoteAction.play()

    if (props?.root) {
      this.propRoot = props.root
      props.attachParent.add(props.root)
      this.propMixer = new THREE.AnimationMixer(props.root)
      this.propMixer.addEventListener('finished', this.onPropMixerFinished)
      if (props.clip) {
        this.propAction = this.propMixer.clipAction(props.clip)
        this.propAction.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, loop ? Infinity : 1)
        this.propAction.clampWhenFinished = !loop
        this.propAction.reset()
        this.propAction.setEffectiveWeight(1)
        this.propAction.play()
      }
    }

    this.profileEmoteActive = true
    this.profileEmoteLoop = loop
    return true
  }

  stopProfileEmote(opts?: { silent?: boolean }): void {
    const wasOneShot = this.profileEmoteActive && !this.profileEmoteLoop
    if (this.profileEmoteAction) {
      this.profileEmoteAction.stop()
      this.mixer?.uncacheClip(this.profileEmoteAction.getClip())
      this.profileEmoteAction = null
    }
    if (this.propMixer) {
      this.propMixer.removeEventListener('finished', this.onPropMixerFinished)
    }
    if (this.propAction) {
      this.propAction.stop()
      this.propMixer?.uncacheClip(this.propAction.getClip())
      this.propAction = null
    }
    this.propMixer = null
    if (this.propRoot) {
      this.propRoot.removeFromParent()
      this.propRoot = null
    }
    this.profileEmoteActive = false
    this.profileEmoteLoop = false
    if (wasOneShot && !opts?.silent) {
      this.onOneShotFinished?.()
    }
  }

  isProfileEmoteActive(): boolean {
    return this.profileEmoteActive
  }

  getRestCorrection(): Map<string, THREE.Quaternion> | null {
    return this.restCorrection
  }

  update(delta: number, state: AvatarLocomotionState): void {
    if (!this.mixer || !this.idleAction) return

    if (this.profileEmoteActive && this.profileEmoteAction) {
      this.twirl.reset()
      this.doubleJumpPlaying = false
      this.idleAction.setEffectiveWeight(0)
      this.walkAction?.setEffectiveWeight(0)
      this.jogAction?.setEffectiveWeight(0)
      this.runAction?.setEffectiveWeight(0)
      this.jumpAction?.setEffectiveWeight(0)
      this.fallAction?.setEffectiveWeight(0)
      this.profileEmoteAction.setEffectiveWeight(1)
      this.mixer.update(delta)
      this.propMixer?.update(delta)
      if (this.avatarRoot) updateOdkSkinnedMeshes(this.avatarRoot)
      return
    }

    if (state.doubleJumpTriggered) {
      this.doubleJumpPlaying = true
      this.twirl.start(this.avatarRoot)
      if (this.jumpAction) {
        this.jumpAction.reset()
        this.jumpAction.setEffectiveWeight(1)
        this.jumpAction.play()
      }
    }

    if (state.grounded && this.twirl.active) {
      this.twirl.reset()
      this.doubleJumpPlaying = false
    }

    const twirling = this.twirl.update(delta)
    if (!twirling && this.doubleJumpPlaying) this.doubleJumpPlaying = false

    if (this.doubleJumpPlaying || twirling) {
      this.idleAction.setEffectiveWeight(0)
      this.walkAction?.setEffectiveWeight(0)
      this.jogAction?.setEffectiveWeight(0)
      this.runAction?.setEffectiveWeight(0)
      this.fallAction?.setEffectiveWeight(0)
      this.jumpAction?.setEffectiveWeight(1)
      this.mixer.update(delta)
      if (this.avatarRoot) updateOdkSkinnedMeshes(this.avatarRoot)
      return
    }

    const vy = state.verticalVelocity ?? 0
    const locomotionGrounded =
      state.grounded ||
      state.nearGround === true ||
      (state.horizontalSpeed > 0.12 &&
        !state.jumping &&
        !state.doubleJumping &&
        !state.falling &&
        !state.gliding &&
        vy > -3)

    const targetSpeed = state.targetLocomotionSpeed ?? 0
    const rawSpeed = state.horizontalSpeed
    const speedGoal =
      rawSpeed > 0.08 && targetSpeed > 0
        ? Math.min(targetSpeed, Math.max(rawSpeed, targetSpeed * 0.72))
        : rawSpeed
    // Faster decay when stopping so walk does not linger after remote halt.
    const speedK = 1 - Math.exp(-(speedGoal < this.speedSmooth - 0.01 ? 22 : 9) * delta)
    this.speedSmooth += (speedGoal - this.speedSmooth) * speedK
    if (speedGoal < 0.05 && this.speedSmooth < 0.04) this.speedSmooth = 0
    const animSpeed = this.speedSmooth

    let targetWalk = 0
    let targetJog = 0
    let targetRun = 0
    let targetJump = 0
    let targetFall = 0

    if (!locomotionGrounded) {
      if (state.gliding) {
        targetFall = 1
      } else if (state.jumping || state.doubleJumping) {
        targetJump = 1
      } else if (state.falling || vy < -1.5) {
        targetFall = 1
      }
    } else if (animSpeed > 0.05) {
      if (state.locomotionMode === 'walk') {
        targetWalk = Math.min(1, animSpeed / DCL_LOCOMOTION_DEFAULTS.walkSpeed)
      } else if (state.locomotionMode === 'run') {
        targetRun = Math.min(1, animSpeed / DCL_LOCOMOTION_DEFAULTS.runSpeed)
      } else {
        targetJog = Math.min(1, animSpeed / DCL_LOCOMOTION_DEFAULTS.jogSpeed)
      }
    }

    // Asymmetric: stop walk/jog/run faster than start (remote idle lag).
    const kIn = 1 - Math.exp(-14 * delta)
    const kOut = 1 - Math.exp(-32 * delta)
    const blendToward = (cur: number, target: number): number =>
      cur + (target - cur) * (target < cur - 1e-4 ? kOut : kIn)
    this.walkBlend = blendToward(this.walkBlend, targetWalk)
    this.jogBlend = blendToward(this.jogBlend, targetJog)
    this.runBlend = blendToward(this.runBlend, targetRun)
    this.jumpBlend = blendToward(this.jumpBlend, targetJump)
    this.fallBlend = blendToward(this.fallBlend, targetFall)
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

    if (this.wasGrounded && !locomotionGrounded && vy > 0.2 && this.jumpAction) {
      this.jumpAction.reset()
      this.jumpAction.play()
    }
    this.wasGrounded = locomotionGrounded

    const airDominant = Math.max(this.jumpBlend, this.fallBlend)
    const locoW = 1 - airDominant
    const locomotion = Math.max(this.walkBlend, this.jogBlend, this.runBlend)
    const idleWeight = Math.max(0, 1 - locomotion) * locoW

    this.idleAction.setEffectiveWeight(idleWeight)
    this.walkAction?.setEffectiveWeight(this.walkBlend * locoW)
    this.jogAction?.setEffectiveWeight(this.jogBlend * locoW)
    this.runAction?.setEffectiveWeight(this.runBlend * locoW)

    if (this.walkAction && state.locomotionMode === 'walk') {
      this.walkAction.setEffectiveTimeScale(vrmLocomotionTimeScale('walk', animSpeed))
    }
    if (this.jogAction && state.locomotionMode === 'jog') {
      this.jogAction.setEffectiveTimeScale(vrmLocomotionTimeScale('jog', animSpeed))
    }
    if (this.runAction && state.locomotionMode === 'run') {
      this.runAction.setEffectiveTimeScale(vrmLocomotionTimeScale('run', animSpeed))
    }

    this.jumpAction?.setEffectiveWeight(this.jumpBlend)
    this.fallAction?.setEffectiveWeight(this.fallBlend)

    this.mixer.update(delta)
    if (this.avatarRoot) updateOdkSkinnedMeshes(this.avatarRoot)
  }

  dispose(): void {
    this.bindGeneration++
    this.twirl.reset()
    this.onOneShotFinished = null
    this.stopProfileEmote({ silent: true })
    if (this.mixer) {
      this.mixer.removeEventListener('finished', this.onMixerFinished)
      this.mixer.stopAllAction()
    }
    this.mixer = null
    this.idleAction = null
    this.walkAction = null
    this.jogAction = null
    this.runAction = null
    this.jumpAction = null
    this.fallAction = null
    this.walkBlend = 0
    this.jogBlend = 0
    this.runBlend = 0
    this.jumpBlend = 0
    this.fallBlend = 0
    this.doubleJumpPlaying = false
    this.speedSmooth = 0
    this.restCorrection = null
    this.avatarRoot = null
  }

  private onMixerFinished = (event: THREE.Event & { action: THREE.AnimationAction }): void => {
    if (event.action === this.profileEmoteAction && !this.profileEmoteLoop) {
      // SDK one-shots end and release — queue may re-fire Fishing_Idle via onOneShotFinished.
      if (this.propAction?.isRunning()) return
      this.stopProfileEmote()
    }
  }

  private onPropMixerFinished = (event: THREE.Event & { action: THREE.AnimationAction }): void => {
    if (event.action === this.propAction && !this.profileEmoteLoop) {
      if (this.profileEmoteAction?.isRunning()) return
      this.stopProfileEmote()
    }
  }
}