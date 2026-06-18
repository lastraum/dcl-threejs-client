import * as THREE from 'three'

/** Shared decoded clip cache — one fetch/decode per resolved scene URL. */
export class AudioBufferCache {
  private readonly cache = new Map<string, Promise<AudioBuffer | null>>()
  private readonly loader = new THREE.AudioLoader()

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