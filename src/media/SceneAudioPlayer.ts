import * as THREE from 'three'
import type { PBAudioSource } from '@dcl/ecs/dist/components/generated/pb/decentraland/sdk/components/audio_source.gen'
import { applyDclLocalTransform, type DclTransformValues } from '../bridge/dclTransform'
import { resolveSceneAudioUrl } from './resolveSceneAudioUrl'
import type { ResolvedScene } from '../dcl/content/types'
import { inWorldVolumeMultiplier } from '../rendering/SoundSettings'
import type { AudioBufferCache } from './AudioBufferCache'
import {
  MS_ERROR,
  MS_LOADING,
  MS_NONE,
  MS_PAUSED,
  MS_PLAYING,
  MS_READY,
  type MediaStateValue
} from './audioConstants'

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v))
}

/** Spatial falloff tuned for parcel-scale worlds (inverse model). */
const SPATIAL_REF_DISTANCE = 5
const SPATIAL_ROLLOFF = 1
const SPATIAL_MAX_DISTANCE = 80

/** THREE.Audio / PositionalAudio decoder for one ECS AudioSource entity. */
export class SceneAudioPlayer {
  private sound: THREE.Audio
  private global = false
  private loadedClip = ''
  private loadGeneration = 0
  private state: MediaStateValue = MS_NONE
  private userGestureUnlocked = false
  private visibilityPaused = false
  private wantsPlaying = false
  private lastEcsPlaying: boolean | undefined
  private lastSpecCurrentTime: number | undefined
  private holdingAtEnd = false
  private lastSpecVolume = 1
  onNaturalEnd?: () => void

  constructor(
    private readonly listener: THREE.AudioListener,
    private readonly scene: ResolvedScene,
    private readonly cache: AudioBufferCache,
    global: boolean,
    parent?: THREE.Object3D,
    localTransform?: DclTransformValues
  ) {
    this.global = global
    this.sound = this.createSound(global)
    if (!global && parent) this.attachToParent(parent, localTransform)
  }

  getMediaState(): MediaStateValue {
    return this.state
  }

  isPlaying(): boolean {
    return this.sound.isPlaying
  }

  isHoldingAtEnd(): boolean {
    return this.holdingAtEnd
  }

  setUserGestureUnlocked(unlocked: boolean): void {
    this.userGestureUnlocked = unlocked
    if (unlocked && this.wantsPlaying && !this.visibilityPaused) {
      void this.contextResumeAndPlay()
    }
  }

  setVisibilityPaused(paused: boolean): void {
    if (this.visibilityPaused === paused) return
    this.visibilityPaused = paused
    if (paused && this.sound.isPlaying) {
      this.sound.pause()
      this.setState(MS_PAUSED)
    } else if (!paused && this.wantsPlaying) {
      void this.contextResumeAndPlay()
    }
  }

  /** Detach positional audio from the scene graph (global clips stay on the listener only). */
  detachFromScene(): void {
    this.sound.parent?.remove(this.sound)
  }

  /**
   * Parent `PositionalAudio` under a scene entity node (own entity or an ECS parent entity).
   * Re-applies `localTransform` each call so child-entity offsets stay in sync.
   */
  attachToParent(parent: THREE.Object3D, localTransform?: DclTransformValues): void {
    if (this.global) {
      this.detachFromScene()
      return
    }
    if (this.sound.parent !== parent) {
      this.detachFromScene()
      parent.add(this.sound)
    }
    if (localTransform) {
      applyDclLocalTransform(this.sound, localTransform)
    } else {
      this.sound.position.set(0, 0, 0)
      this.sound.quaternion.set(0, 0, 0, 1)
      this.sound.scale.set(1, 1, 1)
    }
  }

  /** Recreate decoder when `global` flag changes. */
  setSpatialMode(global: boolean, parent?: THREE.Object3D, localTransform?: DclTransformValues): void {
    if (this.global === global) return
    this.disposeSound()
    this.global = global
    this.sound = this.createSound(global)
    if (!global && parent) this.attachToParent(parent, localTransform)
    if (this.loadedClip) void this.reloadCurrentClip()
  }

  applySpec(spec: PBAudioSource, options?: { fromEcsSync?: boolean }): void {
    const ecsPlaying = spec.playing !== false
    const ecsPlayingChanged =
      this.lastEcsPlaying !== undefined && ecsPlaying !== this.lastEcsPlaying
    const currentTimeFieldSet = spec.currentTime !== undefined
    const specCurrentTime = Math.max(spec.currentTime ?? 0, 0)

    const clipPath = spec.audioClipUrl?.trim() ?? ''
    const url = clipPath ? resolveSceneAudioUrl(clipPath, this.scene) : null
    if (url && url !== this.loadedClip) {
      void this.loadClip(url)
    } else if (!url && clipPath) {
      this.setState(MS_ERROR)
    }

    this.sound.setLoop(spec.loop === true)
    this.lastSpecVolume = spec.volume ?? 1
    this.applyEffectiveVolume()
    this.sound.setPlaybackRate(Math.max(spec.pitch ?? 1, 0.01))

    const currentTimeChanged =
      this.lastSpecCurrentTime === undefined ||
      Math.abs(specCurrentTime - this.lastSpecCurrentTime) > 0.05

    if (currentTimeFieldSet && currentTimeChanged) {
      this.seekTo(specCurrentTime, false)
      this.lastSpecCurrentTime = specCurrentTime
    } else if (ecsPlayingChanged && !currentTimeFieldSet) {
      this.lastSpecCurrentTime = this.getPlaybackTime()
    } else if (currentTimeFieldSet) {
      this.lastSpecCurrentTime = specCurrentTime
    }

    this.wantsPlaying = ecsPlaying
    this.lastEcsPlaying = ecsPlaying

    if (this.visibilityPaused) return

    if (ecsPlaying) {
      if (this.isAtEnd() && !ecsPlayingChanged && !options?.fromEcsSync) {
        this.wantsPlaying = false
        this.holdingAtEnd = true
        if (this.sound.isPlaying) {
          this.sound.pause()
          this.setState(MS_PAUSED)
        }
        return
      }
      this.holdingAtEnd = false

      const shouldSeekOnPlay =
        ecsPlayingChanged &&
        (currentTimeFieldSet || !this.sound.isPlaying || this.isAtEnd())

      if (shouldSeekOnPlay) {
        const seekTarget = currentTimeFieldSet ? specCurrentTime : this.isAtEnd() ? 0 : this.getPlaybackTime()
        this.seekTo(seekTarget, true)
        return
      }

      void this.contextResumeAndPlay()
    } else {
      if (this.sound.isPlaying) {
        this.sound.pause()
        this.setState(MS_PAUSED)
      }
    }
  }

