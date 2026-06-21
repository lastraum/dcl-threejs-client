import { clientDebugLog } from '../client/debug/ClientDebugLog'
import { isRemoteAudioClipUrl } from './resolveSceneAudioUrl'

/** Shared decoded clip cache — one fetch/decode per resolved URL. */
export class AudioBufferCache {
  private readonly cache = new Map<string, Promise<AudioBuffer | null>>()

  constructor(private readonly getContext: () => BaseAudioContext) {}

  load(url: string): Promise<AudioBuffer | null> {
    let pending = this.cache.get(url)
    if (!pending) {
      pending = this.fetchAndDecode(url).then((buffer) => {
        if (!buffer) this.cache.delete(url)
        return buffer
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

  private async fetchAndDecode(url: string): Promise<AudioBuffer | null> {
    try {
      const response = await fetch(url, { mode: 'cors', credentials: 'omit', cache: 'force-cache' })
      if (!response.ok) {
        clientDebugLog.log('media', `AudioSource clip fetch failed (${response.status}): ${url}`, {
          level: 'warn',
          alsoConsole: true
        })
        return null
      }

      const bytes = await response.arrayBuffer()
      if (!bytes.byteLength) return null

      const context = this.getContext()
      const copy = bytes.slice(0)
      return await context.decodeAudioData(copy)
    } catch (err) {
      const remote = isRemoteAudioClipUrl(url)
      const reason = err instanceof Error ? err.message : String(err)
      clientDebugLog.log(
        'media',
        remote
          ? `AudioSource remote clip failed (CORS or decode): ${url} — ${reason}`
          : `AudioSource clip decode failed: ${url} — ${reason}`,
        { level: 'warn', alsoConsole: true }
      )
      return null
    }
  }
}