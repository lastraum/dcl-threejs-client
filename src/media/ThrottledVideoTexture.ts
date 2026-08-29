import * as THREE from 'three'
import { configureSceneVideoTexture } from './videoTextureOrientation'
import {
  SCENE_VIDEO_MAX_FPS,
  SCENE_VIDEO_MAX_HEIGHT,
  SCENE_VIDEO_MAX_WIDTH
} from './sceneVideoLimits'

type VideoWithFrameCallback = HTMLVideoElement & {
  requestVideoFrameCallback: (
    callback: (now: DOMHighResTimeStamp, metadata: VideoFrameCallbackMetadata) => void
  ) => number
  cancelVideoFrameCallback: (handle: number) => void
}

function fitWithin(
  sourceWidth: number,
  sourceHeight: number,
  maxWidth: number,
  maxHeight: number
): { width: number; height: number } {
  const scale = Math.min(1, maxWidth / sourceWidth, maxHeight / sourceHeight)
  return {
    width: Math.max(1, Math.round(sourceWidth * scale)),
    height: Math.max(1, Math.round(sourceHeight * scale))
  }
}

/**
 * Canvas-backed scene video texture — avoids THREE.VideoTexture's per-frame rVFC uploads.
 * Draws the video at most {@link SCENE_VIDEO_MAX_FPS} and caps resolution at 1080p.
 */
export class ThrottledVideoTexture {
  readonly texture: THREE.CanvasTexture
  private readonly canvas: HTMLCanvasElement
  private readonly ctx: CanvasRenderingContext2D
  private readonly minFrameMs: number
  private running = false
  private rvfHandle = 0
  private lastUploadMs = 0
  private rafHandle = 0
  private paintedFrame = false

  constructor(
    private readonly video: HTMLVideoElement,
    maxFps = SCENE_VIDEO_MAX_FPS
  ) {
    this.minFrameMs = 1000 / Math.max(1, maxFps)
    this.canvas = document.createElement('canvas')
    this.canvas.width = 1
    this.canvas.height = 1
    // Do not use `desynchronized: true` — Chrome WebGL texSubImage2D then throws
    // "Overload resolution failed" and plaza HLS/mp4 screens stay black.
    const ctx = this.canvas.getContext('2d', { alpha: false })
    if (!ctx) throw new Error('[ThrottledVideoTexture] 2d context unavailable')
    this.ctx = ctx

    this.texture = new THREE.CanvasTexture(this.canvas)
    this.texture.colorSpace = THREE.SRGBColorSpace
    this.texture.generateMipmaps = false
    this.texture.minFilter = THREE.LinearFilter
    this.texture.magFilter = THREE.LinearFilter
    // glTF video screens (default path) — flipY false; MeshRenderer reconfigures on apply.
    configureSceneVideoTexture(this.texture, false)
    // Internal idle fill only. Do not bind this texture until hasPaintedFrame (or ECS
    // playing=false, which explicitly wants a black screen).
    this.clearToBlack()
  }

  /** True after at least one successful drawImage of decoded video pixels. */
  get hasPaintedFrame(): boolean {
    return this.paintedFrame
  }

  /** Fired the first time a decoded video frame lands on the canvas. */
  onFrameUploaded?: () => void

  start(): void {
    if (this.running) return
    this.running = true
    this.scheduleFrame()
  }

  stop(): void {
    this.running = false
    if (this.rvfHandle !== 0 && 'cancelVideoFrameCallback' in this.video) {
      ;(this.video as VideoWithFrameCallback).cancelVideoFrameCallback(this.rvfHandle)
    }
    this.rvfHandle = 0
    if (this.rafHandle !== 0) {
      cancelAnimationFrame(this.rafHandle)
      this.rafHandle = 0
    }
    // Occupancy / visibility pause: keep last frame. ECS playing=false calls clearToBlack.
  }

  /**
   * Fill the canvas solid black and mark the texture dirty.
   * Used for ECS playing=false / ended / empty src — not for loading or occupancy pause.
   */
  clearToBlack(): void {
    const w = Math.max(1, this.canvas.width)
    const h = Math.max(1, this.canvas.height)
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w
      this.canvas.height = h
    }
    this.ctx.fillStyle = '#000000'
    this.ctx.fillRect(0, 0, w, h)
    this.paintedFrame = false
    this.texture.needsUpdate = true
  }

  /** Called when the underlying video element reports new metadata / track attach. */
  notifySourceChanged(): void {
    if (this.video.videoWidth <= 0 || this.video.videoHeight <= 0) return
    if (this.running) this.uploadFrame(performance.now(), true)
  }

  dispose(): void {
    this.stop()
    this.texture.dispose()
  }

  private scheduleFrame(): void {
    if (!this.running) return
    const video = this.video
    if ('requestVideoFrameCallback' in video) {
      this.rvfHandle = (video as VideoWithFrameCallback).requestVideoFrameCallback((now) => {
        this.rvfHandle = 0
        this.uploadFrame(now)
        this.scheduleFrame()
      })
      return
    }
    this.rafHandle = requestAnimationFrame((now) => {
      this.rafHandle = 0
      this.uploadFrame(now)
      this.scheduleFrame()
    })
  }

  private uploadFrame(nowMs: number, force = false): void {
    const vw = this.video.videoWidth
    const vh = this.video.videoHeight
    if (vw <= 0 || vh <= 0) {
      // No decoded frame yet — keep last pixels (or unbound). Never paint black here.
      return
    }
    if (!force && nowMs - this.lastUploadMs < this.minFrameMs) return
    this.lastUploadMs = nowMs

    const { width, height } = fitWithin(vw, vh, SCENE_VIDEO_MAX_WIDTH, SCENE_VIDEO_MAX_HEIGHT)
    if (width <= 0 || height <= 0) return
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width
      this.canvas.height = height
    }
    try {
      this.ctx.drawImage(this.video, 0, 0, width, height)
    } catch {
      // Closed / 0×0 / CORS video — keep last good frame.
      return
    }
    this.texture.needsUpdate = true
    if (!this.paintedFrame) {
      this.paintedFrame = true
      this.onFrameUploaded?.()
    }
  }
}