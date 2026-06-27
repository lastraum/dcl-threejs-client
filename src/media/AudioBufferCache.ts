import * as THREE from 'three'

let sessionAudioCache: AudioBufferCache | null = null

export function getSessionAudioBufferCache(): AudioBufferCache {
  if (!sessionAudioCache) sessionAudioCache = new AudioBufferCache()
  return sessionAudioCache
}

export function disposeSessionAudioBufferCache(): void {
  sessionAudioCache?.clear()
  sessionAudioCache = null
}

/** Shared decoded clip cache — one fetch/decode per resolved scene URL. */
export class AudioBufferCache {
  private readonly cache = new Map<string, Promise<AudioBuffer | null>>()
  private readonly loader = new THREE.AudioLoader()

  /** Fire-and-forget decode warmup — safe during scene manifest prefetch. */
  prefetch(urls: string[]): void {
    for (const url of urls) {
      void this.load(url).catch(() => {})
    }
  }

  load(url: string): Promise<AudioBuffer | null> {
    let pending = this.cache.get(url)
    if (!pending) {
      pending = new Promise((resolve) => {
        this.loader.load(
          url,
          (buffer) => resolve(buffer),
          undefined,
          () => resolve(null)
        )
      })
      this.cache.set(url, pending)
    }
    return pending
  }

  evict(url: string): void {
    this.cache.delete(url)
  }

  clear(): void {
    this.cache.clear()
  }
}