/**
 * Offloads GLB network fetch + IndexedDB persist from the main thread.
 * Parsing runs in glbParseWorker — see glbParsePool.ts.
 */
import { deleteGlbBytes, readGlbBytes, writeGlbBytes } from '../rendering/glbByteCache'
import { logNonGlbOnce, prepareGlbBytes } from '../rendering/glbSanitizer'

type FetchRequest = {
  type: 'fetch'
  id: number
  url: string
  key: string
}

type WorkerOutbound =
  | { type: 'fetch-done'; id: number; buffer: ArrayBuffer; fromCache: boolean }
  | { type: 'fetch-error'; id: number; message: string }

const ctx = self as unknown as DedicatedWorkerGlobalScope

async function fetchGlbBytes(url: string, key: string): Promise<{ buffer: ArrayBuffer; fromCache: boolean }> {
  const cached = await readGlbBytes(key)
  if (cached) {
    const prepared = prepareGlbBytes(cached)
    if (prepared) return { buffer: prepared, fromCache: true }
    void deleteGlbBytes(key)
  }

  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`GLB fetch failed (${response.status}): ${key}`)
  }
  const fetched = await response.arrayBuffer()
  const prepared = prepareGlbBytes(fetched)
  if (!prepared) {
    logNonGlbOnce(key)
    throw new Error(`GLB fetch returned non-GLB bytes: ${key}`)
  }
  void writeGlbBytes(key, prepared)
  return { buffer: prepared, fromCache: false }
}

ctx.onmessage = (ev: MessageEvent<FetchRequest>) => {
  const msg = ev.data
  if (msg.type !== 'fetch') return

  void fetchGlbBytes(msg.url, msg.key)
    .then(({ buffer, fromCache }) => {
      ctx.postMessage({ type: 'fetch-done', id: msg.id, buffer, fromCache } satisfies WorkerOutbound, [buffer])
    })
    .catch((err) => {
      const message = err instanceof Error ? err.message : String(err)
      ctx.postMessage({ type: 'fetch-error', id: msg.id, message } satisfies WorkerOutbound)
    })
}
