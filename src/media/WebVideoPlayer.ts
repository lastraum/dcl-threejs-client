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
import { resolveSceneTextureUrl } from '../bridge/material/resolveTexture'
import type { ResolvedScene } from '../dcl/content/types'
import { configureSceneVideoTexture } from './videoTextureOrientation'

type HlsInstance = {
  loadSource(url: string): void
  attachMedia(video: HTMLMediaElement): void
  destroy(): void
}

function isHlsUrl(url: string): boolean {
  if (/\.m3u8(\?|#|$)/i.test(url)) return true
  // Stream manifests without a static file extension (not raw Catalyst content hashes).
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
  readonly texture: THREE.VideoTexture

  private hls: HlsInstance | null = null
  private loadedSrc = ''
  private state: VideoStateValue = VS_NONE
  private userGestureUnlocked = false
  private visibilityPaused = false
  private wantsPlaying = true
  private playGeneration = 0
  private hasHadRenderableFrame = false
  /** Last `spec.position` applied — ignore stale position=0 on play/pause toggles. */
  private lastSpecPosition: number | undefined
  /** Last `spec.playing` from ECS — used to ignore stale position on play/pause toggles. */
  private lastEcsPlaying: boolean | undefined
  onFrameReady?: () => void
  /** Fired when playback reaches the end (non-looping). */
  onNaturalEnd?: () => void

  constructor(private readonly scene: ResolvedScene) {
    this.video = document.createElement('video')
    this.video.crossOrigin = 'anonymous'
    this.video.playsInline = true
    this.video.preload = 'auto'
    this.video.style.cssText = 'position:fixed;left:-9999px;top:-9999px;width:1px;height:1px;opacity:0;pointer-events:none'
    document.body.appendChild(this.video)

    this.texture = new THREE.VideoTexture(this.video)
    this.texture.colorSpace = THREE.SRGBColorSpace
    this.texture.generateMipmaps = false
    this.texture.minFilter = THREE.LinearFilter
    this.texture.magFilter = THREE.LinearFilter
    configureSceneVideoTexture(this.texture)

    this.video.addEventListener('loadstart', () => this.setState(VS_LOADING))
    this.video.addEventListener('loadeddata', () => {
      if (this.state !== VS_ERROR) this.setState(VS_READY)
      this.onFrameReady?.()
    })
    this.video.addEventListener('canplay', () => {
      if (this.state !== VS_ERROR && !this.video.paused) return
      if (this.state !== VS_ERROR) this.setState(VS_READY)
    })
    this.video.addEventListener('playing', () => this.setState(VS_PLAYING))
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
      if (this.wantsPlaying && !this.visibilityPaused) {
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
      if (!this.video.loop) this.onNaturalEnd?.()
    })
  }

  getVideoState(): VideoStateValue {
    return this.state
  }

  getCurrentOffset(): number {
    const t = this.video.currentTime
    return Number.isFinite(t) ? t : 0
  }

  getVideoLength(): number {
    const d = this.video.duration
    return Number.isFinite(d) ? d : 0
  }

  /** Avoid texImage2D before first frame; keep texture during brief buffering gaps. */
  hasRenderableFrame(): boolean {
    if (this.video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
      this.hasHadRenderableFrame = true
      return true
    }
    return this.hasHadRenderableFrame && this.state !== VS_ERROR && !!this.loadedSrc
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
      this.video.pause()
    } else if (this.wantsPlaying) {
      void this.tryPlay()
    }
  }

  applySpec(spec: PBVideoPlayer, options?: { fromEcsSync?: boolean }): void {
    const ecsPlaying = spec.playing !== false
    const ecsPlayingChanged =
      this.lastEcsPlaying !== undefined && ecsPlaying !== this.lastEcsPlaying

    // User toggle after natural end — worker may still have playing=true (toggle sends false).
    if (!options?.fromEcsSync && this.shouldReplayAfterEnd(ecsPlaying, ecsPlayingChanged)) {
      this.restartFromBeginning()
      this.lastEcsPlaying = ecsPlaying
      if (!this.visibilityPaused) void this.tryPlay()
      return
    }

    const url = resolveSceneTextureUrl(spec.src, this.scene)
    if (url && url !== this.loadedSrc) {
      void this.loadSource(url)
    } else if (!url && spec.src.trim()) {
      this.setState(VS_ERROR)
    }

    this.video.loop = spec.loop === true
    this.video.volume = clamp(spec.volume ?? 1, 0, 1)
    this.video.playbackRate = Math.max(spec.playbackRate ?? 1, 0.01)

    const specPosition = Math.max(spec.position ?? 0, 0)
    const positionFieldChanged =
      this.lastSpecPosition === undefined || Math.abs(specPosition - this.lastSpecPosition) > 0.05
    if (positionFieldChanged) {
      const staleZeroOnPlayToggle =
        ecsPlayingChanged &&
        specPosition < 0.05 &&
        this.video.currentTime > 0.5
      if (
        !staleZeroOnPlayToggle &&
        Number.isFinite(specPosition) &&
        Math.abs(this.video.currentTime - specPosition) > 0.25
      ) {
        this.video.currentTime = specPosition
      }
      this.lastSpecPosition = specPosition
    }

    this.wantsPlaying = ecsPlaying
    if (!options?.fromEcsSync) {
      this.lastEcsPlaying = ecsPlaying
    }

    if (this.visibilityPaused) return

    if (ecsPlaying) {
      // Stale ECS playing=true after natural end — hold last frame until user toggles.
      if (this.isAtEnd() && !ecsPlayingChanged) {
        this.wantsPlaying = false
        this.bumpPlayGeneration()
        this.video.pause()
        return
      }
      void this.tryPlay()
    } else {
      this.bumpPlayGeneration()
      this.video.pause()
    }
  }

  dispose(): void {
    this.hls?.destroy()
    this.hls = null
    this.video.pause()
    this.video.removeAttribute('src')
    this.video.load()
    this.texture.dispose()
    this.video.remove()
  }

  private setState(next: VideoStateValue): void {
    this.state = next
  }

  private async loadSource(url: string): Promise<void> {
    this.loadedSrc = url
    this.hasHadRenderableFrame = false
    this.setState(VS_LOADING)

    this.hls?.destroy()
    this.hls = null
    this.bumpPlayGeneration()
    this.video.pause()
    this.video.removeAttribute('src')
    this.video.load()

    if (isHlsUrl(url) && !safariNativeHls(this.video)) {
      try {
        const mod = await import('hls.js')
        const Hls = mod.default
        if (!Hls.isSupported()) {
          this.setState(VS_ERROR)
          return
        }
        const hls = new Hls() as HlsInstance
        hls.attachMedia(this.video)
        hls.loadSource(url)
        this.hls = hls
      } catch {
        this.setState(VS_ERROR)
      }
      return
    }

    this.video.src = url
    this.video.load()
  }

  private bumpPlayGeneration(): void {
    this.playGeneration++
  }

  /** Bridge dedup bypass when a user toggle should replay from the end. */
  needsReplayAfterEnd(ecsPlaying: boolean, playingChanged: boolean): boolean {
    return this.shouldReplayAfterEnd(ecsPlaying, playingChanged)
  }

  private shouldReplayAfterEnd(ecsPlaying: boolean, ecsPlayingChanged: boolean): boolean {
    if (!this.isAtEnd() || !ecsPlayingChanged) return false
    if (ecsPlaying) return true
    return this.lastEcsPlaying === true
  }

  private isAtEnd(): boolean {
    if (this.video.ended) return true
    const duration = this.video.duration
    if (!Number.isFinite(duration) || duration <= 0) return false
    return this.video.currentTime >= duration - 0.35
  }

  private restartFromBeginning(): void {
    this.video.currentTime = 0
    this.lastSpecPosition = 0
    this.wantsPlaying = true
  }

  private async tryPlay(): Promise<void> {
    if (!this.userGestureUnlocked || this.visibilityPaused || !this.wantsPlaying) return
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
