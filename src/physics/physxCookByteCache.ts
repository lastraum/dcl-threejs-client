/**
 * Persistent PhysX cooked-mesh streams (IndexedDB).
 *
 * Stores binary output from CookTriangleMesh / CookConvexMesh — reload via
 * PxPhysics.createTriangleMesh / createConvexMesh without re-cooking on WASM.
 */
const DB_NAME = 'dcl-client-physx-cook-cache'
const DB_VERSION = 1
const STORE = 'cooks'
/** v3 — boot entity-local GLTF cooks (main-thread authoritative; v1/v2 entries not reused). */
const CACHE_FORMAT_VERSION = 3

/** Puts per IndexedDB transaction during idle flush slices. */
const PERSIST_BATCH_SIZE = 48
/** Max wait before an idle flush slice runs when the tab stays busy. */
const PERSIST_IDLE_TIMEOUT_MS = 4000

let dbPromise: Promise<IDBDatabase> | null = null
const loggedKeys = new Set<string>()

const persistQueue = new Map<string, ArrayBuffer>()
let flushScheduled = false
let persistFlushInFlight = false
let flushIdleHandle: number | ReturnType<typeof setTimeout> | null = null
let persistSliceCount = 0
let persistEntryCount = 0
let persistByteCount = 0

export function physxCookStorageKey(signature: string, convex: boolean): string {
  return `v${CACHE_FORMAT_VERSION}:${convex ? 'convex' : 'tri'}:${signature}`
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

function withStoreBatch(entries: ReadonlyArray<readonly [string, ArrayBuffer]>): Promise<void> {
  if (!entries.length) return Promise.resolve()
  return openDb().then(
    (db) =>
      new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite')
        const store = tx.objectStore(STORE)
        for (const [key, buffer] of entries) {
          store.put(buffer, key)
        }
        let settled = false
        const fail = (err: unknown) => {
          if (settled) return
          settled = true
          reject(err instanceof Error ? err : new Error(String(err)))
        }
        tx.oncomplete = () => {
          if (settled) return
          settled = true
          resolve()
        }
        tx.onerror = () => fail(tx.error ?? new Error('IndexedDB transaction failed'))
        tx.onabort = () => fail(tx.error ?? new Error('IndexedDB transaction aborted'))
      })
  )
}

function logOnce(key: string, message: string): void {
  if (loggedKeys.has(key)) return
  loggedKeys.add(key)
  console.debug(`[physxCookByteCache] ${message}`, key.slice(0, 28))
}

function cancelScheduledPersistFlush(): void {
  if (flushIdleHandle == null) return
  if (typeof cancelIdleCallback === 'function' && typeof flushIdleHandle === 'number') {
    cancelIdleCallback(flushIdleHandle)
  } else {
    clearTimeout(flushIdleHandle as ReturnType<typeof setTimeout>)
  }
  flushIdleHandle = null
  flushScheduled = false
}

function logPersistFlushSummary(): void {
  if (persistEntryCount <= 0) return
  const mb = (persistByteCount / (1024 * 1024)).toFixed(2)
  console.info(
    `[physxCookByteCache] persisted ${persistEntryCount} cooked stream(s) (${mb} MB) in ${persistSliceCount} idle batch(es)`
  )
  persistSliceCount = 0
  persistEntryCount = 0
  persistByteCount = 0
}

function schedulePersistFlush(): void {
  if (flushScheduled) return
  flushScheduled = true
  const run = () => {
    flushIdleHandle = null
    flushScheduled = false
    void drainPersistQueueSlice()
  }
  if (typeof requestIdleCallback === 'function') {
    flushIdleHandle = requestIdleCallback(run, { timeout: PERSIST_IDLE_TIMEOUT_MS })
  } else {
    flushIdleHandle = setTimeout(run, 32)
  }
}

