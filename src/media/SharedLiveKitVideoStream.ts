import * as THREE from 'three'
import type { LiveKitVideoBinder } from './WebVideoPlayer'
import { configureSceneVideoTexture, guardVideoTextureUploads } from './videoTextureOrientation'

type Subscriber = {
  onUpdate?: () => void
}

/**
 * Single HTMLVideoElement + LiveKit bind for every `livekit-video://current-stream` screen.
 *
 * Uses THREE.VideoTexture (not canvas drawImage). MediaStream / WebRTC frames often
 * skip requestVideoFrameCallback on off-screen elements — VideoTexture is updated by
 * the WebGLRenderer every frame when the element has HAVE_CURRENT_DATA.
 */
class SharedLiveKitVideoStream {
  readonly video: HTMLVideoElement
  private videoTexture: THREE.VideoTexture | null = null
  private liveKitCleanup: (() => void) | null = null
  private readonly subscribers = new Set<Subscriber>()
  private drawableListenersAttached = false

  constructor() {
    this.video = document.createElement('video')
    // Do NOT set crossOrigin for LiveKit MediaStream tracks — companion cast leaves it unset.
    this.video.playsInline = true
    this.video.autoplay = true
    this.video.muted = true
    this.video.preload = 'auto'
    this.video.setAttribute('playsinline', '')
    this.video.setAttribute('webkit-playsinline', '')
    // Keep in-DOM (some browsers stall decode on detached elements). Off-screen is fine.
    this.video.style.cssText =
      'position:fixed;left:-9999px;top:-9999px;width:16px;height:9px;opacity:0;pointer-events:none'
    document.body.appendChild(this.video)
  }

  subscribe(binder: LiveKitVideoBinder, onUpdate?: () => void): () => void {
    const subscriber: Subscriber = { onUpdate }
    const wasEmpty = this.subscribers.size === 0
    this.subscribers.add(subscriber)

    if (wasEmpty) {
      this.ensureVideoTexture()
      this.attachDrawableListeners()
      this.liveKitCleanup = binder(this.video, () => this.notifySubscribers())
      void this.video.play().catch(() => {})
    }

    return () => {
      this.subscribers.delete(subscriber)
      if (this.subscribers.size === 0) {
        // Last screen with playing=true unsubscribed — stop decode/audio.
        this.teardown()
      }
    }
  }

  getTexture(): THREE.Texture | null {
    return this.videoTexture
  }

  /** True once the LiveKit element has decoded at least one frame with real dimensions. */
  hasDrawableFrame(): boolean {
    return this.video.videoWidth > 0 && this.video.videoHeight > 0
  }

  private ensureVideoTexture(): THREE.VideoTexture {
    if (this.videoTexture) return this.videoTexture
    const tex = new THREE.VideoTexture(this.video)
    tex.colorSpace = THREE.SRGBColorSpace
    tex.generateMipmaps = false
    tex.minFilter = THREE.LinearFilter
    tex.magFilter = THREE.LinearFilter
    // MeshRenderer reconfigures flipY on material apply; default false for glTF screens.
    configureSceneVideoTexture(tex, false)
    guardVideoTextureUploads(tex, this.video)
    this.videoTexture = tex
    return tex
  }

  private attachDrawableListeners(): void {
    if (this.drawableListenersAttached) return
    this.drawableListenersAttached = true
    const onDrawable = (): void => this.notifySubscribers()
    this.video.addEventListener('loadedmetadata', onDrawable)
    this.video.addEventListener('loadeddata', onDrawable)
    this.video.addEventListener('resize', onDrawable)
    this.video.addEventListener('playing', onDrawable)
  }

  private notifySubscribers(): void {
    if (this.videoTexture && this.hasDrawableFrame()) {
      this.videoTexture.needsUpdate = true
    }
    for (const sub of this.subscribers) sub.onUpdate?.()
  }

  private teardown(): void {
    this.liveKitCleanup?.()
    this.liveKitCleanup = null
    this.videoTexture?.dispose()
    this.videoTexture = null
    this.video.pause()
    this.video.srcObject = null
    this.video.removeAttribute('src')
  }
}

let sharedStream: SharedLiveKitVideoStream | null = null

export function getSharedLiveKitVideoStream(): SharedLiveKitVideoStream {
  if (!sharedStream) sharedStream = new SharedLiveKitVideoStream()
  return sharedStream
}
