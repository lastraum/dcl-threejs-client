import {
  fetchDevBridgeHealth,
  fetchDevBridgeProjects,
  importCreatorHubViaDevBridge
} from '../localScene/devBridgeClient'
import type { ProjectRoot } from '../localScene/projectRoot'
import { isDevBridgeAvailable } from '../localScene/projectRoot'
import {
  defaultCreatorHubConfigPath,
  entriesFromCreatorHubConfig,
  parseCreatorHubConfig,
  type CreatorHubConfigEntry
} from './creatorHubConfig'
import { creatorHubProjectId, isCreatorHubProjectId } from './creatorHubPaths'

const META_KEY = 'dcl-editor-projects'
const DB_NAME = 'dcl-editor-fs'
const HANDLE_STORE = 'handles'
const CREATOR_HUB_ROOT_KEY = '__creator_hub_scenes_root__'

export type ProjectSource = 'manual' | 'creator-hub'
export type ProjectAccessMode = 'fsa' | 'dev-bridge'

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
  /** Full filesystem path from Creator Hub config (no handle until connected). */
  pathHint?: string
  /** How this project reads/writes files on disk. */
  accessMode?: ProjectAccessMode
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

export function isOpenFilePickerSupported(): boolean {
  return typeof window !== 'undefined' && 'showOpenFilePicker' in window
}

export function formatFilePickerError(e: unknown): string {
  if (!(e instanceof Error)) return String(e)
  if (e.name === 'AbortError') return e.message
  const msg = e.message.toLowerCase()
  if (
    msg.includes('system file') ||
    msg.includes('system files') ||
    msg.includes('contains system') ||
    (e.name === 'NotAllowedError' && msg.includes('system'))
  ) {
    return (
      'Chrome blocked that folder (common under ~/Library). ' +
      'Use Import Creator Hub at http://localhost:5173/editor while npm run dev is running on this machine.'
    )
  }
  return e.message
}

async function hasStoredHandle(projectId: string): Promise<boolean> {
  return (await getHandle(projectId)) !== null
}

