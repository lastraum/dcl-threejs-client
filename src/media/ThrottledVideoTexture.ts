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

  constructor(
    private readonly video: HTMLVideoElement,
    maxFps = SCENE_VIDEO_MAX_FPS
  ) {
    this.minFrameMs = 1000 / Math.max(1, maxFps)
    this.canvas = document.createElement('canvas')
    this.canvas.width = 1
    this.canvas.height = 1
    const ctx = this.canvas.getContext('2d', { alpha: false, desynchronized: true })
    if (!ctx) throw new Error('[ThrottledVideoTexture] 2d context unavailable')
    this.ctx = ctx

    this.texture = new THREE.CanvasTexture(this.canvas)
    this.texture.colorSpace = THREE.SRGBColorSpace
    this.texture.generateMipmaps = false
    this.texture.minFilter = THREE.LinearFilter
    this.texture.magFilter = THREE.LinearFilter
    configureSceneVideoTexture(this.texture)
  }

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
  }

  /** Called when the underlying video element reports new metadata / track attach. */
  notifySourceChanged(): void {
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
    if (vw <= 0 || vh <= 0) return
    if (!force && nowMs - this.lastUploadMs < this.minFrameMs) return
    this.lastUploadMs = nowMs

    const { width, height } = fitWithin(vw, vh, SCENE_VIDEO_MAX_WIDTH, SCENE_VIDEO_MAX_HEIGHT)
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width
      this.canvas.height = height
    }
    this.ctx.drawImage(this.video, 0, 0, width, height)
    this.texture.needsUpdate = true
  }
}