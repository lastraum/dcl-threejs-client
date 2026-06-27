import * as THREE from 'three'
import {
  VS_BUFFERING,
  VS_ERROR,
  VS_LOADING,
  VS_NONE,
  VS_PAUSED,
  VS_PLAYING,
  VS_READY,
  VS_SEEKING,
  type VideoStateValue
} from './videoConstants'
import type { PBVideoPlayer } from '@dcl/ecs/dist/components/generated/pb/decentraland/sdk/components/video_player.gen'
import { applyDclLocalTransform, type DclTransformValues } from '../bridge/dclTransform'
import { resolveSceneMediaUrl } from '../bridge/material/resolveTexture'
import { unwrapMisroutedMediaUrl } from '../rendering/textureProxy'
import type { ResolvedScene } from '../dcl/content/types'
import { isLiveKitCurrentStreamSrc, isLiveKitVideoSrc } from './livekitVideoSource'
import { mediaElementGain, spatialAudioGain } from '../rendering/SoundSettings'
import { ThrottledVideoTexture } from './ThrottledVideoTexture'
import { getSharedLiveKitVideoStream } from './SharedLiveKitVideoStream'

type HlsInstance = {
  loadSource(url: string): void
  attachMedia(video: HTMLMediaElement): void
  destroy(): void
  on?(event: string, handler: (event: string, data: { type?: string; details?: string; fatal?: boolean }) => void): void
}

type HlsConstructor = {
  new (config?: Record<string, unknown>): HlsInstance
  isSupported(): boolean
  Events?: { ERROR: string }
}

export type LiveKitVideoBinder = (video: HTMLVideoElement, onUpdate?: () => void) => () => void

