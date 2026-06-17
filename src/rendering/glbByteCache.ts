/**
 * Persistent GLB byte cache (IndexedDB).
 *
 * Stores raw ArrayBuffers keyed by content hash — never parsed Three.js objects.
 * Parsing + shared GPU resources stay in AssetCache; colliders clone geometry per
 * instance before PhysX cook (`GltfColliderExtractor.ensureIndexedGeometry`).
 */
const DB_NAME = 'dcl-client-glb-cache'
const DB_VERSION = 1
const STORE = 'glbs'

const CONTENT_HASH_RE = /^(bafy|bafkre|Qm)[\w-]+$/i
const CONTENT_HASH_IN_URL_RE = /\/contents\/([^/?#]+)/i

let dbPromise: Promise<IDBDatabase> | null = null
const loggedKeys = new Set<string>()

/** Stable storage key — always prefer Catalyst content hash over full URL. */
export function normalizeGlbCacheKey(keyOrHashOrUrl: string): string {
  const trimmed = keyOrHashOrUrl.trim()
  if (!trimmed) return trimmed
  const fromUrl = trimmed.match(CONTENT_HASH_IN_URL_RE)?.[1]
  if (fromUrl) return decodeURIComponent(fromUrl)
  if (CONTENT_HASH_RE.test(trimmed)) return trimmed
  return trimmed.split('?')[0]!.split('#')[0]!
}

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      dbPromise = null
      reject(new Error('IndexedDB unavailable'))
      return
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE)
      }
    }
    req.onsuccess = () => {
      const db = req.result
      db.onversionchange = () => {
        db.close()
        dbPromise = null
      }
      resolve(db)
    }
    req.onerror = () => {
      dbPromise = null
      reject(req.error ?? new Error('IndexedDB open failed'))
    }
  })
  return dbPromise
}

function toArrayBuffer(value: unknown): ArrayBuffer | null {
  if (value instanceof ArrayBuffer) return value
  if (ArrayBuffer.isView(value)) {
    const view = value as ArrayBufferView
    const slice = view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength)
    return slice instanceof ArrayBuffer ? slice : null
  }
  return null
}

function withStore<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(STORE, mode)
        const store = tx.objectStore(STORE)
        const req = fn(store)
        let settled = false
        const fail = (err: unknown) => {
          if (settled) return
          settled = true
          reject(err instanceof Error ? err : new Error(String(err)))
        }
        req.onerror = () => fail(req.error ?? new Error('IndexedDB request failed'))
        tx.oncomplete = () => {
          if (settled) return
          settled = true
          resolve(req.result as T)
        }
        tx.onerror = () => fail(tx.error ?? new Error('IndexedDB transaction failed'))
        tx.onabort = () => fail(tx.error ?? new Error('IndexedDB transaction aborted'))
      })
  )
}

function logOnce(key: string, message: string): void {
  if (loggedKeys.has(key)) return
  loggedKeys.add(key)
  console.debug(`[glbByteCache] ${message}`, key.slice(0, 20))
}

/** Drop a corrupt or superseded entry so the next load re-fetches from network. */
export async function deleteGlbBytes(key: string): Promise<void> {
  const storageKey = normalizeGlbCacheKey(key)
  if (!storageKey) return
  try {
    await withStore('readwrite', (store) => store.delete(storageKey))
  } catch {
    /* best-effort */
  }
}

/** Read cached GLB bytes. Returns null on miss or IDB failure. */
export async function readGlbBytes(key: string): Promise<ArrayBuffer | null> {
  const storageKey = normalizeGlbCacheKey(key)
  if (!storageKey) return null
  try {
    const hit = await withStore('readonly', (store) => store.get(storageKey))
    const buffer = toArrayBuffer(hit)
    if (buffer?.byteLength) {
      return buffer
    }
    logOnce(storageKey, 'miss')
    return null
  } catch (err) {
    logOnce(storageKey, `read failed — ${err instanceof Error ? err.message : String(err)}`)
    return null
  }
}

/** Persist GLB bytes after a successful network fetch. Best-effort — never throws. */
export async function writeGlbBytes(key: string, buffer: ArrayBuffer): Promise<void> {
  const storageKey = normalizeGlbCacheKey(key)
  if (!storageKey || !buffer?.byteLength) return
  try {
    // Copy so GLTF parsing cannot race the structured-clone put.
    const copy = buffer.slice(0)
    await withStore('readwrite', (store) => store.put(copy, storageKey))
    logOnce(`${storageKey}:stored`, `stored (${(copy.byteLength / 1024).toFixed(0)} KB)`)
  } catch (err) {
    if (err instanceof DOMException && err.name === 'QuotaExceededError') {
      console.warn('[glbByteCache] quota exceeded — skipping persist for', storageKey.slice(0, 12))
      return
    }
    console.warn('[glbByteCache] write failed', storageKey.slice(0, 12), err)
  }
}
