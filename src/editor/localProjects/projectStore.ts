import { creatorHubProjectId, isCreatorHubProjectId } from './creatorHubPaths'

const META_KEY = 'dcl-editor-projects'
const DB_NAME = 'dcl-editor-fs'
const HANDLE_STORE = 'handles'
const CREATOR_HUB_ROOT_KEY = '__creator_hub_scenes_root__'

export type ProjectSource = 'manual' | 'creator-hub'

export type LocalProjectMeta = {
  id: string
  name: string
  addedAt: number
  lastOpenedAt: number
  baseParcel?: string
  parcelCount?: number
  source?: ProjectSource
  /** Subfolder name under Creator Hub Scenes root. */
  folderName?: string
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

async function getHandle(key: string): Promise<FileSystemDirectoryHandle | null> {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(HANDLE_STORE, 'readonly')
    const req = tx.objectStore(HANDLE_STORE).get(key)
    req.onsuccess = () => resolve((req.result as FileSystemDirectoryHandle | undefined) ?? null)
    req.onerror = () => reject(req.error ?? new Error('IndexedDB read failed'))
  })
}

async function putHandle(key: string, handle: FileSystemDirectoryHandle): Promise<void> {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(HANDLE_STORE, 'readwrite')
    tx.objectStore(HANDLE_STORE).put(handle, key)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB write failed'))
  })
}

async function deleteHandle(key: string): Promise<void> {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(HANDLE_STORE, 'readwrite')
    tx.objectStore(HANDLE_STORE).delete(key)
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

async function queryPermission(handle: FileSystemDirectoryHandle): Promise<LocalProjectRecord['permission']> {
  try {
    return await handle.queryPermission({ mode: 'readwrite' })
  } catch {
    return 'unknown'
  }
}

function upsertMeta(meta: LocalProjectMeta): void {
  const list = readMetaList()
  const idx = list.findIndex((p) => p.id === meta.id)
  if (idx >= 0) {
    list[idx] = { ...list[idx]!, ...meta }
  } else {
    list.unshift(meta)
  }
  writeMetaList(list)
}

export async function getCreatorHubScenesRoot(): Promise<FileSystemDirectoryHandle | null> {
  return getHandle(CREATOR_HUB_ROOT_KEY)
}

export async function isCreatorHubScenesLinked(): Promise<boolean> {
  const root = await getCreatorHubScenesRoot()
  return root !== null
}

export type CreatorHubSyncResult = {
  imported: number
  updated: number
  total: number
}

/** Scan Creator Hub Scenes root and register each subfolder with scene.json. */
export async function syncCreatorHubScenes(scenesRoot: FileSystemDirectoryHandle): Promise<CreatorHubSyncResult> {
  const perm = await scenesRoot.requestPermission({ mode: 'readwrite' })
  if (perm !== 'granted') {
    throw new Error('Creator Hub Scenes folder access was denied.')
  }

  await putHandle(CREATOR_HUB_ROOT_KEY, scenesRoot)

  let imported = 0
  let updated = 0
  const seenIds = new Set<string>()

  for await (const [name, entry] of scenesRoot.entries()) {
    if (entry.kind !== 'directory') continue
    if (name.startsWith('.')) continue

    const dir = entry as FileSystemDirectoryHandle
    try {
      await dir.getFileHandle('scene.json')
    } catch {
      continue
    }

    const id = creatorHubProjectId(name)
    seenIds.add(id)
    const metaFromScene = await readSceneJsonMeta(dir)
    const list = readMetaList()
    const exists = list.some((p) => p.id === id)
    const now = Date.now()

    const meta: LocalProjectMeta = {
      id,
      name: metaFromScene.name,
      addedAt: exists ? list.find((p) => p.id === id)!.addedAt : now,
      lastOpenedAt: exists ? list.find((p) => p.id === id)!.lastOpenedAt : now,
      baseParcel: metaFromScene.baseParcel,
      parcelCount: metaFromScene.parcelCount,
      source: 'creator-hub',
      folderName: name
    }

    await putHandle(id, dir)
    upsertMeta(meta)
    if (exists) updated++
    else imported++
  }

  return { imported, updated, total: seenIds.size }
}

/** Pick Creator Hub Scenes folder (default: ~/Library/Application Support/creator-hub/Scenes on Mac). */
export async function linkCreatorHubScenesFolder(): Promise<CreatorHubSyncResult> {
  if (!isFileSystemAccessSupported()) {
    throw new Error('File System Access API is not supported in this browser. Use Chrome or Edge.')
  }
  const handle = await window.showDirectoryPicker({ mode: 'readwrite' })
  return syncCreatorHubScenes(handle)
}

/** Re-scan linked Creator Hub Scenes root (picks up new scenes). */
export async function rescanCreatorHubScenes(): Promise<CreatorHubSyncResult | null> {
  const root = await getCreatorHubScenesRoot()
  if (!root) return null
  return syncCreatorHubScenes(root)
}

export async function pickAndAddProject(): Promise<LocalProjectRecord | null> {
  if (!isFileSystemAccessSupported()) {
    throw new Error('File System Access API is not supported in this browser. Use Chrome or Edge.')
  }
  const handle = await window.showDirectoryPicker({ mode: 'readwrite' })
  const metaFromScene = await readSceneJsonMeta(handle)
  const id = randomId()
  const now = Date.now()
  const meta: LocalProjectMeta = {
    id,
    name: metaFromScene.name,
    addedAt: now,
    lastOpenedAt: now,
    baseParcel: metaFromScene.baseParcel,
    parcelCount: metaFromScene.parcelCount,
    source: 'manual'
  }
  await putHandle(id, handle)
  upsertMeta(meta)
  const permission = await queryPermission(handle)
  return { ...meta, permission }
}

export async function listProjects(): Promise<LocalProjectRecord[]> {
  const list = readMetaList()
  const out: LocalProjectRecord[] = []
  for (const meta of list) {
    const handle = await getHandle(meta.id)
    let permission: LocalProjectRecord['permission'] = 'unknown'
    if (handle) {
      permission = await queryPermission(handle)
    } else {
      permission = 'denied'
    }
    out.push({ ...meta, permission })
  }
  return out.sort((a, b) => b.lastOpenedAt - a.lastOpenedAt)
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
  if (!handle) throw new Error('Project folder not found — re-link Creator Hub or add the folder again.')
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
      lastOpenedAt: Date.now(),
      source: isCreatorHubProjectId(projectId) ? 'creator-hub' : 'manual'
    }
    writeMetaList(list)
    const permission = await queryPermission(handle)
    return { ...list[idx]!, permission }
  }
  return null
}

export async function getProjectMeta(projectId: string): Promise<LocalProjectMeta | null> {
  return readMetaList().find((p) => p.id === projectId) ?? null
}

export async function unlinkCreatorHubScenes(): Promise<void> {
  await deleteHandle(CREATOR_HUB_ROOT_KEY)
  const list = readMetaList().filter((p) => p.source !== 'creator-hub')
  const removed = readMetaList().filter((p) => p.source === 'creator-hub')
  for (const p of removed) {
    await deleteHandle(p.id)
  }
  writeMetaList(list)
}