export async function isProjectConnected(projectId: string): Promise<boolean> {
  return hasStoredHandle(projectId)
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

function upsertCreatorHubConfigEntry(entry: CreatorHubConfigEntry): 'imported' | 'updated' {
  const list = readMetaList()
  const exists = list.some((p) => p.id === entry.id)
  const now = Date.now()
  const prev = list.find((p) => p.id === entry.id)

  const meta: LocalProjectMeta = {
    id: entry.id,
    name: prev?.name ?? entry.folderName,
    addedAt: prev?.addedAt ?? now,
    lastOpenedAt: prev?.lastOpenedAt ?? now,
    baseParcel: prev?.baseParcel,
    parcelCount: prev?.parcelCount,
    source: 'creator-hub',
    folderName: entry.folderName,
    pathHint: entry.pathHint
  }

  upsertMeta(meta)
  return exists ? 'updated' : 'imported'
}

/** Import Creator Hub workspace list via Settings/config.json (avoids blocked Scenes folder picker). */
export async function importCreatorHubConfig(): Promise<CreatorHubSyncResult> {
  if (!isOpenFilePickerSupported()) {
    throw new Error('File picker is not supported in this browser. Use Chrome or Edge.')
  }

  const configHint = defaultCreatorHubConfigPath()
  const [fileHandle] = await window.showOpenFilePicker({
    multiple: false,
    types: [
      {
        description: `Creator Hub config (${configHint})`,
        accept: { 'application/json': ['.json'] }
      }
    ]
  })

  const file = await fileHandle.getFile()
  const config = parseCreatorHubConfig(JSON.parse(await file.text()))
  const entries = entriesFromCreatorHubConfig(config)
  if (entries.length === 0) {
    throw new Error('No workspace paths found in Creator Hub config.')
  }

  let imported = 0
  let updated = 0
  for (const entry of entries) {
    const result = upsertCreatorHubConfigEntry(entry)
    if (result === 'imported') imported++
    else updated++
  }

  return { imported, updated, total: entries.length }
}

/** Pick Creator Hub Scenes folder (often blocked under ~/Library — prefer import + drag-drop). */
export async function linkCreatorHubScenesFolder(): Promise<CreatorHubSyncResult> {
  if (!isFileSystemAccessSupported()) {
    throw new Error('File System Access API is not supported in this browser. Use Chrome or Edge.')
  }
  try {
    const handle = await window.showDirectoryPicker({ mode: 'readwrite' })
    return syncCreatorHubScenes(handle)
  } catch (e) {
    throw new Error(formatFilePickerError(e))
  }
}

/** Re-scan linked Creator Hub Scenes root (picks up new scenes). */
export async function rescanCreatorHubScenes(): Promise<CreatorHubSyncResult | null> {
  const root = await getCreatorHubScenesRoot()
  if (!root) return null
  return syncCreatorHubScenes(root)
}

export async function registerProjectFromHandle(
  handle: FileSystemDirectoryHandle,
  options?: { projectId?: string; source?: ProjectSource; pathHint?: string; accessMode?: ProjectAccessMode }
): Promise<LocalProjectRecord> {
  const metaFromScene = await readSceneJsonMeta(handle)
  const id = options?.projectId ?? randomId()
  const now = Date.now()
  const list = readMetaList()
  const prev = list.find((p) => p.id === id)
  const meta: LocalProjectMeta = {
    id,
    name: metaFromScene.name,
    addedAt: prev?.addedAt ?? now,
    lastOpenedAt: now,
    baseParcel: metaFromScene.baseParcel,
    parcelCount: metaFromScene.parcelCount,
    source: options?.source ?? prev?.source ?? 'manual',
    folderName: prev?.folderName ?? handle.name,
    pathHint: options?.pathHint ?? prev?.pathHint,
    accessMode: 'fsa'
  }
  await putHandle(id, handle)
  upsertMeta(meta)
  const permission = await queryPermission(handle)
  return { ...meta, permission }
}

async function findPendingCreatorHubMatch(
  handle: FileSystemDirectoryHandle
): Promise<LocalProjectMeta | null> {
  const list = readMetaList()
  for (const meta of list) {
    if (meta.source !== 'creator-hub') continue
    if (await hasStoredHandle(meta.id)) continue
    if (meta.folderName === handle.name) return meta
    if (meta.pathHint?.replace(/[/\\]+$/, '').endsWith(`/${handle.name}`)) return meta
    if (meta.pathHint?.replace(/[/\\]+$/, '').endsWith(`\\${handle.name}`)) return meta
  }
  return null
}

/** Connect a dropped or picked folder to an imported Creator Hub entry, or add as manual. */
export async function addProjectFromDroppedHandle(
  handle: FileSystemDirectoryHandle
): Promise<LocalProjectRecord> {
  const pending = await findPendingCreatorHubMatch(handle)
  if (pending) {
    return registerProjectFromHandle(handle, {
      projectId: pending.id,
      source: 'creator-hub',
      pathHint: pending.pathHint
    })
  }
  return registerProjectFromHandle(handle, { source: 'manual' })
}

export async function connectProjectFolder(projectId: string): Promise<LocalProjectRecord | null> {
  if (!isFileSystemAccessSupported()) {
    throw new Error('File System Access API is not supported in this browser.')
  }
  try {
    const handle = await window.showDirectoryPicker({ mode: 'readwrite' })
    return registerProjectFromHandle(handle, {
      projectId,
      source: isCreatorHubProjectId(projectId) ? 'creator-hub' : 'manual'
    })
  } catch (e) {
    throw new Error(formatFilePickerError(e))
  }
}

export async function pickAndAddProject(): Promise<LocalProjectRecord | null> {
  if (!isFileSystemAccessSupported()) {
    throw new Error('File System Access API is not supported in this browser. Use Chrome or Edge.')
  }
  try {
    const handle = await window.showDirectoryPicker({ mode: 'readwrite' })
    return addProjectFromDroppedHandle(handle)
  } catch (e) {
    throw new Error(formatFilePickerError(e))
  }
}

async function resolveProjectPermission(meta: LocalProjectMeta): Promise<LocalProjectRecord['permission']> {
  const handle = await getHandle(meta.id)
  if (handle) {
    return queryPermission(handle)
  }
  if (meta.accessMode === 'dev-bridge' && meta.pathHint && (await isDevBridgeAvailable())) {
    return 'granted'
  }
  return 'denied'
}

export type CreatorHubImportMode = 'dev-bridge' | 'config-file'

export type CreatorHubImportOutcome = {
  mode: CreatorHubImportMode
  result: CreatorHubSyncResult
  /** Set when live build should use localhost dev import instead. */
  devImportUrl?: string
}

function isLocalhostEditor(): boolean {
  if (typeof window === 'undefined') return false
  const host = window.location.hostname
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]'
}

/**
 * One editor action: dev bridge reads Creator Hub from disk (npm run dev),
 * otherwise file picker for config.json then Connect per scene.
 */
