/**
 * Leader-local tour location photos (IndexedDB).
 * Never sent on the follow wire — export only at end of tour.
 *
 * Target ~≤1MB **per** image (PNG export may exceed after best-effort downscale).
 */

const DB_NAME = 'd3js-tour-location-photos'
const DB_VERSION = 1
const STORE = 'photos'
/** Soft cap per image when storing (bytes). */
export const TOUR_PHOTO_MAX_BYTES = 1_000_000
const MAX_EDGE = 1920

export type TourLocationPhoto = {
  sessionId: string
  locationId: string
  /** PNG blob preferred. */
  blob: Blob
  dataUrl: string
  capturedAt: number
  byteLength: number
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB unavailable'))
      return
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onerror = () => reject(req.error ?? new Error('idb open failed'))
    req.onsuccess = () => resolve(req.result)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) {
        const os = db.createObjectStore(STORE, { keyPath: ['sessionId', 'locationId'] })
        os.createIndex('bySession', 'sessionId', { unique: false })
      }
    }
  })
}

function idbReq<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('idb request failed'))
  })
}

/** Downscale / re-encode so each PNG is as close as possible to ≤1MB (may still exceed). */
export async function prepareTourLocationPng(
  source: Blob | string
): Promise<{ blob: Blob; dataUrl: string; byteLength: number }> {
  let bitmap: ImageBitmap
  if (typeof source === 'string') {
    const res = await fetch(source)
    bitmap = await createImageBitmap(await res.blob())
  } else {
    bitmap = await createImageBitmap(source)
  }
  try {
    let w = bitmap.width
    let h = bitmap.height
    const scale = Math.min(1, MAX_EDGE / Math.max(w, h, 1))
    w = Math.max(1, Math.round(w * scale))
    h = Math.max(1, Math.round(h * scale))

    let edge = Math.max(w, h)
    let blob: Blob | null = null
    let dataUrl = ''

    for (let attempt = 0; attempt < 8; attempt++) {
      const tw = Math.max(1, Math.round((w * edge) / Math.max(w, h)))
      const th = Math.max(1, Math.round((h * edge) / Math.max(w, h)))
      const canvas = document.createElement('canvas')
      canvas.width = tw
      canvas.height = th
      const ctx = canvas.getContext('2d')
      if (!ctx) throw new Error('canvas 2d unavailable')
      ctx.drawImage(bitmap, 0, 0, tw, th)
      dataUrl = canvas.toDataURL('image/png')
      blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
      if (!blob) break
      if (blob.size <= TOUR_PHOTO_MAX_BYTES || edge < 320) break
      edge = Math.round(edge * 0.75)
    }

    if (!blob) throw new Error('PNG encode failed')
    return { blob, dataUrl, byteLength: blob.size }
  } finally {
    bitmap.close()
  }
}

export async function putTourLocationPhoto(
  sessionId: string,
  locationId: string,
  source: Blob | string
): Promise<TourLocationPhoto> {
  const prepared = await prepareTourLocationPng(source)
  const row: TourLocationPhoto = {
    sessionId,
    locationId,
    blob: prepared.blob,
    dataUrl: prepared.dataUrl,
    capturedAt: Date.now(),
    byteLength: prepared.byteLength
  }
  const db = await openDb()
  try {
    const tx = db.transaction(STORE, 'readwrite')
    await idbReq(tx.objectStore(STORE).put(row))
  } finally {
    db.close()
  }
  return row
}

export async function getTourLocationPhoto(
  sessionId: string,
  locationId: string
): Promise<TourLocationPhoto | null> {
  const db = await openDb()
  try {
    const tx = db.transaction(STORE, 'readonly')
    const row = await idbReq(
      tx.objectStore(STORE).get([sessionId, locationId]) as IDBRequest<TourLocationPhoto | undefined>
    )
    return row ?? null
  } finally {
    db.close()
  }
}

export async function listTourLocationPhotos(sessionId: string): Promise<TourLocationPhoto[]> {
  const db = await openDb()
  try {
    const tx = db.transaction(STORE, 'readonly')
    const idx = tx.objectStore(STORE).index('bySession')
    const rows = await idbReq(idx.getAll(sessionId) as IDBRequest<TourLocationPhoto[]>)
    return rows ?? []
  } finally {
    db.close()
  }
}

export async function deleteTourSessionPhotos(sessionId: string): Promise<void> {
  const rows = await listTourLocationPhotos(sessionId)
  if (!rows.length) return
  const db = await openDb()
  try {
    const tx = db.transaction(STORE, 'readwrite')
    const store = tx.objectStore(STORE)
    for (const r of rows) {
      store.delete([r.sessionId, r.locationId])
    }
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error ?? new Error('idb delete failed'))
    })
  } finally {
    db.close()
  }
}