function isHlsUrl(url: string): boolean {
  if (/\.m3u8(\?|#|$)/i.test(url)) return true
  if (/^https?:\/\//i.test(url) && !/\/contents?\//i.test(url)) {
    return !/\.(mp4|webm|ogv|mov|m4v)(\?|#|$)/i.test(url)
  }
  return false
}

function safariNativeHls(video: HTMLVideoElement): boolean {
  return video.canPlayType('application/vnd.apple.mpegurl') !== '' || video.canPlayType('application/x-mpegURL') !== ''
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v))
}

/** Hidden HTMLVideoElement decoder for scene VideoPlayer components. */
export class WebVideoPlayer {
  readonly video: HTMLVideoElement
  private throttledTexture: ThrottledVideoTexture | null = null
  private usesSharedLiveKit = false
  private sharedLiveKitUnsubscribe: (() => void) | null = null

  private hls: HlsInstance | null = null
  private liveKitCleanup: (() => void) | null = null
  private loadedSrc = ''
  private liveKitSource = false
  private state: VideoStateValue = VS_NONE
  private userGestureUnlocked = false
  private visibilityPaused = false
  private budgetPaused = false
  private wantsPlaying = true
  private playGeneration = 0
  private hasHadRenderableFrame = false
  private lastSpecPosition: number | undefined
  private lastEcsPlaying: boolean | undefined
  private holdingAtEnd = false
  private lastSpecVolume = 1
  private spatial = false
  private spatialMin = 0
  private spatialMax = 60
  private sound: THREE.Audio | null = null
  private listener: THREE.AudioListener | null = null
  onFrameReady?: () => void
  onNaturalEnd?: () => void
  onReplayStarted?: () => void

  get texture(): THREE.Texture {
    if (this.usesSharedLiveKit) {
      return getSharedLiveKitVideoStream().getTexture() ?? this.ensureLocalTexture().texture
    }
    return this.ensureLocalTexture().texture
  }

  constructor(
    private readonly scene: ResolvedScene,
    private readonly bindLiveKitVideo: LiveKitVideoBinder | null = null
  ) {
    this.video = document.createElement('video')
    this.video.crossOrigin = 'anonymous'
    this.video.playsInline = true
    this.video.preload = 'auto'
    this.video.style.cssText =
      'position:fixed;left:-9999px;top:-9999px;width:1px;height:1px;opacity:0;pointer-events:none'
    document.body.appendChild(this.video)

    this.video.addEventListener('loadstart', () => this.setState(VS_LOADING))
    this.video.addEventListener('loadedmetadata', () => this.onFrameReady?.())
    this.video.addEventListener('loadeddata', () => {
      if (this.state !== VS_ERROR) this.setState(VS_READY)
      this.onFrameReady?.()
    })
    this.video.addEventListener('canplay', () => {
      if (this.state !== VS_ERROR && !this.video.paused) return
      if (this.state !== VS_ERROR) this.setState(VS_READY)
    })
    this.video.addEventListener('playing', () => {
      this.setState(VS_PLAYING)
      this.onFrameReady?.()
    })
    this.video.addEventListener('pause', () => {
      if (this.state !== VS_SEEKING && this.state !== VS_ERROR) {
        this.setState(VS_PAUSED)
      }
    })
    this.video.addEventListener('waiting', () => {
      if (this.state === VS_PLAYING || this.state === VS_BUFFERING) {
        this.setState(VS_BUFFERING)
      }
    })
    this.video.addEventListener('seeking', () => this.setState(VS_SEEKING))
    this.video.addEventListener('seeked', () => {
      if (this.wantsPlaying && !this.isPlaybackBlocked()) {
        this.setState(this.video.paused ? VS_PAUSED : VS_PLAYING)
      } else {
        this.setState(VS_PAUSED)
      }
    })
    this.video.addEventListener('error', () => {
      const err = this.video.error
      console.warn('[WebVideoPlayer] decode error', err?.code, err?.message, this.loadedSrc)
      this.setState(VS_ERROR)
    })
    this.video.addEventListener('ended', () => {
      this.setState(VS_PAUSED)
      if (!this.video.loop && !this.liveKitSource) {
        this.holdingAtEnd = true
        this.onNaturalEnd?.()
      }
    })
  }

  setAudioListener(listener: THREE.AudioListener | null): void {
    if (this.listener === listener) return
    this.disposeSpatialSound()
    this.listener = listener
    if (this.spatial && listener) {
      this.sound = this.createSpatialSound(this.spatialMin, this.spatialMax)
      this.bindSpatialMedia()
      this.applyEffectiveVolume()
    }
  }

  setSpatialAudio(
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
    if (same && (!spatial || this.sound?.parent === parent)) {
      if (spatial && parent && this.sound) this.attachSpatialSound(parent, localTransform)
      return
    }

    this.disposeSpatialSound()
    this.spatial = spatial
    this.spatialMin = spatialMinDistance
    this.spatialMax = spatialMaxDistance

    if (spatial && this.listener) {
      this.sound = this.createSpatialSound(spatialMinDistance, spatialMaxDistance)
      if (parent) this.attachSpatialSound(parent, localTransform)
      this.bindSpatialMedia()
    }

    this.applyEffectiveVolume()
  }

  attachSpatialSound(parent: THREE.Object3D, localTransform?: DclTransformValues): void {
    if (!this.spatial || !this.sound) return
    if (this.sound.parent !== parent) parent.add(this.sound)
    if (localTransform) applyDclLocalTransform(this.sound, localTransform)
  }

  applySpatialDistances(spatialMinDistance: number, spatialMaxDistance: number): void {
    if (!this.spatial || !this.sound) return
    const positional = this.sound as unknown as THREE.PositionalAudio
    positional.setRefDistance(Math.max(spatialMinDistance, 0.01))
    positional.setMaxDistance(Math.max(spatialMaxDistance, 1))
    this.spatialMin = spatialMinDistance
    this.spatialMax = spatialMaxDistance
  }

  getVideoState(): VideoStateValue {
    return this.state
  }

  getCurrentOffset(): number {
    const t = this.activeVideo().currentTime
    return Number.isFinite(t) ? t : 0
  }

  getVideoLength(): number {
    const d = this.activeVideo().duration
    return Number.isFinite(d) ? d : 0
  }

  hasRenderableFrame(): boolean {
    const video = this.usesSharedLiveKit ? getSharedLiveKitVideoStream().video : this.video
    if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
      this.hasHadRenderableFrame = true
      return true
    }
    if (this.liveKitSource && video.videoWidth > 0) {
      this.hasHadRenderableFrame = true
      return true
    }
    return this.hasHadRenderableFrame && this.state !== VS_ERROR && !!this.loadedSrc
  }

  canAttachTexture(): boolean {
    const video = this.usesSharedLiveKit ? getSharedLiveKitVideoStream().video : this.video
    return (
      !!this.loadedSrc &&
      this.state !== VS_ERROR &&
      (video.readyState >= HTMLMediaElement.HAVE_METADATA ||
        this.hasHadRenderableFrame ||
        (this.liveKitSource && video.videoWidth > 0))
    )
  }

  isHoldingAtEnd(): boolean {
    return this.holdingAtEnd
  }

  replayFromUserClick(): void {
    if (this.liveKitSource) {
      if (!this.isPlaybackBlocked()) void this.tryPlay()
      return
    }
    if (!this.isAtEnd() && !this.holdingAtEnd) return
    this.holdingAtEnd = false
    this.restartFromBeginning()
    this.lastEcsPlaying = true
    this.wantsPlaying = true
    if (!this.isPlaybackBlocked()) void this.tryPlay()
    this.onReplayStarted?.()
  }

  setUserGestureUnlocked(unlocked: boolean): void {
    this.userGestureUnlocked = unlocked
    if (unlocked && this.wantsPlaying && !this.isPlaybackBlocked()) {
      void this.tryPlay()
    }
  }

  setVisibilityPaused(paused: boolean): void {
    if (this.visibilityPaused === paused) return
    this.visibilityPaused = paused
    this.syncPlaybackPause()
  }

  setBudgetPaused(paused: boolean): void {
    if (this.budgetPaused === paused) return
    this.budgetPaused = paused
    this.syncPlaybackPause()
  }

  applySpec(
    spec: PBVideoPlayer,
    options?: { fromEcsSync?: boolean; fromUserToggle?: boolean }
  ): void {
    const ecsPlaying = spec.playing !== false
    const ecsPlayingChanged =
      this.lastEcsPlaying !== undefined && ecsPlaying !== this.lastEcsPlaying

    if (
      !this.liveKitSource &&
      !options?.fromEcsSync &&
      options?.fromUserToggle &&
      this.isAtEnd() &&
      (ecsPlayingChanged || this.holdingAtEnd)
    ) {
      this.holdingAtEnd = false
      this.restartFromBeginning()
      this.lastEcsPlaying = true
      this.wantsPlaying = true
      if (!this.isPlaybackBlocked()) void this.tryPlay()
      this.onReplayStarted?.()
      return
    }

    const src = spec.src.trim()
    if (src && src !== this.loadedSrc) {
      if (isLiveKitVideoSrc(src)) {
        if (isLiveKitCurrentStreamSrc(src)) void this.loadLiveKitSource(src)
        else this.setState(VS_ERROR)
      } else {
        const url = resolveSceneMediaUrl(src, this.scene)
        if (url) void this.loadSource(url)
        else this.setState(VS_ERROR)
      }
    } else if (!src) {
      this.setState(VS_ERROR)
    }

    this.video.loop = !this.liveKitSource && spec.loop === true
    this.lastSpecVolume = spec.volume ?? 1
    this.applyEffectiveVolume()
    if (this.spatial) {
      this.applySpatialDistances(spec.spatialMinDistance ?? 0, spec.spatialMaxDistance ?? 60)
    }
    this.video.playbackRate = Math.max(spec.playbackRate ?? 1, 0.01)

    if (!this.liveKitSource) {
      const specPosition = Math.max(spec.position ?? 0, 0)
      const positionFieldChanged =
        this.lastSpecPosition === undefined || Math.abs(specPosition - this.lastSpecPosition) > 0.05
      if (positionFieldChanged) {
        const stalePositionOnPlayToggle =
          ecsPlayingChanged &&
          this.video.currentTime > 0.5 &&
          Math.abs(specPosition - this.video.currentTime) > 1.5
        if (
          !stalePositionOnPlayToggle &&
          Number.isFinite(specPosition) &&
          Math.abs(this.video.currentTime - specPosition) > 0.25
        ) {
          this.video.currentTime = specPosition
        }
        this.lastSpecPosition = stalePositionOnPlayToggle
          ? this.video.currentTime
          : specPosition
      } else if (ecsPlayingChanged) {
        this.lastSpecPosition = this.video.currentTime
      }
    }

    this.wantsPlaying = ecsPlaying
    this.lastEcsPlaying = ecsPlaying

    if (this.isPlaybackBlocked()) return

    if (ecsPlaying) {
      if (!this.liveKitSource && this.isAtEnd() && !ecsPlayingChanged) {
        this.wantsPlaying = false
        this.bumpPlayGeneration()
        this.video.pause()
        return
      }
      if (this.usesSharedLiveKit) void this.tryPlayShared(getSharedLiveKitVideoStream().video)
      else void this.tryPlay()
      this.syncThrottledPlayback()
    } else {
      this.bumpPlayGeneration()
      if (!this.usesSharedLiveKit) this.video.pause()
      this.syncThrottledPlayback()
    }
  }

  dispose(): void {
    this.clearMediaSource()
    this.disposeSpatialSound()
    this.throttledTexture?.dispose()
    this.throttledTexture = null
    if (!this.usesSharedLiveKit) this.video.remove()
  }

  wouldEcsPlayingChange(ecsPlaying: boolean): boolean {
    return this.lastEcsPlaying !== undefined && ecsPlaying !== this.lastEcsPlaying
  }

  alignEcsPlaying(playing: boolean): void {
    this.lastEcsPlaying = playing
    this.wantsPlaying = playing
  }

  refreshVolume(): void {
    this.applyEffectiveVolume()
  }

  needsReplayAfterEnd(playingChanged: boolean, fromUserToggle: boolean): boolean {
    if (this.liveKitSource) return false
    if (!fromUserToggle || !this.isAtEnd()) return false
    return playingChanged || this.holdingAtEnd
  }

  isAtEnd(): boolean {
    if (this.liveKitSource) return false
    if (this.video.ended) return true
    const duration = this.video.duration
    if (!Number.isFinite(duration) || duration <= 0) return false
    return this.video.currentTime >= duration - 0.35
  }

  private isPlaybackBlocked(): boolean {
    return this.visibilityPaused || this.budgetPaused
  }

  private syncPlaybackPause(): void {
    if (this.isPlaybackBlocked()) {
      this.bumpPlayGeneration()
      if (this.usesSharedLiveKit) {
        // Shared decode keeps running for other theatre screens.
      } else {
        this.video.pause()
      }
      this.syncThrottledPlayback()
    } else if (this.wantsPlaying) {
      if (this.usesSharedLiveKit) void this.tryPlayShared(getSharedLiveKitVideoStream().video)
      else void this.tryPlay()
      this.syncThrottledPlayback()
    }
  }

  private resolveVolumeCategory(src: string): 'voice' | 'inWorld' {
    if (this.liveKitSource || isLiveKitVideoSrc(src)) return 'voice'
    const trimmed = src.trim()
    if (isHlsUrl(trimmed)) return 'voice'
    if (/^https?:\/\//i.test(trimmed) && !/\/contents?\//i.test(trimmed)) return 'voice'
    return 'inWorld'
  }

  private applyEffectiveVolume(): void {
    const category = this.resolveVolumeCategory(this.loadedSrc)
    if (this.spatial && this.sound) {
      const gain = clamp(spatialAudioGain(category, this.lastSpecVolume), 0, 1)
      this.video.volume = 0
      this.video.muted = true
      this.sound.setVolume(gain)
    } else {
      const gain = clamp(mediaElementGain(category, this.lastSpecVolume), 0, 1)
      this.video.muted = false
      this.video.volume = gain
      this.sound?.setVolume(0)
    }
  }

  private createSpatialSound(spatialMinDistance: number, spatialMaxDistance: number): THREE.Audio {
    const positional = new THREE.PositionalAudio(this.listener!)
    positional.setRefDistance(Math.max(spatialMinDistance, 0.01))
    positional.setRolloffFactor(1)
    positional.setDistanceModel('inverse')
    positional.setMaxDistance(Math.max(spatialMaxDistance, 1))
    return positional as unknown as THREE.Audio
  }

  private bindSpatialMedia(): void {
    if (!this.sound) return
    try {
      this.sound.setMediaElementSource(this.video)
    } catch (err) {
      console.warn('[WebVideoPlayer] spatial audio bind failed', err)
    }
  }

  private disposeSpatialSound(): void {
    if (!this.sound) return
    this.sound.parent?.remove(this.sound)
    this.sound.disconnect()
    this.sound = null
  }

  private setState(next: VideoStateValue): void {
    this.state = next
  }

  private clearMediaSource(): void {
    this.sharedLiveKitUnsubscribe?.()
    this.sharedLiveKitUnsubscribe = null
    this.liveKitCleanup?.()
    this.liveKitCleanup = null
    this.hls?.destroy()
    this.hls = null
    this.bumpPlayGeneration()
    if (!this.usesSharedLiveKit) {
      this.throttledTexture?.stop()
      this.video.pause()
      this.video.srcObject = null
      this.video.removeAttribute('src')
      this.video.load()
    }
    this.loadedSrc = ''
    this.liveKitSource = false
    this.usesSharedLiveKit = false
    this.hasHadRenderableFrame = false
  }

  private async loadLiveKitSource(src: string): Promise<void> {
    if (!this.bindLiveKitVideo) {
      this.setState(VS_ERROR)
      return
    }

    this.clearMediaSource()
    this.loadedSrc = src
    this.liveKitSource = true
    this.usesSharedLiveKit = true
    this.holdingAtEnd = false
    this.setState(VS_LOADING)

    const shared = getSharedLiveKitVideoStream()
    const onTrackUpdate = (): void => {
      const video = shared.video
      if (video.videoWidth > 0 || video.readyState >= HTMLMediaElement.HAVE_METADATA) {
        if (this.state !== VS_ERROR) this.setState(VS_READY)
        this.onFrameReady?.()
      }
      if (this.wantsPlaying && !this.isPlaybackBlocked()) void this.tryPlayShared(video)
    }

    this.sharedLiveKitUnsubscribe = shared.subscribe(this.bindLiveKitVideo, onTrackUpdate)
    this.liveKitCleanup = () => {
      this.sharedLiveKitUnsubscribe?.()
      this.sharedLiveKitUnsubscribe = null
    }
    onTrackUpdate()
  }

  private async loadSource(url: string): Promise<void> {
    const mediaUrl = unwrapMisroutedMediaUrl(url)
    if (mediaUrl !== url) {
      console.warn('[WebVideoPlayer] unwrapped texture-proxy media URL', url, '→', mediaUrl)
    }
    this.clearMediaSource()
    this.loadedSrc = mediaUrl
    this.hasHadRenderableFrame = false
    this.setState(VS_LOADING)

    if (isHlsUrl(mediaUrl)) {
      try {
        const mod = await import('hls.js')
        const Hls = mod.default as HlsConstructor
        if (Hls.isSupported()) {
          const hls = new Hls({
            // Vite-bundled worker URLs often break TS demux (DEMUXER_ERROR_COULD_NOT_PARSE).
            enableWorker: false,
            lowLatencyMode: false
          })
          const errorEvent = Hls.Events?.ERROR ?? 'hlsError'
          hls.on?.(errorEvent, (_event, data) => {
            if (!data.fatal) return
            console.warn('[WebVideoPlayer] HLS fatal error', data.type, data.details, mediaUrl)
            this.setState(VS_ERROR)
          })
          hls.attachMedia(this.video)
          hls.loadSource(mediaUrl)
          this.hls = hls
          this.ensureLocalTexture().start()
          return
        }
      } catch (err) {
        console.warn('[WebVideoPlayer] HLS.js init failed', err, mediaUrl)
      }

      if (safariNativeHls(this.video)) {
        this.video.src = mediaUrl
        this.video.load()
        this.ensureLocalTexture().start()
        return
      }

      console.warn('[WebVideoPlayer] HLS playback unavailable', mediaUrl)
      this.setState(VS_ERROR)
      return
    }

    this.video.src = mediaUrl
    this.video.load()
    this.ensureLocalTexture().start()
  }

  private activeVideo(): HTMLVideoElement {
    return this.usesSharedLiveKit ? getSharedLiveKitVideoStream().video : this.video
  }

  private ensureLocalTexture(): ThrottledVideoTexture {
    if (!this.throttledTexture) {
      this.throttledTexture = new ThrottledVideoTexture(this.video)
    }
    return this.throttledTexture
  }

  private syncThrottledPlayback(): void {
    if (this.usesSharedLiveKit || !this.throttledTexture) return
    if (this.isPlaybackBlocked() || !this.wantsPlaying) {
      this.throttledTexture.stop()
    } else {
      this.throttledTexture.start()
    }
  }

  private async tryPlayShared(video: HTMLVideoElement): Promise<void> {
    if (!this.userGestureUnlocked || this.isPlaybackBlocked() || !this.wantsPlaying) return
    const gen = ++this.playGeneration
    try {
      await video.play()
    } catch (err) {
      if (gen !== this.playGeneration) return
      if (err instanceof DOMException && err.name === 'AbortError') return
      console.warn('[WebVideoPlayer] shared LiveKit play() blocked or failed', err, this.loadedSrc)
    }
  }

  private bumpPlayGeneration(): void {
    this.playGeneration++
  }

  private restartFromBeginning(): void {
    this.holdingAtEnd = false
    this.video.currentTime = 0
    this.lastSpecPosition = 0
    this.wantsPlaying = true
  }

  private async tryPlay(): Promise<void> {
    if (!this.userGestureUnlocked || this.isPlaybackBlocked() || !this.wantsPlaying) return
    const gen = ++this.playGeneration
    try {
      await this.video.play()
    } catch (err) {
      if (gen !== this.playGeneration) return
      if (err instanceof DOMException && err.name === 'AbortError') return
      console.warn('[WebVideoPlayer] play() blocked or failed', err, this.loadedSrc)
    }
  }
}