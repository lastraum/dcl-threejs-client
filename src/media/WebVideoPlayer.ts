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
  /**
   * Last ECS VideoPlayer.src string (as authored — relative path, https, livekit-video://).
   * Used for change detection. Do NOT compare against resolved CDN URLs or soft-hold
   * reloads thrash every frame (mp4 ↔ m3u8 ↔ LiveKit never “sticks”).
   */
  private loadedEcsSrc = ''
  /** Resolved decoder URL / livekit key actually bound to the element (logging + volume). */
  private loadedSrc = ''
  private liveKitSource = false
  private state: VideoStateValue = VS_NONE
  /**
   * Allows calling `video.play()`. Set optimistically at World.start so decode can
   * begin, and again on real pointer/keyboard gesture.
   */
  private userGestureUnlocked = false
  /**
   * Allows unmuted output. Only set after a real user gesture — browsers block
   * unmuted autoplay, which left Vimeo/HLS screens black forever when we unmuted
   * before activation and then no-op'd the real-gesture path (already unlocked).
   */
  private soundUnlocked = false
  private visibilityPaused = false
  /** Occupancy hold — pause decode, keep texture bound (do not dispose). */
  private occupancyPaused = false
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
  /**
   * Non-spatial progressive: WebAudio graph for AudioAnalysis only.
   * createMediaElementSource can only run once — routes element through THREE.Audio
   * while keeping element muted (same pattern as spatial).
   */
  private analysisSound: THREE.Audio | null = null
  private analysisMediaBound = false
  /** performance.now() when we last observed pause while wanting play. */
  private pausedWantingPlaySince = 0
  onFrameReady?: () => void
  onNaturalEnd?: () => void
  onReplayStarted?: () => void

  get texture(): THREE.Texture {
    // LiveKit only paints while VideoPlayer.playing AND remote frames exist.
    // playing=false / ended / stream-gone → solid black (Explorer parity).
    if (this.shouldPaintLiveKit()) {
      return getSharedLiveKitVideoStream().getTexture() ?? this.ensureLocalTexture().texture
    }
    // Always create local canvas (constructor clears to black) so idle screens bind a map.
    return this.ensureLocalTexture().texture
  }

  /** Paint LiveKit frames only when ECS playing=true and the remote stream has drawable data. */
  private shouldPaintLiveKit(): boolean {
    return (
      this.usesSharedLiveKit &&
      this.wantsPlaying &&
      !this.isPlaybackBlocked() &&
      !this.holdingAtEnd &&
      getSharedLiveKitVideoStream().hasDrawableFrame()
    )
  }

  constructor(
    private readonly scene: ResolvedScene,
    /** Resolve LiveKit binder at load time (may appear after early VideoPlayer create). */
    private readonly resolveLiveKitBinder: () => LiveKitVideoBinder | null = () => null
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
        // Explorer: natural end → black screen (not frozen last frame).
        this.ensureLocalTexture().clearToBlack()
        this.onFrameReady?.()
        this.onNaturalEnd?.()
      }
    })
  }

  setAudioListener(listener: THREE.AudioListener | null): void {
    if (this.listener === listener) return
    this.disposeSpatialSound()
    this.disposeAnalysisSound()
    this.listener = listener
    if (this.spatial && listener) {
      this.sound = this.createSpatialSound(this.spatialMin, this.spatialMax)
      this.bindSpatialMedia()
      this.applyEffectiveVolume()
    }
  }

  /**
   * Explorer parity: progressive / spatial WebAudio paths can feed AudioAnalysis.
   * HLS + LiveKit → false (host writes zeros).
   */
  canProvideAudioAnalysis(): boolean {
    if (this.liveKitSource || this.usesSharedLiveKit) return false
    if (isLiveKitVideoSrc(this.loadedEcsSrc) || isLiveKitVideoSrc(this.loadedSrc)) return false
    if (isHlsUrl(this.loadedEcsSrc) || isHlsUrl(this.loadedSrc)) return false
    return true
  }

  isPlayingForAnalysis(): boolean {
    return (
      this.state === VS_PLAYING &&
      this.wantsPlaying &&
      !this.video.paused &&
      !this.video.ended &&
      !this.isPlaybackBlocked()
    )
  }

  /**
   * THREE.Audio for analyser tap. Spatial uses existing PositionalAudio;
   * non-spatial progressive lazily builds a gain graph so MediaElementSource exists.
   */
  getThreeAudioForAnalysis(): THREE.Audio | null {
    if (!this.canProvideAudioAnalysis()) return null
    if (this.sound) return this.sound
    return this.ensureAnalysisSound()
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
      // MediaElementSource is once-per-element — if analysis already bound, keep that graph
      // (non-positional) rather than throwing on a second setMediaElementSource.
      if (this.analysisMediaBound) {
        this.sound = null
      } else {
        this.sound = this.createSpatialSound(spatialMinDistance, spatialMaxDistance)
        if (parent) this.attachSpatialSound(parent, localTransform)
        this.bindSpatialMedia()
      }
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
    if (this.usesSharedLiveKit) {
      const shared = getSharedLiveKitVideoStream()
      if (shared.hasDrawableFrame()) {
        this.hasHadRenderableFrame = true
        return true
      }
      return this.hasHadRenderableFrame && this.state !== VS_ERROR && !!this.loadedSrc
    }
    const video = this.video
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
    // Idle/black map is always attachable (deactivate / pre-frame).
    if (!this.loadedEcsSrc && !this.loadedSrc) return false
    if (this.state === VS_ERROR) return false
    if (this.shouldPaintLiveKit()) return true
    // Black canvas idle texture for LiveKit deactivated or progressive idle.
    if (this.usesSharedLiveKit || isLiveKitVideoSrc(this.loadedEcsSrc)) {
      return !this.wantsPlaying || !getSharedLiveKitVideoStream().hasDrawableFrame()
    }
    const video = this.video
    // Require real dimensions — HAVE_METADATA alone can bind a 1×1 canvas forever.
    if (video.videoWidth <= 0 || video.videoHeight <= 0) {
      // End-of-video / not playing: black placeholder is valid.
      return !this.wantsPlaying || this.holdingAtEnd
    }
    return (
      video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA ||
      this.hasHadRenderableFrame ||
      this.liveKitSource
    )
  }

  /**
   * Per-frame recovery: re-issue play() only after a short pause debounce so we
   * never stack concurrent play() promises (each aborts the previous).
   * Also recovers shared LiveKit after playing=true / late track attach.
   */
  tickPlayback(): void {
    if (this.isPlaybackBlocked() || !this.wantsPlaying) return
    if (this.usesSharedLiveKit) {
      const video = getSharedLiveKitVideoStream().video
      if (!video.paused && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
        this.pausedWantingPlaySince = 0
        return
      }
      if (!this.userGestureUnlocked) return
      const now = performance.now()
      if (this.pausedWantingPlaySince === 0) {
        this.pausedWantingPlaySince = now
        return
      }
      if (now - this.pausedWantingPlaySince >= 400) {
        this.pausedWantingPlaySince = now
        void this.tryPlayShared(video)
      }
      return
    }
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
    if (this.liveKitSource || this.usesSharedLiveKit) {
      if (!this.isPlaybackBlocked()) void this.issuePlay()
      return
    }
    if (!this.isAtEnd() && !this.holdingAtEnd) return
    this.holdingAtEnd = false
    this.restartFromBeginning()
    this.lastEcsPlaying = true
    this.wantsPlaying = true
    if (!this.isPlaybackBlocked()) void this.issuePlay()
    this.onReplayStarted?.()
  }

  /**
   * @param unlocked - allow play() attempts (World.start may set this early)
   * @param options.allowSound - true only for a real user gesture (pointer/key)
   */
  setUserGestureUnlocked(
    unlocked: boolean,
    options?: { allowSound?: boolean }
  ): void {
    this.userGestureUnlocked = unlocked
    if (unlocked && options?.allowSound) {
      this.soundUnlocked = true
      this.applyEffectiveVolume()
    }
    if (unlocked && this.wantsPlaying && !this.isPlaybackBlocked()) {
      // Must hit shared LiveKit element after playing becomes true — never the idle local video.
      void this.issuePlay()
    }
  }

  /** Route play() to the active decoder (local progressive/HLS vs shared LiveKit). */
  private issuePlay(): void {
    if (this.usesSharedLiveKit) {
      void this.tryPlayShared(getSharedLiveKitVideoStream().video)
    } else {
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

  setOccupancyPaused(paused: boolean): void {
    if (this.occupancyPaused === paused) return
    this.occupancyPaused = paused
    this.syncPlaybackPause()
  }

  applySpec(
    spec: PBVideoPlayer,
    options?: {
      fromEcsSync?: boolean
      fromUserToggle?: boolean
      /** Scene LiveKit has remote video (stream-key ingress and/or Cast speakers). */
      liveKitRemoteLive?: boolean
    }
  ): void {
    const ecsPlaying = spec.playing !== false
    const ecsPlayingChanged =
      this.lastEcsPlaying !== undefined && ecsPlaying !== this.lastEcsPlaying
    // Apply play intent before any LiveKit bind so subscribe callbacks see playing state.
    this.wantsPlaying = ecsPlaying
    this.lastEcsPlaying = ecsPlaying

    if (
      !this.liveKitSource &&
      !this.usesSharedLiveKit &&
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

    const remoteLive = options?.liveKitRemoteLive === true
    const ecsSrc = (spec.src ?? '').trim()
    // Empty src is always authoritative (Admin Deactivate). While a LiveKit remote
    // is live, refuse non-empty VOD/defaultURL overwrites of an already-activated
    // current-stream — late CRDT / MessageBus defaultURL thrash otherwise blacks
    // guests mid-stream. Never auto-promote non-LiveKit screens onto LiveKit.
    const softHoldLiveKit =
      (this.liveKitSource || this.usesSharedLiveKit || isLiveKitCurrentStreamSrc(this.loadedEcsSrc)) &&
      remoteLive &&
      !!ecsSrc &&
      !isLiveKitVideoSrc(ecsSrc)
    const effectiveSrc = softHoldLiveKit
      ? this.loadedEcsSrc || LIVEKIT_CURRENT_STREAM_SRC
      : ecsSrc

    // Compare ECS-authored effective src only — resolved CDN URLs must not re-trigger load every frame.
    const srcChanged = effectiveSrc !== this.loadedEcsSrc
    if (effectiveSrc && srcChanged) {
      const from = this.loadedEcsSrc || '(none)'
      console.info(
        `[WebVideoPlayer] src change ${shortSrc(from)} → ${shortSrc(effectiveSrc)}${softHoldLiveKit ? ' (soft-hold live)' : ''}`
      )
      this.loadedEcsSrc = effectiveSrc
      if (isLiveKitVideoSrc(effectiveSrc)) {
        if (isLiveKitCurrentStreamSrc(effectiveSrc)) {
          // Bind LiveKit only while playing=true — idle stays black.
          if (ecsPlaying) void this.loadLiveKitSource(effectiveSrc)
          else {
            this.liveKitSource = true
            this.usesSharedLiveKit = false
            this.loadedSrc = ''
            this.paintIdleBlack()
          }
        } else {
          this.clearMediaSource()
          this.paintIdleBlack()
          this.setState(VS_ERROR)
        }
      } else {
        const url = resolveSceneMediaUrl(effectiveSrc, this.scene)
        if (url) void this.loadSource(url)
        else {
          this.clearMediaSource()
          this.paintIdleBlack()
          this.setState(VS_ERROR)
        }
      }
    } else if (!effectiveSrc) {
      // Empty src = stop (Admin Deactivate for Stream/URL panels).
      if (this.loadedEcsSrc || this.loadedSrc || this.usesSharedLiveKit) {
        this.clearMediaSource()
      }
      this.paintIdleBlack()
      this.setState(VS_NONE)
    }

    this.video.loop = !this.liveKitSource && !isLiveKitVideoSrc(this.loadedEcsSrc) && spec.loop === true
    this.lastSpecVolume = spec.volume ?? 1
    this.applyEffectiveVolume()
    if (this.spatial) {
      this.applySpatialDistances(spec.spatialMinDistance ?? 0, spec.spatialMaxDistance ?? 60)
    }
    this.video.playbackRate = Math.max(spec.playbackRate ?? 1, 0.01)

    if (!this.liveKitSource && !this.usesSharedLiveKit) {
      this.maybeApplyEcsPosition(spec.position, ecsPlaying, ecsPlayingChanged, options)
    }

    if (this.isPlaybackBlocked()) {
      this.paintIdleBlack()
      return
    }

    if (ecsPlaying) {
      // Only hold when the browser truly finished (video.ended). Never use partial duration.
      if (!this.liveKitSource && !this.usesSharedLiveKit && this.video.ended && !ecsPlayingChanged) {
        this.holdingAtEnd = true
        this.wantsPlaying = false
        this.bumpPlayGeneration()
        this.paintIdleBlack()
        return
      }
      // playing flipped true: re-bind LiveKit if we only kept the ECS src key.
      if (
        isLiveKitCurrentStreamSrc(this.loadedEcsSrc) &&
        (!this.usesSharedLiveKit || !this.sharedLiveKitUnsubscribe)
      ) {
        void this.loadLiveKitSource(this.loadedEcsSrc)
      }
      // Always re-issue play on the correct element (shared LiveKit vs progressive/HLS).
      void this.issuePlay()
      this.syncThrottledPlayback()
      // Rebind materials — may switch black idle → live VideoTexture.
      this.onFrameReady?.()
    } else {
      // playing=false: stop paint + decode/audio. Explorer black screen.
      this.bumpPlayGeneration()
      this.playInFlight = false
      this.holdingAtEnd = false
      if (this.usesSharedLiveKit || (this.liveKitSource && isLiveKitCurrentStreamSrc(this.loadedEcsSrc))) {
        this.detachLiveKitKeepSrc()
      } else {
        this.video.pause()
      }
      this.syncThrottledPlayback()
      this.paintIdleBlack()
    }
  }

  /** Solid black screen map + material rebind (deactivate / end / stream gone). */
  private paintIdleBlack(): void {
    this.ensureLocalTexture().clearToBlack()
    this.setState(VS_PAUSED)
    this.onFrameReady?.()
  }

  /**
   * Drop LiveKit subscribe/attach but keep ECS src so playing=true can re-bind without
   * thrashing soft-hold / defaultURL logic.
   */
  private detachLiveKitKeepSrc(): void {
    const ecsKey = this.loadedEcsSrc
    this.sharedLiveKitUnsubscribe?.()
    this.sharedLiveKitUnsubscribe = null
    this.liveKitCleanup?.()
    this.liveKitCleanup = null
    this.usesSharedLiveKit = false
    this.loadedSrc = ''
    this.liveKitSource = isLiveKitVideoSrc(ecsKey)
    this.hasHadRenderableFrame = false
    this.hasStartedPlayback = false
    this.playInFlight = false
    this.pausedWantingPlaySince = 0
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
    this.disposeAnalysisSound()
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
    return this.visibilityPaused || this.budgetPaused || this.occupancyPaused
  }

  private syncPlaybackPause(): void {
    if (this.isPlaybackBlocked()) {
      this.bumpPlayGeneration()
      if (this.usesSharedLiveKit) {
        // Visibility/budget pause: drop paint (other screens may still be subscribed).
        this.paintIdleBlack()
      } else {
        this.video.pause()
        this.paintIdleBlack()
      }
      this.syncThrottledPlayback()
    } else if (this.wantsPlaying) {
      if (
        isLiveKitCurrentStreamSrc(this.loadedEcsSrc) &&
        (!this.usesSharedLiveKit || !this.sharedLiveKitUnsubscribe)
      ) {
        void this.loadLiveKitSource(this.loadedEcsSrc)
      }
      void this.issuePlay()
      this.syncThrottledPlayback()
      this.onFrameReady?.()
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
      // Spatial path always mutes the element (audio via THREE.PositionalAudio).
      // PositionalAudio still needs a user gesture to start — keep gain 0 until then.
      const gain = this.soundUnlocked
        ? clamp(spatialAudioGain(category, this.lastSpecVolume), 0, 1)
        : 0
      this.video.volume = 0
      this.video.muted = true
      this.sound.setVolume(gain)
      this.analysisSound?.setVolume(0)
    } else if (this.analysisSound && this.analysisMediaBound) {
      // Non-spatial analysis path — element muted; gain on THREE.Audio.
      const gain = this.soundUnlocked
        ? clamp(mediaElementGain(category, this.lastSpecVolume), 0, 1)
        : 0
      this.video.volume = 0
      this.video.muted = true
      this.analysisSound.setVolume(gain)
      this.sound?.setVolume(0)
    } else {
      const gain = clamp(mediaElementGain(category, this.lastSpecVolume), 0, 1)
      // Stay muted until a real gesture so autoplay is allowed and frames upload.
      if (!this.soundUnlocked) {
        this.video.muted = true
        this.video.volume = 0
      } else {
        this.video.muted = false
        this.video.volume = gain
      }
      this.sound?.setVolume(0)
      this.analysisSound?.setVolume(0)
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

  private ensureAnalysisSound(): THREE.Audio | null {
    if (!this.listener) return null
    if (this.analysisSound) return this.analysisSound
    try {
      const audio = new THREE.Audio(this.listener)
      // First MediaElementSource wins — only when spatial sound is absent.
      if (!this.analysisMediaBound && !this.sound) {
        audio.setMediaElementSource(this.video)
        this.analysisMediaBound = true
        // Element no longer drives speakers; THREE gain does (match spatial mute pattern).
        this.video.muted = true
        this.video.volume = 0
      }
      this.analysisSound = audio
      this.applyEffectiveVolume()
      return audio
    } catch (err) {
      console.warn('[WebVideoPlayer] analysis audio bind failed', err)
      return null
    }
  }

  private disposeAnalysisSound(): void {
    if (!this.analysisSound) return
    this.analysisSound.disconnect()
    this.analysisSound = null
    // analysisMediaBound stays true for this element lifetime (MediaElementSource once).
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
      // stop() clears canvas to black — avoids stale frame when switching mp4 ↔ m3u8.
      this.throttledTexture?.stop()
      this.video.pause()
      this.video.srcObject = null
      this.video.removeAttribute('src')
      this.video.load()
      this.throttledTexture?.clearToBlack()
    }
    this.loadedSrc = ''
    this.loadedEcsSrc = ''
    this.liveKitSource = false
    this.usesSharedLiveKit = false
    this.hasHadRenderableFrame = false
    this.hasStartedPlayback = false
    this.holdingAtEnd = false
    this.playInFlight = false
    this.pausedWantingPlaySince = 0
  }

  private async loadLiveKitSource(src: string): Promise<void> {
    const gen = ++this.sourceGeneration
    const binder = this.resolveLiveKitBinder()
    if (!binder) {
      // Binder / scene room often appears after the first VideoPlayer apply (guest
      // late join, landing→play handoff). Stay in LOADING and keep loadedEcsSrc so
      // the next ecsPlaying pass retries — VS_ERROR made screens look permanently dead.
      this.loadedSrc = ''
      this.liveKitSource = true
      this.usesSharedLiveKit = false
      this.setState(VS_LOADING)
      return
    }

    // Preserve ECS src across clear (clearMediaSource wipes loadedEcsSrc).
    const ecsKey = src
    this.clearMediaSource()
    if (gen !== this.sourceGeneration) return
    this.loadedEcsSrc = ecsKey
    this.loadedSrc = src
    this.liveKitSource = true
    this.usesSharedLiveKit = true
    this.holdingAtEnd = false
    this.setState(VS_LOADING)

    const shared = getSharedLiveKitVideoStream()
    const onTrackUpdate = (): void => {
      if (gen !== this.sourceGeneration) return
      // playing=false while bound — paint black, do not promote live texture.
      if (!this.wantsPlaying || this.isPlaybackBlocked()) {
        this.paintIdleBlack()
        return
      }
      if (shared.hasDrawableFrame()) {
        if (this.state !== VS_ERROR) {
          this.setState(shared.video.paused ? VS_READY : VS_PLAYING)
        }
        this.hasHadRenderableFrame = true
        // Live frames → rebind materials from idle black to VideoTexture.
        this.onFrameReady?.()
      } else {
        // Stream ended / unpublished while still playing=true — black screen.
        this.hasHadRenderableFrame = false
        this.paintIdleBlack()
      }
      // Track may attach after the first play attempt (OBS/ingress lag).
      if (this.wantsPlaying && !this.isPlaybackBlocked()) void this.issuePlay()
    }

    this.sharedLiveKitUnsubscribe = shared.subscribe(binder, onTrackUpdate)
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
    // Preserve ECS key — clearMediaSource resets loadedEcsSrc; applySpec already set it.
    const ecsKey = this.loadedEcsSrc
    this.clearMediaSource()
    if (gen !== this.sourceGeneration) return
    this.loadedEcsSrc = ecsKey
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
            if (this.wantsPlaying && !this.isPlaybackBlocked()) void this.issuePlay()
          })
          hls.attachMedia(this.video)
          hls.loadSource(mediaUrl)
          this.hls = hls
          this.ensureLocalTexture().start()
          // Optimistic play — tickPlayback recovers if blocked until metadata.
          if (this.wantsPlaying && !this.isPlaybackBlocked()) void this.issuePlay()
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
        if (this.wantsPlaying && !this.isPlaybackBlocked()) void this.issuePlay()
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
    // Progressive CDN / mp4 after admin switch — kick play once the element has a src.
    if (this.wantsPlaying && !this.isPlaybackBlocked()) void this.issuePlay()
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
      // LiveKit element must stay muted for autoplay; volume is via separate audio track / settings.
      video.muted = true
      video.playsInline = true
      video.autoplay = true
      await video.play()
      if (video.videoWidth > 0) {
        this.hasHadRenderableFrame = true
        this.setState(VS_PLAYING)
        this.onFrameReady?.()
      }
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
      // Ensure muted autoplay path when sound is not yet unlocked (Chrome policy).
      if (!this.soundUnlocked && !this.spatial) {
        this.video.muted = true
      }
      await this.video.play()
    } catch (err) {
      if (gen !== this.playGeneration) return
      // AbortError: another pause/load raced — tickPlayback will recover after debounce.
      if (err instanceof DOMException && err.name === 'AbortError') return
      // Last-ditch: force mute and retry once (covers race where applyEffectiveVolume unmuted).
      if (err instanceof DOMException && err.name === 'NotAllowedError' && !this.video.muted) {
        this.video.muted = true
        try {
          await this.video.play()
          return
        } catch (retryErr) {
          if (gen !== this.playGeneration) return
          if (retryErr instanceof DOMException && retryErr.name === 'AbortError') return
          console.warn('[WebVideoPlayer] play() blocked or failed', retryErr, this.loadedSrc)
          return
        }
      }
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

function shortSrc(src: string): string {
  if (src.length <= 64) return src
  return `${src.slice(0, 40)}…${src.slice(-16)}`
}