  refreshVolume(): void {
    this.applyEffectiveVolume()
  }

  alignEcsPlaying(playing: boolean): void {
    this.lastEcsPlaying = playing
    this.wantsPlaying = playing
  }

  wouldEcsPlayingChange(ecsPlaying: boolean): boolean {
    return this.lastEcsPlaying !== undefined && ecsPlaying !== this.lastEcsPlaying
  }

  dispose(): void {
    this.disposeSound()
    this.loadedClip = ''
    this.setState(MS_NONE)
  }

  private applyEffectiveVolume(): void {
    const gain = clamp(this.lastSpecVolume * inWorldVolumeMultiplier(), 0, 1)
    this.sound.setVolume(gain)
  }

  private createSound(global: boolean): THREE.Audio {
    if (global) return new THREE.Audio(this.listener)
    const positional = new THREE.PositionalAudio(this.listener)
    positional.setRefDistance(SPATIAL_REF_DISTANCE)
    positional.setRolloffFactor(SPATIAL_ROLLOFF)
    positional.setDistanceModel('inverse')
    positional.setMaxDistance(SPATIAL_MAX_DISTANCE)
    return positional as unknown as THREE.Audio
  }

  private disposeSound(): void {
    if (this.sound.isPlaying) this.sound.stop()
    this.sound.parent?.remove(this.sound)
    this.sound.disconnect()
  }

  private async reloadCurrentClip(): Promise<void> {
    if (!this.loadedClip) return
    const url = this.loadedClip
    this.loadedClip = ''
    await this.loadClip(url)
  }

  private async loadClip(url: string): Promise<void> {
    const gen = ++this.loadGeneration
    this.loadedClip = url
    this.setState(MS_LOADING)
    if (this.sound.isPlaying) this.sound.stop()

    const buffer = await this.cache.load(url)
    if (gen !== this.loadGeneration) return
    if (!buffer) {
      this.setState(MS_ERROR)
      return
    }

    this.sound.setBuffer(buffer)
    this.setState(MS_READY)
    if (this.wantsPlaying && !this.visibilityPaused) {
      void this.contextResumeAndPlay()
    }
  }

  private getPlaybackTime(): number {
    if (!this.sound.buffer) return 0
    const audio = this.sound as THREE.Audio & {
      _progress?: number
      _startedAt?: number
    }
    if (this.sound.isPlaying && audio._progress !== undefined && audio._startedAt !== undefined) {
      return (
        audio._progress +
        Math.max(this.sound.context.currentTime - audio._startedAt, 0) * this.sound.getPlaybackRate()
      )
    }
    return audio._progress ?? this.sound.offset ?? 0
  }

  private isAtEnd(): boolean {
    const duration = this.sound.buffer?.duration ?? 0
    if (!Number.isFinite(duration) || duration <= 0) return false
    return this.getPlaybackTime() >= duration - 0.08
  }

  private seekTo(seconds: number, resume: boolean): void {
    if (this.sound.isPlaying) this.sound.pause()
    this.sound.stop()
    this.sound.offset = Math.max(0, seconds)
    if (resume && this.wantsPlaying && !this.visibilityPaused) {
      void this.contextResumeAndPlay()
    } else if (this.sound.buffer) {
      this.setState(MS_PAUSED)
    }
  }

  private async contextResumeAndPlay(): Promise<void> {
    if (!this.userGestureUnlocked || this.visibilityPaused || !this.wantsPlaying) return
    if (!this.sound.buffer) return

    try {
      if (this.sound.context.state === 'suspended') {
        await this.sound.context.resume()
      }
    } catch {
      return
    }

    if (this.sound.isPlaying) return

    if (this.isAtEnd() && !this.sound.getLoop()) {
      this.sound.stop()
      this.sound.offset = 0
    }

    this.sound.play()
    this.setState(MS_PLAYING)

    if (!this.sound.getLoop()) {
      const source = (this.sound as THREE.Audio & { source?: AudioBufferSourceNode }).source
      if (source) {
        source.onended = () => {
          this.sound.onEnded()
          this.holdingAtEnd = true
          this.setState(MS_PAUSED)
          this.onNaturalEnd?.()
        }
      }
    }
  }

  private setState(next: MediaStateValue): void {
    this.state = next
  }
}