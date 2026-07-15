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
import {
  isLiveKitCurrentStreamSrc,
  isLiveKitVideoSrc,
  LIVEKIT_CURRENT_STREAM_SRC
} from './livekitVideoSource'
import { mediaElementGain, spatialAudioGain } from '../rendering/SoundSettings'
import { ThrottledVideoTexture } from './ThrottledVideoTexture'
import { getSharedLiveKitVideoStream } from './SharedLiveKitVideoStream'

type HlsInstance = {
  loadSource(url: string): void
  attachMedia(video: HTMLMediaElement): void
  destroy(): void
  recoverMediaError?(): void
  startLoad?(startPosition?: number): void
  on?(
    event: string,
    handler: (event: string, data: { type?: string; details?: string; fatal?: boolean }) => void
  ): void
}

type HlsConstructor = {
  new (config?: Record<string, unknown>): HlsInstance
  isSupported(): boolean
  Events?: { ERROR: string }
}

export type LiveKitVideoBinder = (video: HTMLVideoElement, onUpdate?: () => void) => () => void

/**
 * Only treat real HLS playlists as HLS.
 * Older heuristic treated every external https URL without a video extension as
 * m3u8 — progressive CDN mp4s then failed ~1s into demux.
 */
function isHlsUrl(url: string): boolean {
  if (/\.m3u8(\?|#|$)/i.test(url)) return true
  if (/[?&](?:format|ext|type)=m3u8\b/i.test(url)) return true
  if (/\/playlist\.m3u8\b/i.test(url) || /\/index\.m3u8\b/i.test(url)) return true
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
  /** Invalidates in-flight HLS/import loads so admin default VOD cannot clobber LiveKit. */
  private sourceGeneration = 0
  /** Prevents stacked play() calls from aborting each other every frame. */
  private playInFlight = false
  private hasHadRenderableFrame = false
  /** True after first successful `playing` event — blocks ECS position seeks. */
  private hasStartedPlayback = false
  private lastSpecPosition: number | undefined
  private lastEcsPlaying: boolean | undefined
  private holdingAtEnd = false
  private lastSpecVolume = 1
  private spatial = false
  private spatialMin = 0
  private spatialMax = 60
  private sound: THREE.Audio | null = null
  private listener: THREE.AudioListener | null = null
  /** performance.now() when we last observed pause while wanting play. */
  private pausedWantingPlaySince = 0
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
    this.video.addEventListener('loadedmetadata', () => this.notifyDrawableFrame())
    this.video.addEventListener('loadeddata', () => {
      if (this.state !== VS_ERROR) this.setState(VS_READY)
      this.notifyDrawableFrame()
    })
    this.video.addEventListener('canplay', () => {
      if (this.state !== VS_ERROR) this.setState(this.video.paused ? VS_READY : VS_PLAYING)
    })
    this.video.addEventListener('playing', () => {
      this.setState(VS_PLAYING)
      this.holdingAtEnd = false
      this.hasStartedPlayback = true
      this.pausedWantingPlaySince = 0
      this.playInFlight = false
      this.notifyDrawableFrame()
      this.syncThrottledPlayback()
    })
    this.video.addEventListener('resize', () => this.notifyDrawableFrame())
    this.video.addEventListener('pause', () => {
      if (this.state !== VS_SEEKING && this.state !== VS_ERROR) {
        this.setState(VS_PAUSED)
      }
      if (this.wantsPlaying && !this.isPlaybackBlocked() && !this.holdingAtEnd) {
        this.pausedWantingPlaySince = performance.now()
      }
    })
    this.video.addEventListener('waiting', () => {
      if (this.state === VS_PLAYING || this.state === VS_BUFFERING) {
        this.setState(VS_BUFFERING)
      }
    })
    this.video.addEventListener('stalled', () => {
      if (this.wantsPlaying && !this.isPlaybackBlocked()) {
        this.setState(VS_BUFFERING)
      }
    })
    this.video.addEventListener('seeking', () => this.setState(VS_SEEKING))
    this.video.addEventListener('seeked', () => {
      if (this.wantsPlaying && !this.isPlaybackBlocked()) {
        this.setState(this.video.paused ? VS_PAUSED : VS_PLAYING)
        // Don't immediately tryPlay — seeked often races; tickPlayback recovers.
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
    if (!this.loadedSrc || this.state === VS_ERROR) return false
    // Require real dimensions — HAVE_METADATA alone can bind a 1×1 canvas forever.
    if (video.videoWidth <= 0 || video.videoHeight <= 0) return false
    return (
      video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA ||
      this.hasHadRenderableFrame ||
      this.liveKitSource
    )
  }

  /**
   * Per-frame recovery: re-issue play() only after a short pause debounce so we
   * never stack concurrent play() promises (each aborts the previous).
   */
  tickPlayback(): void {
    if (this.liveKitSource || this.isPlaybackBlocked() || !this.wantsPlaying) return
    if (this.holdingAtEnd || this.video.ended) return
    if (!this.video.paused) {
      this.pausedWantingPlaySince = 0
      this.syncThrottledPlayback()
      return
    }
    if (!this.userGestureUnlocked || this.playInFlight) return
    const now = performance.now()
    if (this.pausedWantingPlaySince === 0) {
      this.pausedWantingPlaySince = now
      return
    }
    // Debounce: only recover after 400ms of unexpected pause (buffer / aborted play).
    if (now - this.pausedWantingPlaySince >= 400) {
      this.pausedWantingPlaySince = now
      void this.tryPlay()
    }
    this.syncThrottledPlayback()
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
    options?: {
      fromEcsSync?: boolean
      fromUserToggle?: boolean
      /** Cast/OBS remote video currently published in the scene LiveKit room. */
      liveKitRemoteLive?: boolean
    }
  ): void {
    const ecsPlaying = spec.playing !== false
    const ecsPlayingChanged =
      this.lastEcsPlaying !== undefined && ecsPlaying !== this.lastEcsPlaying
    const remoteLive = options?.liveKitRemoteLive === true

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

    let src = spec.src.trim()
    // Hold LiveKit once activated — refuse late admin defaultURL/HLS while Cast/OBS is still live.
    // (Do not force non-livekit players onto LiveKit; that thrashed scene-room subscriptions.)
    if (this.liveKitSource && remoteLive && src && !isLiveKitVideoSrc(src)) {
      src = this.loadedSrc || LIVEKIT_CURRENT_STREAM_SRC
    }

    if (src && src !== this.loadedSrc) {
      if (isLiveKitVideoSrc(src)) {
        if (isLiveKitCurrentStreamSrc(src)) void this.loadLiveKitSource(src)
        else this.setState(VS_ERROR)
      } else {
        const url = resolveSceneMediaUrl(src, this.scene)
        if (url) void this.loadSource(url)
        else this.setState(VS_ERROR)
      }
    } else if (
      isLiveKitCurrentStreamSrc(src) &&
      this.loadedSrc === src &&
      !this.usesSharedLiveKit &&
      this.bindLiveKitVideo
    ) {
      // Binder arrived after first attempt, or a stale HLS load tore us down.
      void this.loadLiveKitSource(src)
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
      this.maybeApplyEcsPosition(spec.position, ecsPlaying, ecsPlayingChanged, options)
    }

    this.wantsPlaying = ecsPlaying
    this.lastEcsPlaying = ecsPlaying

    if (this.isPlaybackBlocked()) return

    if (ecsPlaying) {
      // Only hold when the browser truly finished (video.ended). Never use partial duration.
      if (!this.liveKitSource && this.video.ended && !ecsPlayingChanged) {
        this.holdingAtEnd = true
        this.wantsPlaying = false
        this.bumpPlayGeneration()
        return
      }
      if (this.usesSharedLiveKit) void this.tryPlayShared(getSharedLiveKitVideoStream().video)
      else void this.tryPlay()
      this.syncThrottledPlayback()
    } else {
      this.bumpPlayGeneration()
      this.playInFlight = false
      if (!this.usesSharedLiveKit) this.video.pause()
      this.syncThrottledPlayback()
    }
  }

  /**
   * ECS position is almost always stale (default 0, multiplayer sync, VideoEvent lag).
   * Only seek when paused / cold start / explicit user restart — never mid-playback.
   */
  private maybeApplyEcsPosition(
    rawPosition: number | undefined,
    ecsPlaying: boolean,
    ecsPlayingChanged: boolean,
    options?: { fromEcsSync?: boolean; fromUserToggle?: boolean }
  ): void {
    const specPosition = Math.max(rawPosition ?? 0, 0)
    const positionFieldChanged =
      this.lastSpecPosition === undefined || Math.abs(specPosition - this.lastSpecPosition) > 0.05
    if (!positionFieldChanged) {
      if (ecsPlayingChanged) this.lastSpecPosition = this.video.currentTime
      return
    }

    const userToggle = options?.fromUserToggle === true
    // After first frame of playback, ignore ECS position entirely while ECS wants play
    // (threejs.dcl.eth Sync-Components + asset-pack rebroadcast position:0).
    if (ecsPlaying && this.hasStartedPlayback && !userToggle) {
      this.lastSpecPosition = this.video.currentTime
      return
    }
    // While HTML element is playing, never seek (even before hasStartedPlayback settles).
    if (!this.video.paused && !this.video.ended && !userToggle) {
      this.lastSpecPosition = this.video.currentTime
      return
    }

    if (
      Number.isFinite(specPosition) &&
      Math.abs(this.video.currentTime - specPosition) > 0.25
    ) {
      try {
        this.video.currentTime = specPosition
      } catch {
        /* ignore seek before metadata */
      }
    }
    this.lastSpecPosition = specPosition
  }

  dispose(): void {
    this.sourceGeneration++
    this.clearMediaSource()
    this.disposeSpatialSound()
    this.throttledTexture?.dispose()
    this.throttledTexture = null
    this.video.remove()
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
    // Duration-based end is unsafe for HLS/Vimeo (partial duration reports).
    // Only the browser `ended` event is authoritative.
    return this.video.ended === true || this.holdingAtEnd
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
    const gen = ++this.sourceGeneration
    if (!this.bindLiveKitVideo) {
      // Allow applySpec to retry once the scene LiveKit binder is ready.
      this.loadedSrc = ''
      this.liveKitSource = false
      this.usesSharedLiveKit = false
      this.setState(VS_ERROR)
      return
    }

    this.clearMediaSource()
    if (gen !== this.sourceGeneration) return
    this.loadedSrc = src
    this.liveKitSource = true
    this.usesSharedLiveKit = true
    this.holdingAtEnd = false
    this.setState(VS_LOADING)

    const shared = getSharedLiveKitVideoStream()
    const onTrackUpdate = (): void => {
      if (gen !== this.sourceGeneration) return
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
    if (gen !== this.sourceGeneration) {
      this.liveKitCleanup()
      this.liveKitCleanup = null
      return
    }
    onTrackUpdate()
  }

  private async loadSource(url: string): Promise<void> {
    const gen = ++this.sourceGeneration
    const mediaUrl = unwrapMisroutedMediaUrl(url)
    if (mediaUrl !== url) {
      console.warn('[WebVideoPlayer] unwrapped texture-proxy media URL', url, '→', mediaUrl)
    }
    this.clearMediaSource()
    if (gen !== this.sourceGeneration) return
    this.loadedSrc = mediaUrl
    this.hasHadRenderableFrame = false
    this.hasStartedPlayback = false
    this.playInFlight = false
    this.pausedWantingPlaySince = 0
    this.setState(VS_LOADING)

    if (isHlsUrl(mediaUrl)) {
      try {
        const mod = await import('hls.js')
        if (gen !== this.sourceGeneration) return
        const Hls = mod.default as HlsConstructor
        if (Hls.isSupported()) {
          // Vimeo external playlists: fMP4 + separate audio groups. Vite worker URLs
          // break TS demux — keep enableWorker false. Larger buffers help multi-audio.
          const hls = new Hls({
            enableWorker: false,
            lowLatencyMode: false,
            maxBufferLength: 60,
            maxMaxBufferLength: 120,
            backBufferLength: 30,
            startLevel: -1,
            capLevelToPlayerSize: false
          })
          const errorEvent = Hls.Events?.ERROR ?? 'hlsError'
          let mediaErrorRecoveries = 0
          hls.on?.(errorEvent, (_event, data) => {
            if (gen !== this.sourceGeneration) return
            if (!data.fatal) return
            if (data.type === 'mediaError' && mediaErrorRecoveries < 3) {
              mediaErrorRecoveries += 1
              try {
                hls.recoverMediaError?.()
                this.playInFlight = false
                if (this.wantsPlaying && !this.isPlaybackBlocked()) void this.tryPlay()
                return
              } catch {
                /* fall through */
              }
            }
            if (data.type === 'networkError') {
              try {
                hls.startLoad?.(-1)
                return
              } catch {
                /* fall through */
              }
            }
            console.warn('[WebVideoPlayer] HLS fatal error', data.type, data.details, mediaUrl)
            this.setState(VS_ERROR)
          })
          // Auto-start once levels/audio groups are ready (Vimeo multi-audio).
          hls.on?.('hlsManifestParsed', () => {
            if (gen !== this.sourceGeneration) return
            if (this.wantsPlaying && !this.isPlaybackBlocked()) void this.tryPlay()
          })
          hls.attachMedia(this.video)
          hls.loadSource(mediaUrl)
          this.hls = hls
          this.ensureLocalTexture().start()
          return
        }
      } catch (err) {
        if (gen !== this.sourceGeneration) return
        console.warn('[WebVideoPlayer] HLS.js init failed', err, mediaUrl)
      }

      if (gen !== this.sourceGeneration) return
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

    if (gen !== this.sourceGeneration) return
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
    this.playInFlight = false
  }

  private restartFromBeginning(): void {
    this.holdingAtEnd = false
    this.hasStartedPlayback = false
    this.playInFlight = false
    try {
      this.video.currentTime = 0
    } catch {
      /* ignore */
    }
    this.lastSpecPosition = 0
    this.wantsPlaying = true
  }

  private async tryPlay(): Promise<void> {
    if (!this.userGestureUnlocked || this.isPlaybackBlocked() || !this.wantsPlaying) return
    if (this.holdingAtEnd || this.video.ended) return
    // Already playing or a play() promise is in flight — don't abort it.
    if (!this.video.paused && this.state === VS_PLAYING) return
    if (this.playInFlight) return

    this.playInFlight = true
    const gen = ++this.playGeneration
    try {
      await this.video.play()
    } catch (err) {
      if (gen !== this.playGeneration) return
      // AbortError: another pause/load raced — tickPlayback will recover after debounce.
      if (err instanceof DOMException && err.name === 'AbortError') return
      console.warn('[WebVideoPlayer] play() blocked or failed', err, this.loadedSrc)
    } finally {
      if (gen === this.playGeneration) this.playInFlight = false
    }
  }

  /** Push canvas uploads and re-queue materials once the decoder has drawable dimensions. */
  private notifyDrawableFrame(): void {
    const video = this.usesSharedLiveKit ? getSharedLiveKitVideoStream().video : this.video
    if (video.videoWidth > 0 && video.videoHeight > 0) {
      this.hasHadRenderableFrame = true
      if (!this.usesSharedLiveKit) this.throttledTexture?.notifySourceChanged()
    }
    if (this.canAttachTexture()) this.onFrameReady?.()
  }
}