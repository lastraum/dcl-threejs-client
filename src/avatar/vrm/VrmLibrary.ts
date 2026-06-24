import { VRM_LIBRARY_META_KEY, VRM_MAX_BYTES } from './constants'
import { sha256Hex } from './vrmHash'
import {
  deleteVrmBytes,
  readVrmBytes,
  readVrmMetaStore,
  writeVrmBytes,
  writeVrmMetaStore
} from './vrmByteCache'

export type VrmLibraryEntry = {
  contentHash: string
  fileName: string
  byteSize: number
  addedAt: number
  thumbnailDataUrl?: string
}

type LibraryIndex = VrmLibraryEntry[]

async function readIndex(): Promise<LibraryIndex> {
  const index = await readVrmMetaStore<LibraryIndex>(VRM_LIBRARY_META_KEY)
  return Array.isArray(index) ? index : []
}

async function writeIndex(index: LibraryIndex): Promise<void> {
  await writeVrmMetaStore(VRM_LIBRARY_META_KEY, index)
}

export function formatVrmByteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export async function listVrmLibrary(): Promise<VrmLibraryEntry[]> {
  const index = await readIndex()
  return [...index].sort((a, b) => b.addedAt - a.addedAt)
}

export async function getVrmLibraryEntry(contentHash: string): Promise<VrmLibraryEntry | null> {
  const key = contentHash.toLowerCase()
  const index = await readIndex()
  return index.find((e) => e.contentHash === key) ?? null
}

export async function loadVrmLibraryBytes(contentHash: string): Promise<ArrayBuffer | null> {
  return readVrmBytes(contentHash.toLowerCase())
}

export async function addVrmFile(file: File): Promise<VrmLibraryEntry> {
  if (!file.name.toLowerCase().endsWith('.vrm')) {
    throw new Error('Only .vrm files are supported')
  }
  if (file.size <= 0) throw new Error('File is empty')
  if (file.size > VRM_MAX_BYTES) {
    throw new Error(`VRM must be under ${formatVrmByteSize(VRM_MAX_BYTES)}`)
  }

  const bytes = await file.arrayBuffer()
  const contentHash = await sha256Hex(bytes)
  const existing = await getVrmLibraryEntry(contentHash)
  if (existing) return existing

  await writeVrmBytes(contentHash, bytes)
  const entry: VrmLibraryEntry = {
    contentHash,
    fileName: file.name,
    byteSize: bytes.byteLength,
    addedAt: Date.now()
  }

  const index = await readIndex()
  index.push(entry)
  await writeIndex(index)
  return entry
}

export async function removeVrmFromLibrary(contentHash: string): Promise<void> {
  const key = contentHash.toLowerCase()
  await deleteVrmBytes(key)
  const index = await readIndex()
  await writeIndex(index.filter((e) => e.contentHash !== key))
}

export async function updateVrmThumbnail(contentHash: string, thumbnailDataUrl: string): Promise<void> {
  const key = contentHash.toLowerCase()
  const index = await readIndex()
  const entry = index.find((e) => e.contentHash === key)
  if (!entry) return
  entry.thumbnailDataUrl = thumbnailDataUrl
  await writeIndex(index)
}