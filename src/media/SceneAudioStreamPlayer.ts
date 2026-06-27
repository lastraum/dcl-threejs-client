import * as THREE from 'three'
import type { PBAudioStream } from '@dcl/ecs/dist/components/generated/pb/decentraland/sdk/components/audio_stream.gen'
import { applyDclLocalTransform, type DclTransformValues } from '../bridge/dclTransform'
import { spatialAudioGain } from '../rendering/SoundSettings'
import {
  MS_BUFFERING,
  MS_ERROR,
  MS_LOADING,
  MS_NONE,
  MS_PAUSED,
  MS_PLAYING,
  MS_READY,
  type MediaStateValue
} from './audioConstants'

type HlsInstance = {
  loadSource(url: string): void
  attachMedia(media: HTMLMediaElement): void
  destroy(): void
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v))
}

function isHlsUrl(url: string): boolean {
  if (/\.m3u8(\?|#|$)/i.test(url)) return true
  if (/^https?:\/\//i.test(url) && !/\/contents?\//i.test(url)) {
    return !/\.(mp3|ogg|wav|aac|m4a|mp4|webm|ogv|mov)(\?|#|$)/i.test(url)
  }
  return false
}

function safariNativeHls(audio: HTMLAudioElement): boolean {
  return audio.canPlayType('application/vnd.apple.mpegurl') !== '' || audio.canPlayType('application/x-mpegURL') !== ''
}

/** HTMLAudioElement stream decoder for one ECS AudioStream entity. */
export class SceneAudioStreamPlayer {
  private audio: HTMLAudioElement
  private sound: THREE.Audio
  private hls: HlsInstance | null = null
  private spatial = false
  private spatialMin = 0
  private spatialMax = 60
  private loadedUrl = ''
  private loadGeneration = 0
  private playGeneration = 0
  private state: MediaStateValue = MS_NONE
  private userGestureUnlocked = false
  private visibilityPaused = false
  private wantsPlaying = false
  private lastEcsPlaying: boolean | undefined
  private lastSpecVolume = 1

  constructor(
    private readonly listener: THREE.AudioListener,
    spatial: boolean,
    spatialMinDistance: number,
    spatialMaxDistance: number,
    parent?: THREE.Object3D,
    localTransform?: DclTransformValues
  ) {
    this.spatial = spatial
    this.spatialMin = spatialMinDistance
    this.spatialMax = spatialMaxDistance
    this.audio = this.createAudioElement()
    this.sound = this.createSound(spatial, spatialMinDistance, spatialMaxDistance)
    this.bindAudioElement(this.sound)
    if (spatial && parent) this.attachToParent(parent, localTransform)
    this.wireMediaEvents()
  }

  getMediaState(): MediaStateValue {
    return this.state
  }

  setUserGestureUnlocked(unlocked: boolean): void {
    this.userGestureUnlocked = unlocked
    if (unlocked && this.wantsPlaying && !this.visibilityPaused) {
      void this.tryPlay()
    }
  }

  setVisibilityPaused(paused: boolean): void {
    if (this.visibilityPaused === paused) return
    this.visibilityPaused = paused
    if (paused) {
      this.bumpPlayGeneration()
      this.audio.pause()
      this.setState(MS_PAUSED)
    } else if (this.wantsPlaying) {
      void this.tryPlay()
    }
  }

  attachToParent(parent: THREE.Object3D, localTransform?: DclTransformValues): void {
    if (!this.spatial) return
    if (this.sound.parent !== parent) parent.add(this.sound)
    if (localTransform) applyDclLocalTransform(this.sound, localTransform)
  }

  /** Recreate decoder when spatial mode or falloff distances require a new graph. */
  setSpatialMode(
    spatial: boolean,
    spatialMinDistance: number,
    spatialMaxDistance: number,
    parent?: THREE.Object3D,
    localTransform?: DclTransformValues
  ): void {
    const same =
      this.spatial === spatial &&
      this.spatialMin === spatialMinDistance &&
      this.spatialMax === spatialMaxDistance
    if (same) return

    const url = this.loadedUrl
    const playing = this.wantsPlaying
    this.disposeSoundGraph()
    this.spatial = spatial
    this.spatialMin = spatialMinDistance
    this.spatialMax = spatialMaxDistance
    this.audio = this.createAudioElement()
    this.sound = this.createSound(spatial, spatialMinDistance, spatialMaxDistance)
    this.bindAudioElement(this.sound)
    if (spatial && parent) this.attachToParent(parent, localTransform)
    this.wireMediaEvents()
    this.loadedUrl = ''
    if (url) void this.loadStream(url, playing)
  }

  applySpatialDistances(spatialMinDistance: number, spatialMaxDistance: number): void {
    if (!this.spatial) return
    const positional = this.sound as unknown as THREE.PositionalAudio
    positional.setRefDistance(Math.max(spatialMinDistance, 0.01))
    positional.setMaxDistance(Math.max(spatialMaxDistance, 1))
    this.spatialMin = spatialMinDistance
    this.spatialMax = spatialMaxDistance
  }

  applySpec(spec: PBAudioStream): void {
    const ecsPlaying = spec.playing !== false
    const ecsPlayingChanged =
      this.lastEcsPlaying !== undefined && ecsPlaying !== this.lastEcsPlaying

    const url = spec.url?.trim() ?? ''
    if (url && url !== this.loadedUrl) {
      void this.loadStream(url, ecsPlaying)
    } else if (!url) {
      this.setState(MS_ERROR)
    }

    this.lastSpecVolume = spec.volume ?? 1
    this.applyEffectiveVolume()

    if (this.spatial) {
      this.applySpatialDistances(spec.spatialMinDistance ?? 0, spec.spatialMaxDistance ?? 60)
    }

    this.wantsPlaying = ecsPlaying
    this.lastEcsPlaying = ecsPlaying

    if (this.visibilityPaused) return

    if (ecsPlaying) {
      void this.tryPlay()
    } else if (ecsPlayingChanged || !this.audio.paused) {
      this.bumpPlayGeneration()
      this.audio.pause()
      this.setState(MS_PAUSED)
    }
  }

  wouldEcsPlayingChange(ecsPlaying: boolean): boolean {
    return this.lastEcsPlaying !== undefined && ecsPlaying !== this.lastEcsPlaying
  }

  refreshVolume(): void {
    this.applyEffectiveVolume()
  }

  dispose(): void {
    this.disposeSoundGraph()
    this.loadedUrl = ''
    this.setState(MS_NONE)
  }

  private createAudioElement(): HTMLAudioElement {
    const audio = document.createElement('audio')
    audio.crossOrigin = 'anonymous'
    audio.preload = 'auto'
    audio.style.cssText =
      'position:fixed;left:-9999px;top:-9999px;width:1px;height:1px;opacity:0;pointer-events:none'
    document.body.appendChild(audio)
    return audio
  }

  private createSound(
    spatial: boolean,
    spatialMinDistance: number,
    spatialMaxDistance: number
  ): THREE.Audio {
    if (!spatial) return new THREE.Audio(this.listener)
    const positional = new THREE.PositionalAudio(this.listener)
    positional.setRefDistance(Math.max(spatialMinDistance, 0.01))
    positional.setRolloffFactor(1)
    positional.setDistanceModel('inverse')
    positional.setMaxDistance(Math.max(spatialMaxDistance, 1))
    return positional as unknown as THREE.Audio
  }

  private bindAudioElement(sound: THREE.Audio): void {
    sound.setMediaElementSource(this.audio)
  }

  private wireMediaEvents(): void {
    this.audio.addEventListener('loadstart', () => this.setState(MS_LOADING))
    this.audio.addEventListener('loadedmetadata', () => {
      if (this.state !== MS_ERROR) this.setState(MS_READY)
    })
    this.audio.addEventListener('canplay', () => {
      if (this.state !== MS_ERROR && this.audio.paused) this.setState(MS_READY)
    })
    this.audio.addEventListener('playing', () => this.setState(MS_PLAYING))
    this.audio.addEventListener('pause', () => {
      if (this.state !== MS_ERROR) this.setState(MS_PAUSED)
    })
    this.audio.addEventListener('waiting', () => {
      if (this.state !== MS_ERROR) this.setState(MS_BUFFERING)
    })
    this.audio.addEventListener('error', () => this.setState(MS_ERROR))
  }

  private async loadStream(url: string, resume: boolean): Promise<void> {
    const gen = ++this.loadGeneration
    this.loadedUrl = url
    this.setState(MS_LOADING)
    this.bumpPlayGeneration()
    this.audio.pause()

    this.hls?.destroy()
    this.hls = null
    this.audio.removeAttribute('src')
    this.audio.load()

    if (isHlsUrl(url) && !safariNativeHls(this.audio)) {
      try {
        const mod = await import('hls.js')
        const Hls = mod.default
        if (!Hls.isSupported()) {
          this.setState(MS_ERROR)
          return
        }
        const hls = new Hls({ enableWorker: false }) as HlsInstance
        hls.attachMedia(this.audio)
        hls.loadSource(url)
        this.hls = hls
      } catch {
        if (gen === this.loadGeneration) this.setState(MS_ERROR)
        return
      }
    } else {
      this.audio.src = url
      this.audio.load()
    }

    if (gen !== this.loadGeneration) return
    if (resume && this.wantsPlaying && !this.visibilityPaused) {
      void this.tryPlay()
    }
  }

  private applyEffectiveVolume(): void {
    const gain = clamp(spatialAudioGain('voice', this.lastSpecVolume), 0, 1)
    this.sound.setVolume(gain)
  }

  private async tryPlay(): Promise<void> {
    if (!this.userGestureUnlocked || this.visibilityPaused || !this.wantsPlaying) return
    if (!this.loadedUrl) return

    try {
      if (this.sound.context.state === 'suspended') {
        await this.sound.context.resume()
      }
    } catch {
      return
    }

    const gen = ++this.playGeneration
    try {
      await this.audio.play()
    } catch (err) {
      if (gen !== this.playGeneration) return
      if (err instanceof DOMException && err.name === 'AbortError') return
      console.warn('[SceneAudioStreamPlayer] play() blocked or failed', err, this.loadedUrl)
      this.setState(MS_ERROR)
    }
  }

  private bumpPlayGeneration(): void {
    this.playGeneration++
  }

  private disposeSoundGraph(): void {
    this.hls?.destroy()
    this.hls = null
    this.bumpPlayGeneration()
    this.audio.pause()
    this.sound.disconnect()
    this.sound.parent?.remove(this.sound)
    this.audio.removeAttribute('src')
    this.audio.load()
    this.audio.remove()
  }

  private setState(next: MediaStateValue): void {
    this.state = next
  }
}