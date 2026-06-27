import * as THREE from 'three'
import type { LiveKitVideoBinder } from './WebVideoPlayer'
import { ThrottledVideoTexture } from './ThrottledVideoTexture'

type Subscriber = {
  onUpdate?: () => void
}

/**
 * Single HTMLVideoElement + LiveKit bind for every `livekit-video://current-stream` screen.
 * Genesis Plaza theatre maps many meshes to one decoder / one throttled texture upload path.
 */
class SharedLiveKitVideoStream {
  readonly video: HTMLVideoElement
  private throttled: ThrottledVideoTexture | null = null
  private liveKitCleanup: (() => void) | null = null
  private readonly subscribers = new Set<Subscriber>()

  constructor() {
    this.video = document.createElement('video')
    this.video.crossOrigin = 'anonymous'
    this.video.playsInline = true
    this.video.preload = 'auto'
    this.video.muted = true
    this.video.style.cssText =
      'position:fixed;left:-9999px;top:-9999px;width:1px;height:1px;opacity:0;pointer-events:none'
    document.body.appendChild(this.video)
  }

  subscribe(binder: LiveKitVideoBinder, onUpdate?: () => void): () => void {
    const subscriber: Subscriber = { onUpdate }
    const wasEmpty = this.subscribers.size === 0
    this.subscribers.add(subscriber)

    if (wasEmpty) {
      this.throttled = new ThrottledVideoTexture(this.video)
      this.liveKitCleanup = binder(this.video, () => {
        this.throttled?.notifySourceChanged()
        for (const sub of this.subscribers) sub.onUpdate?.()
      })
      this.throttled.start()
    }

    return () => {
      this.subscribers.delete(subscriber)
      if (this.subscribers.size === 0) this.teardown()
    }
  }

  getTexture(): THREE.Texture | null {
    return this.throttled?.texture ?? null
  }

  private teardown(): void {
    this.liveKitCleanup?.()
    this.liveKitCleanup = null
    this.throttled?.dispose()
    this.throttled = null
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