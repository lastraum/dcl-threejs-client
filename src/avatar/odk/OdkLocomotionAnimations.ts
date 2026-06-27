import * as THREE from 'three'
import type { AvatarLocomotionState } from '../AvatarAnimations'
import { DCL_LOCOMOTION_DEFAULTS } from '../../player/locomotion'
import { buildOdkRestCorrection } from './odkRetarget'
import { loadMmlUeClipForOdk } from './odkMmlAnimLoader'
import { ODK_MML_LOCOMOTION } from './odkMmlLocomotionPaths'
import { vrmLocomotionTimeScale } from '../vrm/vrmLocomotionSpeed'
import { logOdkBoneDiagnostics } from './odkBoneDebug'
import { updateOdkSkinnedMeshes } from './odkSkeleton'

/**
 * UE5 Manny locomotion from MML worlds — native bone tracks, no Mixamo retarget.
 */
export class OdkLocomotionAnimations {
  private mixer: THREE.AnimationMixer | null = null
  private idleAction: THREE.AnimationAction | null = null
  private walkAction: THREE.AnimationAction | null = null
  private jogAction: THREE.AnimationAction | null = null
  private runAction: THREE.AnimationAction | null = null
  private jumpAction: THREE.AnimationAction | null = null
  private fallAction: THREE.AnimationAction | null = null
  private flipAction: THREE.AnimationAction | null = null
  private profileEmoteAction: THREE.AnimationAction | null = null
  private profileEmoteActive = false
  private profileEmoteLoop = false
  private walkBlend = 0
  private jogBlend = 0
  private runBlend = 0
  private jumpBlend = 0
  private fallBlend = 0
  private flipPlaying = false
  private wasGrounded = true
  private bindGeneration = 0
  private speedSmooth = 0
  private restCorrection: Map<string, THREE.Quaternion> | null = null
  private avatarRoot: THREE.Object3D | null = null

  async bind(avatarRoot: THREE.Object3D): Promise<void> {
    this.dispose()
    const generation = ++this.bindGeneration

    const [idle, jog, run, air, flip] = await Promise.all([
      loadMmlUeClipForOdk(ODK_MML_LOCOMOTION.idle, avatarRoot, 'idle'),
      loadMmlUeClipForOdk(ODK_MML_LOCOMOTION.jog, avatarRoot, 'jog'),
      loadMmlUeClipForOdk(ODK_MML_LOCOMOTION.run, avatarRoot, 'run'),
      loadMmlUeClipForOdk(ODK_MML_LOCOMOTION.air, avatarRoot, 'air').catch(() => null),
      loadMmlUeClipForOdk(ODK_MML_LOCOMOTION.doubleJump, avatarRoot, 'flip').catch(() => null)
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
    if (flip) {
      this.flipAction = this.mixer.clipAction(flip)
      this.flipAction.setLoop(THREE.LoopOnce, 1)
      this.flipAction.clampWhenFinished = true
      this.flipAction.play()
    }

    this.mixer.update(0)
    updateOdkSkinnedMeshes(avatarRoot)
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

  getRestCorrection(): Map<string, THREE.Quaternion> | null {
    return this.restCorrection
  }

  update(delta: number, state: AvatarLocomotionState): void {
    if (!this.mixer || !this.idleAction) return

    if (this.profileEmoteActive && this.profileEmoteAction) {
      this.idleAction.setEffectiveWeight(0)
      this.walkAction?.setEffectiveWeight(0)
      this.jogAction?.setEffectiveWeight(0)
      this.runAction?.setEffectiveWeight(0)
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
      this.runAction?.setEffectiveWeight(0)
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
    let targetRun = 0
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
      } else if (state.locomotionMode === 'run') {
        targetRun = Math.min(1, animSpeed / DCL_LOCOMOTION_DEFAULTS.runSpeed)
      } else {
        targetJog = Math.min(1, animSpeed / DCL_LOCOMOTION_DEFAULTS.jogSpeed)
      }
    }

    const k = 1 - Math.exp(-14 * delta)
    this.walkBlend += (targetWalk - this.walkBlend) * k
    this.jogBlend += (targetJog - this.jogBlend) * k
    this.runBlend += (targetRun - this.runBlend) * k
    this.jumpBlend += (targetJump - this.jumpBlend) * k
    this.fallBlend += (targetFall - this.fallBlend) * k

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
    this.flipAction?.setEffectiveWeight(0)

    this.mixer.update(delta)
    if (this.avatarRoot) updateOdkSkinnedMeshes(this.avatarRoot)
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
    this.runAction = null
    this.jumpAction = null
    this.fallAction = null
    this.flipAction = null
    this.walkBlend = 0
    this.jogBlend = 0
    this.runBlend = 0
    this.jumpBlend = 0
    this.fallBlend = 0
    this.flipPlaying = false
    this.speedSmooth = 0
    this.restCorrection = null
    this.avatarRoot = null
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