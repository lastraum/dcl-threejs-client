import { VRM_LIBRARY_META_KEY, VRM_MAX_BYTES, type CustomAvatarFormat } from './constants'
import { sha256Hex } from './vrmHash'
import {
  deleteVrmBytes,
  readVrmBytes,
  readVrmMetaStore,
  writeVrmBytes,
  writeVrmMetaStore
} from './vrmByteCache'
import {
  fetchMmlText,
  fetchUrlBytes,
  parseMmlCharacter,
  type MmlAttachmentSpec
} from '../odk/parseMml'
import { validateOdkSkeleton } from '../odk/odkSkeleton'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'

export type VrmLibraryEntry = {
  contentHash: string
  fileName: string
  byteSize: number
  addedAt: number
  format: CustomAvatarFormat
  mmlSourceUrl?: string
  mmlAttachments?: MmlAttachmentSpec[]
  thumbnailDataUrl?: string
  /** opensourceavatars.com registry id when imported from OSA gallery. */
  osaSourceId?: string
  sourceModelUrl?: string
  externalThumbnailUrl?: string
}

type LibraryIndex = VrmLibraryEntry[]

let probeLoader: GLTFLoader | null = null

function getProbeLoader(): GLTFLoader {
  if (!probeLoader) probeLoader = new GLTFLoader()
  return probeLoader
}

async function readIndex(): Promise<LibraryIndex> {
  const index = await readVrmMetaStore<LibraryIndex>(VRM_LIBRARY_META_KEY)
  if (!Array.isArray(index)) return []
  return index.map((e) => ({
    ...e,
    format: e.format === 'odk' ? 'odk' : 'vrm'
  }))
}

async function writeIndex(index: LibraryIndex): Promise<void> {
  await writeVrmMetaStore(VRM_LIBRARY_META_KEY, index)
}

export function formatVrmByteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function compareLibraryName(a: VrmLibraryEntry, b: VrmLibraryEntry): number {
  return a.fileName.localeCompare(b.fileName, undefined, { sensitivity: 'base' })
}

export async function listVrmLibrary(): Promise<VrmLibraryEntry[]> {
  const index = await readIndex()
  return [...index].sort(compareLibraryName)
}

export async function findVrmLibraryByOsaId(osaSourceId: string): Promise<VrmLibraryEntry | null> {
  const key = osaSourceId.toLowerCase()
  const index = await readIndex()
  return index.find((e) => e.osaSourceId?.toLowerCase() === key) ?? null
}

export async function getVrmLibraryEntry(contentHash: string): Promise<VrmLibraryEntry | null> {
  const key = contentHash.toLowerCase()
  const index = await readIndex()
  return index.find((e) => e.contentHash === key) ?? null
}

export async function loadVrmLibraryBytes(contentHash: string): Promise<ArrayBuffer | null> {
  return readVrmBytes(contentHash.toLowerCase())
}

async function validateOdkGlbBytes(bytes: ArrayBuffer): Promise<void> {
  const gltf = await getProbeLoader().parseAsync(bytes, '')
  const validation = validateOdkSkeleton(gltf.scene)
  if (!validation.ok) {
    throw new Error(`Not a valid ODK skeleton — missing: ${validation.missing.join(', ')}`)
  }
}

async function storeLibraryEntry(
  bytes: ArrayBuffer,
  fileName: string,
  format: CustomAvatarFormat,
  extra?: Pick<
    VrmLibraryEntry,
    'mmlSourceUrl' | 'mmlAttachments' | 'osaSourceId' | 'sourceModelUrl' | 'externalThumbnailUrl'
  >
): Promise<VrmLibraryEntry> {
  if (bytes.byteLength <= 0) throw new Error('File is empty')
  if (bytes.byteLength > VRM_MAX_BYTES) {
    throw new Error(`Avatar must be under ${formatVrmByteSize(VRM_MAX_BYTES)}`)
  }

  const contentHash = await sha256Hex(bytes)
  const existing = await getVrmLibraryEntry(contentHash)
  if (existing) {
    if (extra?.osaSourceId && !existing.osaSourceId) {
      const index = await readIndex()
      const row = index.find((e) => e.contentHash === contentHash)
      if (row) {
        Object.assign(row, extra)
        await writeIndex(index)
        return { ...existing, ...extra }
      }
    }
    return existing
  }

  await writeVrmBytes(contentHash, bytes)
  const entry: VrmLibraryEntry = {
    contentHash,
    fileName,
    byteSize: bytes.byteLength,
    addedAt: Date.now(),
    format,
    ...extra
  }

  const index = await readIndex()
  index.push(entry)
  await writeIndex(index)
  return entry
}

export async function addVrmFile(file: File): Promise<VrmLibraryEntry> {
  if (!file.name.toLowerCase().endsWith('.vrm')) {
    throw new Error('Only .vrm files are supported')
  }
  const bytes = await file.arrayBuffer()
  return storeLibraryEntry(bytes, file.name, 'vrm')
}

export async function addVrmFromUrl(
  url: string,
  fileName: string,
  extra?: Pick<VrmLibraryEntry, 'osaSourceId' | 'sourceModelUrl' | 'externalThumbnailUrl'>
): Promise<VrmLibraryEntry> {
  const trimmed = url.trim()
  if (!trimmed) throw new Error('VRM URL is required')
  const bytes = await fetchUrlBytes(trimmed)
  return storeLibraryEntry(bytes, fileName, 'vrm', {
    sourceModelUrl: trimmed,
    ...extra
  })
}

export async function addMmlFile(file: File): Promise<VrmLibraryEntry> {
  if (!file.name.toLowerCase().endsWith('.mml')) {
    throw new Error('Only .mml files are supported')
  }
  const text = await file.text()
  const baseUrl =
    typeof window !== 'undefined' ? window.location.href : undefined
  return importMmlText(text, file.name, baseUrl)
}

export async function addMmlFromUrl(url: string): Promise<VrmLibraryEntry> {
  const trimmed = url.trim()
  if (!trimmed) throw new Error('MML URL is required')
  const { text, baseUrl } = await fetchMmlText(trimmed)
  const fileName = trimmed.split('/').pop()?.split('?')[0] || 'avatar.mml'
  return importMmlText(text, fileName, baseUrl, trimmed)
}

async function importMmlText(
  text: string,
  fileName: string,
  baseUrl?: string,
  mmlSourceUrl?: string
): Promise<VrmLibraryEntry> {
  const spec = parseMmlCharacter(text, baseUrl)
  const bytes = await fetchUrlBytes(spec.bodySrc)
  await validateOdkGlbBytes(bytes)
  return storeLibraryEntry(bytes, fileName, 'odk', {
    mmlSourceUrl,
    mmlAttachments: spec.attachments.length ? spec.attachments : undefined
  })
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