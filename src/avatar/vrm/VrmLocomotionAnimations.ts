import * as THREE from 'three'
import type { VRM } from '@pixiv/three-vrm'
import type { AvatarLocomotionState } from '../AvatarAnimations'
import { DCL_LOCOMOTION_DEFAULTS } from '../../player/locomotion'
import { loadRetargetedClip } from './mixamoRetarget'
import { VRM_LOCOMOTION } from './vrmLocomotionPaths'

type DirWeights = { f: number; l: number; r: number; b: number }

type ClipQuad = {
  f: THREE.AnimationClip
  l: THREE.AnimationClip
  r: THREE.AnimationClip
  b: THREE.AnimationClip
}

/** Hyperfy / genesis-games octant blend from planar move axis. */
function directionBlendWeights(angleDeg: number): DirWeights {
  const o: DirWeights = { f: 0, l: 0, r: 0, b: 0 }
  if (angleDeg >= 337.5 || angleDeg < 22.5) o.f = 1
  else if (angleDeg < 67.5) {
    const blend = (angleDeg - 22.5) / 45
    o.f = 1 - blend
    o.r = blend
  } else if (angleDeg < 112.5) o.r = 1
  else if (angleDeg < 157.5) {
    const blend = (angleDeg - 112.5) / 45
    o.r = 1 - blend
    o.b = blend
  } else if (angleDeg < 202.5) o.b = 1
  else if (angleDeg < 247.5) {
    const blend = (angleDeg - 202.5) / 45
    o.b = 1 - blend
    o.l = blend
  } else if (angleDeg < 292.5) o.l = 1
  else {
    const blend = (angleDeg - 292.5) / 45
    o.l = 1 - blend
    o.f = blend
  }
  return o
}

/**
 * Mixamo locomotion clips retargeted per VRM skeleton (genesis-games pattern).
 * Mixer root is the full VRM scene so all humanoid bones receive tracks.
 */
export class VrmLocomotionAnimations {
  private mixer: THREE.AnimationMixer | null = null
  private idleAction: THREE.AnimationAction | null = null
  private walkActions: THREE.AnimationAction[] = []
  private jogActions: THREE.AnimationAction[] = []
  private jumpAction: THREE.AnimationAction | null = null
  private fallAction: THREE.AnimationAction | null = null
  private flipAction: THREE.AnimationAction | null = null
  private directionalOk = false
  private walkBlend = 0
  private jogBlend = 0
  private jumpBlend = 0
  private fallBlend = 0
  private flipPlaying = false
  private wasGrounded = true
  private wf = 0
  private wl = 0
  private wr = 0
  private wb = 0
  private bindGeneration = 0

