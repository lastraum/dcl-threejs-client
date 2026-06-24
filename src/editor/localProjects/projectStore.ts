const META_KEY = 'dcl-editor-projects'
const DB_NAME = 'dcl-editor-fs'
const HANDLE_STORE = 'handles'

export type LocalProjectMeta = {
  id: string
  name: string
  addedAt: number
  lastOpenedAt: number
  baseParcel?: string
  parcelCount?: number
}

export type LocalProjectRecord = LocalProjectMeta & {
  permission: 'granted' | 'prompt' | 'denied' | 'unknown'
}

function randomId(): string {
  return crypto.randomUUID()
}

function readMetaList(): LocalProjectMeta[] {
  try {
    const raw = localStorage.getItem(META_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as LocalProjectMeta[]
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function writeMetaList(list: LocalProjectMeta[]): void {
  localStorage.setItem(META_KEY, JSON.stringify(list))
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(HANDLE_STORE)) {
        db.createObjectStore(HANDLE_STORE)
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'))
  })
}

async function getHandle(projectId: string): Promise<FileSystemDirectoryHandle | null> {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(HANDLE_STORE, 'readonly')
    const req = tx.objectStore(HANDLE_STORE).get(projectId)
    req.onsuccess = () => resolve((req.result as FileSystemDirectoryHandle | undefined) ?? null)
    req.onerror = () => reject(req.error ?? new Error('IndexedDB read failed'))
  })
}

async function putHandle(projectId: string, handle: FileSystemDirectoryHandle): Promise<void> {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(HANDLE_STORE, 'readwrite')
    tx.objectStore(HANDLE_STORE).put(handle, projectId)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB write failed'))
  })
}

async function deleteHandle(projectId: string): Promise<void> {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(HANDLE_STORE, 'readwrite')
    tx.objectStore(HANDLE_STORE).delete(projectId)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB delete failed'))
  })
}

export function isFileSystemAccessSupported(): boolean {
  return typeof window !== 'undefined' && 'showDirectoryPicker' in window
}

async function readSceneJsonMeta(handle: FileSystemDirectoryHandle): Promise<{
  name: string
  baseParcel?: string
  parcelCount?: number
}> {
  try {
    const fileHandle = await handle.getFileHandle('scene.json')
    const file = await fileHandle.getFile()
    const json = JSON.parse(await file.text()) as {
      display?: { title?: string }
      scene?: { base?: string; parcels?: string[] }
    }
    const title = json.display?.title?.trim()
    const baseParcel = json.scene?.base
    const parcelCount = json.scene?.parcels?.length
    return {
      name: title || handle.name,
      baseParcel,
      parcelCount
    }
  } catch {
    return { name: handle.name }
  }
}

export async function pickAndAddProject(): Promise<LocalProjectRecord | null> {
  if (!isFileSystemAccessSupported()) {
    throw new Error('File System Access API is not supported in this browser. Use Chrome or Edge.')
  }
  const handle = await window.showDirectoryPicker({ mode: 'readwrite' })
  await readSceneJsonMeta(handle)
  const metaFromScene = await readSceneJsonMeta(handle)
  const id = randomId()
  const now = Date.now()
  const meta: LocalProjectMeta = {
    id,
    name: metaFromScene.name,
    addedAt: now,
    lastOpenedAt: now,
    baseParcel: metaFromScene.baseParcel,
    parcelCount: metaFromScene.parcelCount
  }
  await putHandle(id, handle)
  const list = readMetaList()
  list.unshift(meta)
  writeMetaList(list)
  const permission = await handle.queryPermission({ mode: 'readwrite' })
  return { ...meta, permission }
}

export async function listProjects(): Promise<LocalProjectRecord[]> {
  const list = readMetaList()
  const out: LocalProjectRecord[] = []
  for (const meta of list) {
    const handle = await getHandle(meta.id)
    let permission: LocalProjectRecord['permission'] = 'unknown'
    if (handle) {
      try {
        permission = await handle.queryPermission({ mode: 'readwrite' })
      } catch {
        permission = 'unknown'
      }
    } else {
      permission = 'denied'
    }
    out.push({ ...meta, permission })
  }
  return out
}

export async function removeProject(projectId: string): Promise<void> {
  await deleteHandle(projectId)
  writeMetaList(readMetaList().filter((p) => p.id !== projectId))
}

export async function touchProjectOpened(projectId: string): Promise<void> {
  const list = readMetaList()
  const idx = list.findIndex((p) => p.id === projectId)
  if (idx < 0) return
  list[idx]!.lastOpenedAt = Date.now()
  writeMetaList(list)
}

export async function requestProjectHandle(projectId: string): Promise<FileSystemDirectoryHandle> {
  const handle = await getHandle(projectId)
  if (!handle) throw new Error('Project folder not found — remove and re-add this project.')
  const perm = await handle.requestPermission({ mode: 'readwrite' })
  if (perm !== 'granted') throw new Error('Folder access was denied.')
  await touchProjectOpened(projectId)
  return handle
}

export async function relinkProject(projectId: string): Promise<LocalProjectRecord | null> {
  if (!isFileSystemAccessSupported()) {
    throw new Error('File System Access API is not supported in this browser.')
  }
  const handle = await window.showDirectoryPicker({ mode: 'readwrite' })
  const metaFromScene = await readSceneJsonMeta(handle)
  await putHandle(projectId, handle)
  const list = readMetaList()
  const idx = list.findIndex((p) => p.id === projectId)
  if (idx >= 0) {
    list[idx] = {
      ...list[idx]!,
      name: metaFromScene.name,
      baseParcel: metaFromScene.baseParcel,
      parcelCount: metaFromScene.parcelCount,
      lastOpenedAt: Date.now()
    }
    writeMetaList(list)
    const permission = await handle.queryPermission({ mode: 'readwrite' })
    return { ...list[idx]!, permission }
  }
  return null
}

export async function getProjectMeta(projectId: string): Promise<LocalProjectMeta | null> {
  return readMetaList().find((p) => p.id === projectId) ?? null
}