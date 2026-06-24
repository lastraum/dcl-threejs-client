/**
 * Persistent VRM byte cache (IndexedDB) — local library only.
 */
const DB_NAME = 'dcl-client-vrm-library'
const DB_VERSION = 1
const BYTES_STORE = 'bytes'
const META_STORE = 'meta'

let dbPromise: Promise<IDBDatabase> | null = null

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
      if (!db.objectStoreNames.contains(BYTES_STORE)) db.createObjectStore(BYTES_STORE)
      if (!db.objectStoreNames.contains(META_STORE)) db.createObjectStore(META_STORE)
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
      reject(req.error ?? new Error('VRM IndexedDB open failed'))
    }
  })
  return dbPromise
}

function toArrayBuffer(value: unknown): ArrayBuffer | null {
  if (value instanceof ArrayBuffer) return value
  if (value instanceof Uint8Array) {
    const copy = value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)
    return copy as ArrayBuffer
  }
  return null
}

export async function readVrmBytes(contentHash: string): Promise<ArrayBuffer | null> {
  const key = contentHash.toLowerCase()
  try {
    const db = await openDb()
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(BYTES_STORE, 'readonly')
      const req = tx.objectStore(BYTES_STORE).get(key)
      req.onsuccess = () => resolve(toArrayBuffer(req.result))
      req.onerror = () => reject(req.error ?? new Error('VRM read failed'))
    })
  } catch {
    return null
  }
}

export async function writeVrmBytes(contentHash: string, bytes: ArrayBuffer): Promise<void> {
  const key = contentHash.toLowerCase()
  const db = await openDb()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(BYTES_STORE, 'readwrite')
    tx.objectStore(BYTES_STORE).put(bytes, key)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error ?? new Error('VRM write failed'))
  })
}

export async function deleteVrmBytes(contentHash: string): Promise<void> {
  const key = contentHash.toLowerCase()
  const db = await openDb()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(BYTES_STORE, 'readwrite')
    tx.objectStore(BYTES_STORE).delete(key)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error ?? new Error('VRM delete failed'))
  })
}

export async function readVrmMetaStore<T>(key: string): Promise<T | null> {
  try {
    const db = await openDb()
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(META_STORE, 'readonly')
      const req = tx.objectStore(META_STORE).get(key)
      req.onsuccess = () => resolve((req.result as T | undefined) ?? null)
      req.onerror = () => reject(req.error ?? new Error('VRM meta read failed'))
    })
  } catch {
    return null
  }
}

export async function writeVrmMetaStore<T>(key: string, value: T): Promise<void> {
  const db = await openDb()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(META_STORE, 'readwrite')
    tx.objectStore(META_STORE).put(value, key)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error ?? new Error('VRM meta write failed'))
  })
}