  async bind(vrm: VRM, animRoot: THREE.Object3D): Promise<void> {
    this.dispose()
    const generation = ++this.bindGeneration

    const [idle, walkSettled, jogSettled, jump, fall, flip] = await Promise.all([
      loadRetargetedClip(VRM_LOCOMOTION.idle, vrm),
      Promise.allSettled([
        loadRetargetedClip(VRM_LOCOMOTION.walkFwd, vrm),
        loadRetargetedClip(VRM_LOCOMOTION.walkLeft, vrm),
        loadRetargetedClip(VRM_LOCOMOTION.walkRight, vrm),
        loadRetargetedClip(VRM_LOCOMOTION.walkBack, vrm)
      ]),
      Promise.allSettled([
        loadRetargetedClip(VRM_LOCOMOTION.jogFwd, vrm),
        loadRetargetedClip(VRM_LOCOMOTION.jogLeft, vrm),
        loadRetargetedClip(VRM_LOCOMOTION.jogRight, vrm),
        loadRetargetedClip(VRM_LOCOMOTION.jogBack, vrm)
      ]),
      loadRetargetedClip(VRM_LOCOMOTION.jump, vrm).catch(() => null),
      loadRetargetedClip(VRM_LOCOMOTION.fall, vrm).catch(() => null),
      loadRetargetedClip(VRM_LOCOMOTION.flip, vrm).catch(() => null)
    ])

    if (generation !== this.bindGeneration) return

    let walkClips: ClipQuad | null = null
    let jogClips: ClipQuad | null = null
    if (walkSettled.every((s) => s.status === 'fulfilled') && jogSettled.every((s) => s.status === 'fulfilled')) {
      const w = walkSettled.map((s) => (s as PromiseFulfilledResult<THREE.AnimationClip>).value)
      const j = jogSettled.map((s) => (s as PromiseFulfilledResult<THREE.AnimationClip>).value)
      walkClips = { f: w[0], l: w[1], r: w[2], b: w[3] }
      jogClips = { f: j[0], l: j[1], r: j[2], b: j[3] }
      this.directionalOk = true
    } else {
      console.warn('[vrm] directional locomotion GLBs incomplete — forward walk/jog only')
      const wf = walkSettled[0]
      const jf = jogSettled[0]
      if (wf.status === 'fulfilled') walkClips = { f: wf.value, l: wf.value, r: wf.value, b: wf.value }
      if (jf.status === 'fulfilled') jogClips = { f: jf.value, l: jf.value, r: jf.value, b: jf.value }
      this.directionalOk = false
    }

    if (!walkClips || !jogClips) {
      throw new Error('[vrm] locomotion bind failed — walk/jog clips unavailable')
    }

    this.mixer = new THREE.AnimationMixer(animRoot)
    this.mixer.addEventListener('finished', this.onMixerFinished)

    this.idleAction = this.mixer.clipAction(idle)
    this.idleAction.setLoop(THREE.LoopRepeat, Infinity)
    this.idleAction.play()

    for (const key of ['f', 'l', 'r', 'b'] as const) {
      const wa = this.mixer.clipAction(walkClips[key])
      wa.setLoop(THREE.LoopRepeat, Infinity)
      wa.play()
      this.walkActions.push(wa)

      const ja = this.mixer.clipAction(jogClips[key])
      ja.setLoop(THREE.LoopRepeat, Infinity)
      ja.play()
      this.jogActions.push(ja)
    }

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

  update(delta: number, state: AvatarLocomotionState): void {
    if (!this.mixer || !this.idleAction) return

    if (state.doubleJumpTriggered && this.flipAction) {
      this.flipPlaying = true
      this.flipAction.reset()
      this.flipAction.setEffectiveWeight(1)
      this.flipAction.play()
    }

    if (this.flipPlaying) {
      this.applyLocomotionWeights(0, 0, 0, 0, 0, 1)
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
    } else if (state.horizontalSpeed > 0.05) {
      if (state.locomotionMode === 'walk') {
        targetWalk = Math.min(1, state.horizontalSpeed / DCL_LOCOMOTION_DEFAULTS.walkSpeed)
      } else {
        const ref =
          state.locomotionMode === 'run'
            ? DCL_LOCOMOTION_DEFAULTS.runSpeed
            : DCL_LOCOMOTION_DEFAULTS.jogSpeed
        targetJog = Math.min(1, state.horizontalSpeed / ref)
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

    let dir: DirWeights = { f: 1, l: 0, r: 0, b: 0 }
    const axisX = state.moveAxisX ?? 0
    const axisZ = state.moveAxisZ ?? 0
    if (this.directionalOk && locomotionGrounded && Math.hypot(axisX, axisZ) > 0.02) {
      let angleDeg = (Math.atan2(axisX, -axisZ) * 180) / Math.PI
      if (angleDeg < 0) angleDeg += 360
      dir = directionBlendWeights(angleDeg)
    }

    const kd = 1 - Math.exp(-16 * delta)
    this.wf += (dir.f - this.wf) * kd
    this.wl += (dir.l - this.wl) * kd
    this.wr += (dir.r - this.wr) * kd
    this.wb += (dir.b - this.wb) * kd

    const walkDirs = [this.wf, this.wl, this.wr, this.wb]
    const jogDirs = walkDirs

    this.idleAction.setEffectiveWeight(idleWeight)

    for (let i = 0; i < 4; i++) {
      const wWalk = walkDirs[i] * this.walkBlend * locoW
      const wJog = jogDirs[i] * this.jogBlend * locoW
      this.walkActions[i]?.setEffectiveWeight(wWalk)
      this.jogActions[i]?.setEffectiveWeight(wJog)

      if (this.walkActions[i] && state.locomotionMode === 'walk') {
        const ref = Math.max(DCL_LOCOMOTION_DEFAULTS.walkSpeed, 0.001)
        this.walkActions[i].setEffectiveTimeScale(Math.max(0.35, state.horizontalSpeed / ref))
      }
      if (this.jogActions[i]) {
        if (state.locomotionMode === 'run') {
          const ref = Math.max(DCL_LOCOMOTION_DEFAULTS.runSpeed, 0.001)
          this.jogActions[i].setEffectiveTimeScale(Math.max(1.05, (state.horizontalSpeed / ref) * 1.1))
        } else if (state.locomotionMode === 'jog') {
          const ref = Math.max(DCL_LOCOMOTION_DEFAULTS.jogSpeed, 0.001)
          this.jogActions[i].setEffectiveTimeScale(Math.max(0.78, (state.horizontalSpeed / ref) * 0.88))
        } else {
          this.jogActions[i].setEffectiveTimeScale(1)
        }
      }
    }

    this.jumpAction?.setEffectiveWeight(this.jumpBlend)
    this.fallAction?.setEffectiveWeight(this.fallBlend)
    this.flipAction?.setEffectiveWeight(0)

    this.mixer.update(delta)
  }

  dispose(): void {
    this.bindGeneration++
    if (this.mixer) {
      this.mixer.removeEventListener('finished', this.onMixerFinished)
      this.mixer.stopAllAction()
    }
    this.mixer = null
    this.idleAction = null
    this.walkActions = []
    this.jogActions = []
    this.jumpAction = null
    this.fallAction = null
    this.flipAction = null
    this.walkBlend = 0
    this.jogBlend = 0
    this.jumpBlend = 0
    this.fallBlend = 0
    this.flipPlaying = false
  }

  private applyLocomotionWeights(
    idle: number,
    walk: number,
    jog: number,
    jump: number,
    fall: number,
    flip: number
  ): void {
    this.idleAction?.setEffectiveWeight(idle)
    for (const a of this.walkActions) a.setEffectiveWeight(walk)
    for (const a of this.jogActions) a.setEffectiveWeight(jog)
    this.jumpAction?.setEffectiveWeight(jump)
    this.fallAction?.setEffectiveWeight(fall)
    this.flipAction?.setEffectiveWeight(flip)
  }

  private onMixerFinished = (event: THREE.Event & { action: THREE.AnimationAction }): void => {
    if (event.action === this.flipAction) {
      this.flipPlaying = false
      this.flipAction?.stop()
    }
  }
}