export async function importCreatorHubProjects(): Promise<CreatorHubImportOutcome> {
  const bridgeImport = await importCreatorHubViaDevBridge()
  if (bridgeImport?.ok && bridgeImport.projects.length > 0) {
    const result = await applyDevBridgeProjects(bridgeImport.projects)
    return { mode: 'dev-bridge', result }
  }
  if (bridgeImport && !bridgeImport.ok && bridgeImport.error) {
    throw new Error(bridgeImport.error)
  }

  const health = await fetchDevBridgeHealth()
  if (health?.ok) {
    const result = await syncDevBridgeProjects()
    if (result) return { mode: 'dev-bridge', result }
  }

  const result = await importCreatorHubConfig()
  return {
    mode: 'config-file',
    result,
    devImportUrl: isLocalhostEditor() ? undefined : 'http://localhost:5173/editor'
  }
}

async function applyDevBridgeProjects(
  projects: Awaited<ReturnType<typeof fetchDevBridgeProjects>>
): Promise<CreatorHubSyncResult> {
  let imported = 0
  let updated = 0
  for (const project of projects) {
    const list = readMetaList()
    const exists = list.some((p) => p.id === project.id)
    const prev = list.find((p) => p.id === project.id)
    const now = Date.now()
    const meta: LocalProjectMeta = {
      id: project.id,
      name: project.name,
      addedAt: prev?.addedAt ?? now,
      lastOpenedAt: prev?.lastOpenedAt ?? now,
      baseParcel: project.baseParcel,
      parcelCount: project.parcelCount,
      source: 'creator-hub',
      folderName: project.folderName,
      pathHint: project.absolutePath,
      accessMode: 'dev-bridge'
    }
    upsertMeta(meta)
    if (exists) updated++
    else imported++
  }
  return { imported, updated, total: projects.length }
}

/** Sync Creator Hub projects via the Vite dev file bridge (bypasses ~/Library browser blocks). */
export async function syncDevBridgeProjects(): Promise<CreatorHubSyncResult | null> {
  const health = await fetchDevBridgeHealth()
  if (!health?.ok) return null

  const projects = await fetchDevBridgeProjects()
  if (projects.length === 0) return { imported: 0, updated: 0, total: 0 }
  return applyDevBridgeProjects(projects)
}

export async function getDevBridgeStatus(): Promise<{
  available: boolean
  configPath: string | null
  projectCount: number
}> {
  const health = await fetchDevBridgeHealth()
  return {
    available: Boolean(health?.ok),
    configPath: health?.configPath ?? null,
    projectCount: health?.projectCount ?? 0
  }
}

export async function listProjects(): Promise<LocalProjectRecord[]> {
  const list = readMetaList()
  const out: LocalProjectRecord[] = []
  for (const meta of list) {
    const permission = await resolveProjectPermission(meta)
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

export async function requestProjectRoot(projectId: string): Promise<ProjectRoot> {
  const meta = await getProjectMeta(projectId)
  const handle = await getHandle(projectId)
  if (handle) {
    const perm = await handle.requestPermission({ mode: 'readwrite' })
    if (perm !== 'granted') throw new Error('Folder access was denied.')
    await touchProjectOpened(projectId)
    return { kind: 'fsa', handle, label: meta?.name ?? handle.name }
  }

  if (meta?.accessMode === 'dev-bridge' && meta.pathHint && (await isDevBridgeAvailable())) {
    await touchProjectOpened(projectId)
    return {
      kind: 'dev-bridge',
      absolutePath: meta.pathHint,
      projectId,
      label: meta.name
    }
  }

  throw new Error(
    'Project folder not connected. On live builds: Link Scenes folder or Connect and pick the scene directory. ' +
      'Locally: Sync Creator Hub (dev) while npm run dev is running.'
  )
}

/** @deprecated Use requestProjectRoot */
export async function requestProjectHandle(projectId: string): Promise<FileSystemDirectoryHandle> {
  const root = await requestProjectRoot(projectId)
  if (root.kind !== 'fsa') {
    throw new Error('This project uses the dev file bridge — requestProjectRoot instead.')
  }
  return root.handle
}

export async function relinkProject(projectId: string): Promise<LocalProjectRecord | null> {
  if (!isFileSystemAccessSupported()) {
    throw new Error('File System Access API is not supported in this browser.')
  }
  try {
    const handle = await window.showDirectoryPicker({ mode: 'readwrite' })
    const record = await registerProjectFromHandle(handle, {
      projectId,
      source: isCreatorHubProjectId(projectId) ? 'creator-hub' : 'manual'
    })
    return record
  } catch (e) {
    throw new Error(formatFilePickerError(e))
  }
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