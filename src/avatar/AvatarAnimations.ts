import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import {
  AVATAR_EMOTE_DOUBLE_JUMP,
  AVATAR_EMOTE_IDLE,
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
import { getRemappedLocomotionClip } from './locomotionClipCache'
import type { AssetCache, CachedGltf } from '../rendering/AssetCache'
import { stabilizeSkinnedMeshes } from '../rendering/skinnedMeshInstance'
import type { LocomotionMode } from '../player/locomotion'
import { DCL_LOCOMOTION_DEFAULTS } from '../player/locomotion'
import { loadLocomotionEmoteGltf, type LocomotionEmoteSlug } from './profileEmotes'
import type { BodyShape } from './types'

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
  /** One frame — air-jump impulse applied (twirl + spin puff). */
  doubleJumpTriggered?: boolean
  falling: boolean
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
  private runAction: THREE.AnimationAction | null = null
  private jumpAction: THREE.AnimationAction | null = null
  private doubleJumpAction: THREE.AnimationAction | null = null
  private profileAction: THREE.AnimationAction | null = null
  private propAction: THREE.AnimationAction | null = null
  private profileActive = false
  private profileEmoteLoop = false
  private activeProfileEmoteKey: string | null = null
  private doubleJumpPlaying = false
  private walkBlend = 0
  private runBlend = 0
  private jumpBlend = 0

  setVfxScene(scene: THREE.Scene | null): void {
    this.vfxScene = scene
    if (scene && this.avatarRoot && !this.locomotionVfx) {
      this.locomotionVfx = new AvatarLocomotionVfx()
      this.locomotionVfx.bind(this.avatarRoot, scene)
    }
  }

  async bind(
    avatarRoot: THREE.Object3D,
    attachParent?: THREE.Object3D,
    options?: { bodyShape?: BodyShape; peerUrl?: string; assetCache?: AssetCache | null }
  ): Promise<void> {
    this.dispose()
    this.avatarRoot = avatarRoot
    this.attachParent = attachParent ?? avatarRoot.parent ?? avatarRoot
    this.mixer = new THREE.AnimationMixer(avatarRoot)
    this.mixer.addEventListener('finished', this.onMixerFinished)

    if (this.vfxScene) {
      this.locomotionVfx = new AvatarLocomotionVfx()
      this.locomotionVfx.bind(avatarRoot, this.vfxScene)
    }

    const bodyShape = options?.bodyShape ?? 'male'
    const cache = options?.assetCache
    const peerUrl = options?.peerUrl

    const loadSlug = async (slug: LocomotionEmoteSlug): Promise<THREE.AnimationClip | null> => {
      if (cache && peerUrl) {
        const gltf = await loadLocomotionEmoteGltf(slug, bodyShape, peerUrl, cache)
        if (gltf?.animations[0]) return gltf.animations[0]
        if (slug === 'double_jump') {
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
        if (slug === 'double_jump') {
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

    const [idleClip, walkClip, runClip, jumpClip, doubleJumpClip] = await Promise.all([
      loadSlug('idle'),
      loadSlug('walk'),
      loadSlug('run'),
      loadSlug('jump'),
      loadSlug('double_jump')
    ])

    if (!idleClip) {
      throw new Error('locomotion idle emote unavailable')
    }

    this.idleAction = this.playLoop(idleClip, avatarRoot, bodyShape, 1)
    this.walkAction = this.playLoop(walkClip ?? undefined, avatarRoot, bodyShape, 0)
    this.runAction = this.playLoop(runClip ?? undefined, avatarRoot, bodyShape, 0)
    this.jumpAction = this.playLoop(jumpClip ?? undefined, avatarRoot, bodyShape, 0)
    this.doubleJumpAction = this.playOneShot(doubleJumpClip ?? jumpClip ?? undefined, avatarRoot, bodyShape)

    if (!this.walkAction || !this.runAction || !this.jumpAction) {
      console.warn('[avatar] locomotion bind:', {
        walk: !!this.walkAction,
        run: !!this.runAction,
        jump: !!this.jumpAction,
        doubleJump: !!this.doubleJumpAction,
        idle: !!this.idleAction
      })
    }

    this.mixer.update(0)
  }

  triggerDoubleJump(): void {
    if (!this.doubleJumpAction || this.profileActive) return
    this.doubleJumpPlaying = true
    this.doubleJumpAction.reset()
    this.doubleJumpAction.setEffectiveWeight(1)
    this.doubleJumpAction.play()
    this.locomotionVfx?.triggerAirJumpPuff()
  }

  /** Profile emote from full GLB — avatar retarget + prop meshes (wearable-preview parity). */
  playProfileEmoteFromGltf(gltf: CachedGltf, loop = false, emoteKey?: string): boolean {
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
      console.warn(`[avatar] emote has no playable avatar or prop tracks (${gltf.animations.map((a) => a.name).join(', ')})`)
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
      const remapped = remapClipToAvatar(avatarClip, this.avatarRoot)
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
    this.mixer.update(0)
    this.propMixer?.update(0)
    return true
  }

  /** One-shot or loop profile emote — locomotion clips only (no prop scene). */
  playProfileEmote(clip: THREE.AnimationClip, loop = false, emoteKey?: string): boolean {
    if (!this.mixer || !this.avatarRoot) return false

    const key = emoteKey ?? clip.name
    if (this.profileActive && this.activeProfileEmoteKey === key && this.profileEmoteLoop === loop) {
      return true
    }

    this.teardownProfileEmotePlayback()
    const remapped = remapClipToAvatar(clip, this.avatarRoot)
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
    this.mixer.update(0)
    return true
  }

  stopProfileEmote(): void {
    this.teardownProfileEmotePlayback()
    this.finishProfileEmoteStop()
  }

  isProfileEmoteActive(): boolean {
    return this.profileActive
  }

  update(delta: number, state: AvatarLocomotionState): void {
    if (!this.mixer) return

    if (state.doubleJumpTriggered) {
      this.triggerDoubleJump()
    }

    if (this.profileActive) {
      this.applyProfileEmoteWeights()
      this.mixer.update(delta)
      this.propMixer?.update(delta)
      return
    }

    if (this.doubleJumpPlaying) {
      this.idleAction?.setEffectiveWeight(0)
      this.walkAction?.setEffectiveWeight(0)
      this.runAction?.setEffectiveWeight(0)
      this.jumpAction?.setEffectiveWeight(0)
      this.doubleJumpAction?.setEffectiveWeight(1)
      this.mixer.update(delta)
      return
    }

    const k = 1 - Math.exp(-14 * delta)
    let targetWalk = 0
    let targetRun = 0
    let targetJump = 0

    const vy = state.verticalVelocity ?? 0
    const locomotionGrounded =
      state.grounded ||
      state.nearGround === true ||
      (state.horizontalSpeed > 0.12 &&
        !state.jumping &&
        !state.doubleJumping &&
        !state.falling &&
        vy > -3)

    if (!locomotionGrounded) {
      if (state.jumping) {
        targetJump = 1
      }
    } else if (state.horizontalSpeed > 0.05) {
      if (state.locomotionMode === 'walk' && this.walkAction) {
        targetWalk = Math.min(1, state.horizontalSpeed / DCL_LOCOMOTION_DEFAULTS.walkSpeed)
      } else if (this.runAction) {
        const ref =
          state.locomotionMode === 'run'
            ? DCL_LOCOMOTION_DEFAULTS.runSpeed
            : DCL_LOCOMOTION_DEFAULTS.jogSpeed
        targetRun = Math.min(1, state.horizontalSpeed / ref)
      }
    }

    this.walkBlend += (targetWalk - this.walkBlend) * k
    this.runBlend += (targetRun - this.runBlend) * k
    this.jumpBlend += (targetJump - this.jumpBlend) * k

    const locomotion = Math.max(this.walkBlend, this.runBlend)
    const idleWeight = Math.max(0, 1 - locomotion - this.jumpBlend)

    this.idleAction?.setEffectiveWeight(idleWeight)
    this.walkAction?.setEffectiveWeight(this.walkBlend)
    this.runAction?.setEffectiveWeight(this.runBlend)
    this.jumpAction?.setEffectiveWeight(this.jumpBlend)
    this.doubleJumpAction?.setEffectiveWeight(0)

    if (this.walkAction && state.locomotionMode === 'walk') {
      const ref = Math.max(DCL_LOCOMOTION_DEFAULTS.walkSpeed, 0.001)
      this.walkAction.setEffectiveTimeScale(Math.max(0.35, state.horizontalSpeed / ref))
    }
    if (this.runAction) {
      if (state.locomotionMode === 'run') {
        const ref = Math.max(DCL_LOCOMOTION_DEFAULTS.runSpeed, 0.001)
        this.runAction.setEffectiveTimeScale(Math.max(1.05, (state.horizontalSpeed / ref) * 1.1))
      } else if (state.locomotionMode === 'jog') {
        const ref = Math.max(DCL_LOCOMOTION_DEFAULTS.jogSpeed, 0.001)
        // Explorer jog (blend tier 2) uses run.glb slowed — not walk.glb sped up.
        this.runAction.setEffectiveTimeScale(Math.max(0.78, (state.horizontalSpeed / ref) * 0.88))
      }
    }
    if (this.jumpAction && state.jumping) {
      this.jumpAction.setEffectiveTimeScale(1)
    }

    this.locomotionVfx?.update(delta, {
      locomotionMode: state.locomotionMode,
      horizontalSpeed: state.horizontalSpeed,
      grounded: state.grounded,
      nearGround: state.nearGround
    })

    this.mixer.update(delta)
  }

  dispose(): void {
    if (this.mixer) {
      this.mixer.removeEventListener('finished', this.onMixerFinished)
      this.mixer.stopAllAction()
    }
    this.stopProfileEmote()
    this.locomotionVfx?.dispose()
    this.locomotionVfx = null
    this.mixer = null
    this.avatarRoot = null
    this.attachParent = null
    this.idleAction = null
    this.walkAction = null
    this.runAction = null
    this.jumpAction = null
    this.doubleJumpAction = null
    this.activeProfileEmoteKey = null
    this.doubleJumpPlaying = false
    this.walkBlend = 0
    this.runBlend = 0
    this.jumpBlend = 0
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
    this.runAction?.setEffectiveWeight(0)
    this.jumpAction?.setEffectiveWeight(0)
    this.doubleJumpAction?.setEffectiveWeight(0)
    this.profileAction?.setEffectiveWeight(hasAvatarTrack ? 1 : 0)
    this.propAction?.setEffectiveWeight(hasPropTrack ? 1 : 0)
  }

  private restoreLocomotionWeights(): void {
    this.idleAction?.setEffectiveWeight(1)
    this.walkAction?.setEffectiveWeight(0)
    this.runAction?.setEffectiveWeight(0)
    this.jumpAction?.setEffectiveWeight(0)
    this.doubleJumpAction?.setEffectiveWeight(0)
    this.idleAction?.play()
    this.walkAction?.play()
    this.runAction?.play()
    this.jumpAction?.play()
    this.doubleJumpAction?.play()
    this.mixer?.update(0)
  }

  private playLoop(
    clip: THREE.AnimationClip | undefined,
    avatarRoot: THREE.Object3D,
    bodyShape: BodyShape,
    weight = 1
  ): THREE.AnimationAction | null {
    const remapped = getRemappedLocomotionClip(clip, avatarRoot, bodyShape)
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
}
