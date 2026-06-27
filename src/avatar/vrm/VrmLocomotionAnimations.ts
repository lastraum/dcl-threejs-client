import * as THREE from 'three'
import type { VRM } from '@pixiv/three-vrm'
import type { AvatarLocomotionState } from '../AvatarAnimations'
import { DCL_LOCOMOTION_DEFAULTS } from '../../player/locomotion'
import { loadRetargetedClip } from './mixamoRetarget'
import { VRM_LOCOMOTION } from './vrmLocomotionPaths'
import { vrmLocomotionTimeScale } from './vrmLocomotionSpeed'

/**
 * Mixamo forward locomotion only — avatar yaw follows travel direction (PlayerSystem),
 * same pattern as DCL walk.glb / run.glb on composed avatars.
 */
export class VrmLocomotionAnimations {
  private mixer: THREE.AnimationMixer | null = null
  private idleAction: THREE.AnimationAction | null = null
  private walkAction: THREE.AnimationAction | null = null
  private jogAction: THREE.AnimationAction | null = null
  private jumpAction: THREE.AnimationAction | null = null
  private fallAction: THREE.AnimationAction | null = null
  private flipAction: THREE.AnimationAction | null = null
  private profileEmoteAction: THREE.AnimationAction | null = null
  private profileEmoteActive = false
  private profileEmoteLoop = false
  private walkBlend = 0
  private jogBlend = 0
  private jumpBlend = 0
  private fallBlend = 0
  private flipPlaying = false
  private wasGrounded = true
  private bindGeneration = 0
  private speedSmooth = 0

  async bind(vrm: VRM, animRoot: THREE.Object3D): Promise<void> {
    this.dispose()
    const generation = ++this.bindGeneration

    const [idle, walk, jog, jump, fall, flip] = await Promise.all([
      loadRetargetedClip(VRM_LOCOMOTION.idle, vrm),
      loadRetargetedClip(VRM_LOCOMOTION.walkFwd, vrm),
      loadRetargetedClip(VRM_LOCOMOTION.jogFwd, vrm),
      loadRetargetedClip(VRM_LOCOMOTION.jump, vrm).catch(() => null),
      loadRetargetedClip(VRM_LOCOMOTION.fall, vrm).catch(() => null),
      loadRetargetedClip(VRM_LOCOMOTION.flip, vrm).catch(() => null)
    ])

    if (generation !== this.bindGeneration) return

    if (idle.tracks.length === 0) {
      throw new Error('[vrm] locomotion bind failed — idle clip has no retargeted tracks')
    }

    console.info(
      `[vrm] locomotion clips ready — idle=${idle.tracks.length} tracks, walk=${walk.tracks.length}, jog=${jog.tracks.length}`
    )

    this.mixer = new THREE.AnimationMixer(animRoot)
    this.mixer.addEventListener('finished', this.onMixerFinished)

    this.idleAction = this.mixer.clipAction(idle)
    this.idleAction.setLoop(THREE.LoopRepeat, Infinity)
    this.idleAction.play()

    this.walkAction = this.mixer.clipAction(walk)
    this.walkAction.setLoop(THREE.LoopRepeat, Infinity)
    this.walkAction.play()

    this.jogAction = this.mixer.clipAction(jog)
    this.jogAction.setLoop(THREE.LoopRepeat, Infinity)
    this.jogAction.play()

    if (jump) {
      this.jumpAction = this.mixer.clipAction(jump)
      this.jumpAction.setLoop(THREE.LoopRepeat, Infinity)
      this.jumpAction.play()
    }
    if (fall) {
      this.fallAction = this.mixer.clipAction(fall)
      this.fallAction.setLoop(THREE.LoopRepeat, Infinity)
      this.fallAction.play()
    }
    if (flip) {
      this.flipAction = this.mixer.clipAction(flip)
      this.flipAction.setLoop(THREE.LoopOnce, 1)
      this.flipAction.clampWhenFinished = true
      this.flipAction.play()
    }

    this.mixer.update(0)
  }

