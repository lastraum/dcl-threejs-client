/**
 * Open an IndexedDB, recovering once if the backing store was deleted
 * out from under Chrome (folder wipe / corrupt origin).
 */
export function openIdb(
  name: string,
  version: number,
  upgrade: (db: IDBDatabase) => void
): Promise<IDBDatabase> {
  if (typeof indexedDB === 'undefined') {
    return Promise.reject(new Error('IndexedDB unavailable'))
  }
  return openOnce(name, version, upgrade).catch(async (err) => {
    await deleteIdb(name)
    try {
      return await openOnce(name, version, upgrade)
    } catch {
      throw err instanceof Error ? err : new Error(`IndexedDB open failed: ${name}`)
    }
  })
}

function openOnce(
  name: string,
  version: number,
  upgrade: (db: IDBDatabase) => void
): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let settled = false
    const timer = window.setTimeout(() => {
      if (settled) return
      settled = true
      reject(new Error(`IndexedDB open timeout: ${name}`))
    }, 4000)
    let req: IDBOpenDBRequest
    try {
      req = indexedDB.open(name, version)
    } catch (err) {
      window.clearTimeout(timer)
      reject(err instanceof Error ? err : new Error(String(err)))
      return
    }
    req.onupgradeneeded = () => {
      try {
        upgrade(req.result)
      } catch (err) {
        if (settled) return
        settled = true
        window.clearTimeout(timer)
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    }
    req.onsuccess = () => {
      if (settled) {
        req.result.close()
        return
      }
      settled = true
      window.clearTimeout(timer)
      const db = req.result
      db.onversionchange = () => db.close()
      resolve(db)
    }
    req.onerror = () => {
      if (settled) return
      settled = true
      window.clearTimeout(timer)
      reject(req.error ?? new Error(`IndexedDB open failed: ${name}`))
    }
    req.onblocked = () => {
      if (settled) return
      settled = true
      window.clearTimeout(timer)
      reject(new Error(`IndexedDB open blocked: ${name}`))
    }
  })
}

function deleteIdb(name: string): Promise<void> {
  return new Promise((resolve) => {
    let settled = false
    const done = () => {
      if (settled) return
      settled = true
      resolve()
    }
    window.setTimeout(done, 2000)
    try {
      const req = indexedDB.deleteDatabase(name)
      req.onsuccess = done
      req.onerror = done
      req.onblocked = done
    } catch {
      done()
    }
  })
}