async function drainPersistQueueSlice(): Promise<void> {
  if (persistFlushInFlight || persistQueue.size === 0) return
  persistFlushInFlight = true
  const batch: Array<[string, ArrayBuffer]> = []
  try {
    for (const [key, buffer] of persistQueue) {
      batch.push([key, buffer])
      persistQueue.delete(key)
      if (batch.length >= PERSIST_BATCH_SIZE) break
    }
    if (batch.length) {
      await withStoreBatch(batch)
      persistSliceCount++
      persistEntryCount += batch.length
      persistByteCount += batch.reduce((sum, [, buf]) => sum + buf.byteLength, 0)
    }
  } catch (err) {
    if (err instanceof DOMException && err.name === 'QuotaExceededError') {
      console.warn('[physxCookByteCache] quota exceeded — dropping queued persist batch')
      persistQueue.clear()
    } else {
      console.warn('[physxCookByteCache] batch write failed', err)
      for (const [key, buffer] of batch) {
        if (!persistQueue.has(key)) persistQueue.set(key, buffer)
      }
    }
  } finally {
    persistFlushInFlight = false
    if (persistQueue.size > 0) {
      schedulePersistFlush()
    } else {
      logPersistFlushSummary()
    }
  }
}

/** Queue a cooked stream for idle batched IndexedDB persist (boot cooks only). */
export function queuePhysxCookPersist(key: string, buffer: ArrayBuffer): void {
  if (!key || !buffer?.byteLength) return
  persistQueue.set(key, buffer.slice(0))
  schedulePersistFlush()
}

/** Drain any queued persists — processes one batch per call; repeat until queue empty. */
export async function flushPhysxCookPersist(): Promise<void> {
  cancelScheduledPersistFlush()
  while (persistQueue.size > 0) {
    await drainPersistQueueSlice()
  }
}

export async function readPhysxCookBytes(key: string, options?: { silentMiss?: boolean }): Promise<ArrayBuffer | null> {
  if (!key) return null
  try {
    const hit = await withStore('readonly', (store) => store.get(key))
    const buffer = toArrayBuffer(hit)
    if (buffer?.byteLength) return buffer
    if (!options?.silentMiss) logOnce(key, 'miss')
    return null
  } catch (err) {
    logOnce(key, `read failed — ${err instanceof Error ? err.message : String(err)}`)
    return null
  }
}

/** Immediate single-key write — prefer queuePhysxCookPersist during boot. */
export async function writePhysxCookBytes(key: string, buffer: ArrayBuffer): Promise<void> {
  if (!key || !buffer?.byteLength) return
  try {
    const copy = buffer.slice(0)
    await withStore('readwrite', (store) => store.put(copy, key))
  } catch (err) {
    if (err instanceof DOMException && err.name === 'QuotaExceededError') {
      console.warn('[physxCookByteCache] quota exceeded — skipping persist for', key.slice(0, 24))
      return
    }
    console.warn('[physxCookByteCache] write failed', key.slice(0, 24), err)
  }
}

const primedStreams = new Map<string, ArrayBuffer>()

export function storePrimedPhysxCookStream(storageKey: string, bytes: ArrayBuffer): void {
  if (!storageKey || !bytes?.byteLength) return
  primedStreams.set(storageKey, bytes)
}

export function hasPrimedPhysxCookStream(storageKey: string): boolean {
  return primedStreams.has(storageKey)
}

export function takePrimedPhysxCookStream(storageKey: string): ArrayBuffer | undefined {
  const hit = primedStreams.get(storageKey)
  if (hit) primedStreams.delete(storageKey)
  return hit
}

export function clearPrimedPhysxCookStreams(): void {
  primedStreams.clear()
}

/** Batch-read cooked streams into memory for synchronous cook hits during boot drain. */
export async function primePhysxCookByteCache(keys: string[]): Promise<number> {
  const unique = [...new Set(keys.filter(Boolean))]
  if (!unique.length) return 0
  let hits = 0
  const concurrency = 16
  for (let i = 0; i < unique.length; i += concurrency) {
    const batch = unique.slice(i, i + concurrency)
    const results = await Promise.all(
      batch.map(async (key) => {
        const bytes = await readPhysxCookBytes(key, { silentMiss: true })
        return bytes ? ([key, bytes] as const) : null
      })
    )
    for (const entry of results) {
      if (!entry) continue
      storePrimedPhysxCookStream(entry[0], entry[1])
      hits++
    }
  }
  if (hits > 0) {
    console.info(`[physxCookByteCache] primed ${hits}/${unique.length} cooked stream(s) from IndexedDB`)
  }
  return hits
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && persistQueue.size > 0) {
      void flushPhysxCookPersist()
    }
  })
}