  playProfileEmote(clip: THREE.AnimationClip, loop: boolean): boolean {
    if (!this.mixer) return false
    this.stopProfileEmote()
    this.profileEmoteAction = this.mixer.clipAction(clip)
    this.profileEmoteAction.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, loop ? Infinity : 1)
    this.profileEmoteAction.clampWhenFinished = !loop
    this.profileEmoteAction.reset()
    this.profileEmoteAction.setEffectiveWeight(1)
    this.profileEmoteAction.play()
    this.profileEmoteActive = true
    this.profileEmoteLoop = loop
    return true
  }

  stopProfileEmote(): void {
    if (this.profileEmoteAction) {
      this.profileEmoteAction.stop()
      this.mixer?.uncacheClip(this.profileEmoteAction.getClip())
      this.profileEmoteAction = null
    }
    this.profileEmoteActive = false
    this.profileEmoteLoop = false
  }

  isProfileEmoteActive(): boolean {
    return this.profileEmoteActive
  }

  update(delta: number, state: AvatarLocomotionState): void {
    if (!this.mixer || !this.idleAction) return

    if (this.profileEmoteActive && this.profileEmoteAction) {
      this.idleAction.setEffectiveWeight(0)
      this.walkAction?.setEffectiveWeight(0)
      this.jogAction?.setEffectiveWeight(0)
      this.jumpAction?.setEffectiveWeight(0)
      this.fallAction?.setEffectiveWeight(0)
      this.flipAction?.setEffectiveWeight(0)
      this.profileEmoteAction.setEffectiveWeight(1)
      this.mixer.update(delta)
      return
    }

    if (state.doubleJumpTriggered && this.flipAction) {
      this.flipPlaying = true
      this.flipAction.reset()
      this.flipAction.setEffectiveWeight(1)
      this.flipAction.play()
    }

    if (this.flipPlaying) {
      this.idleAction.setEffectiveWeight(0)
      this.walkAction?.setEffectiveWeight(0)
      this.jogAction?.setEffectiveWeight(0)
      this.jumpAction?.setEffectiveWeight(0)
      this.fallAction?.setEffectiveWeight(0)
      this.flipAction?.setEffectiveWeight(1)
      this.mixer.update(delta)
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
        vy > -3)

    const targetSpeed = state.targetLocomotionSpeed ?? 0
    const rawSpeed = state.horizontalSpeed
    const speedGoal =
      rawSpeed > 0.08 && targetSpeed > 0
        ? Math.min(targetSpeed, Math.max(rawSpeed, targetSpeed * 0.72))
        : rawSpeed
    const speedK = 1 - Math.exp(-9 * delta)
    this.speedSmooth += (speedGoal - this.speedSmooth) * speedK
    const animSpeed = this.speedSmooth

    let targetWalk = 0
    let targetJog = 0
    let targetJump = 0
    let targetFall = 0

    if (!locomotionGrounded) {
      if (state.jumping || state.doubleJumping) {
        targetJump = 1
      } else if (state.falling || vy < -1.5) {
        targetFall = 1
      }
    } else if (animSpeed > 0.05) {
      if (state.locomotionMode === 'walk') {
        targetWalk = Math.min(1, animSpeed / DCL_LOCOMOTION_DEFAULTS.walkSpeed)
      } else {
        const ref =
          state.locomotionMode === 'run'
            ? DCL_LOCOMOTION_DEFAULTS.runSpeed
            : DCL_LOCOMOTION_DEFAULTS.jogSpeed
        targetJog = Math.min(1, animSpeed / ref)
      }
    }

    const k = 1 - Math.exp(-14 * delta)
    this.walkBlend += (targetWalk - this.walkBlend) * k
    this.jogBlend += (targetJog - this.jogBlend) * k
    this.jumpBlend += (targetJump - this.jumpBlend) * k
    this.fallBlend += (targetFall - this.fallBlend) * k

    if (this.wasGrounded && !locomotionGrounded && vy > 0.2 && this.jumpAction) {
      this.jumpAction.reset()
      this.jumpAction.play()
    }
    this.wasGrounded = locomotionGrounded

    const airDominant = Math.max(this.jumpBlend, this.fallBlend)
    const locoW = 1 - airDominant
    const locomotion = Math.max(this.walkBlend, this.jogBlend)
    const idleWeight = Math.max(0, 1 - locomotion) * locoW

    this.idleAction.setEffectiveWeight(idleWeight)
    this.walkAction?.setEffectiveWeight(this.walkBlend * locoW)
    this.jogAction?.setEffectiveWeight(this.jogBlend * locoW)

    if (this.walkAction && state.locomotionMode === 'walk') {
      this.walkAction.setEffectiveTimeScale(vrmLocomotionTimeScale('walk', animSpeed))
    }
    if (this.jogAction) {
      if (state.locomotionMode === 'jog' || state.locomotionMode === 'run') {
        this.jogAction.setEffectiveTimeScale(vrmLocomotionTimeScale(state.locomotionMode, animSpeed))
      } else {
        this.jogAction.setEffectiveTimeScale(1)
      }
    }

    this.jumpAction?.setEffectiveWeight(this.jumpBlend)
    this.fallAction?.setEffectiveWeight(this.fallBlend)
    this.flipAction?.setEffectiveWeight(0)

    this.mixer.update(delta)
  }

  dispose(): void {
    this.bindGeneration++
    this.stopProfileEmote()
    if (this.mixer) {
      this.mixer.removeEventListener('finished', this.onMixerFinished)
      this.mixer.stopAllAction()
    }
    this.mixer = null
    this.idleAction = null
    this.walkAction = null
    this.jogAction = null
    this.jumpAction = null
    this.fallAction = null
    this.flipAction = null
    this.walkBlend = 0
    this.jogBlend = 0
    this.jumpBlend = 0
    this.fallBlend = 0
    this.flipPlaying = false
    this.speedSmooth = 0
  }

  private onMixerFinished = (event: THREE.Event & { action: THREE.AnimationAction }): void => {
    if (event.action === this.flipAction) {
      this.flipPlaying = false
      this.flipAction?.stop()
    }
    if (event.action === this.profileEmoteAction && !this.profileEmoteLoop) {
      this.stopProfileEmote()
    }
  }
}