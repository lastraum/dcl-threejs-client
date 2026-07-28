import { sha256Hex } from '../avatar/vrm/vrmHash'
import { PET_LIBRARY_META_KEY, PET_MAX_BYTES } from './constants'
import {
  deletePetBytes,
  readPetBytes,
  readPetMetaStore,
  writePetBytes,
  writePetMetaStore
} from './petByteCache'
import { normalizeAnimClipMap, normalizePetCategory } from './petCategories'
import { normalizeMeshYawOffsetDeg } from './petInventoryStorage'
import { parsePetGlbBytes } from './parsePetGlb'
import type { PetAnimClipMap, PetCategory, PetLibraryEntry } from './types'
import * as THREE from 'three'

type LibraryIndex = PetLibraryEntry[]

function formatByteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

async function readIndex(): Promise<LibraryIndex> {
  const index = await readPetMetaStore<LibraryIndex>(PET_LIBRARY_META_KEY)
  if (!Array.isArray(index)) return []
  return index.map((e) => ({
    ...e,
    contentHash: e.contentHash.toLowerCase(),
    category: normalizePetCategory(e.category),
    meshYawOffsetDeg:
      typeof e.meshYawOffsetDeg === 'number'
        ? normalizeMeshYawOffsetDeg(e.meshYawOffsetDeg)
        : undefined,
    clipNames: Array.isArray(e.clipNames)
      ? e.clipNames.filter((n): n is string => typeof n === 'string' && n.trim().length > 0)
      : undefined,
    animClipMap: normalizeAnimClipMap(e.animClipMap)
  }))
}

/** List animation clip names baked into a stored pet GLB. */
export async function listPetClipNames(contentHash: string): Promise<string[]> {
  const bytes = await loadPetLibraryBytes(contentHash)
  if (!bytes) return []
  try {
    const gltf = await parsePetGlbBytes(bytes)
    const names = (gltf.animations ?? [])
      .map((c) => c?.name?.trim())
      .filter((n): n is string => !!n)
    gltf.scene.traverse((node) => {
      const mesh = node as THREE.Mesh
      if (mesh.isMesh) {
        mesh.geometry?.dispose()
        const mat = mesh.material
        if (Array.isArray(mat)) mat.forEach((m) => m.dispose())
        else mat?.dispose()
      }
    })
    return [...new Set(names)]
  } catch (err) {
    console.warn('[pets] listPetClipNames failed', err)
    return []
  }
}

async function discoverClipNames(bytes: ArrayBuffer): Promise<string[]> {
  try {
    const gltf = await parsePetGlbBytes(bytes)
    const names = (gltf.animations ?? [])
      .map((c) => c?.name?.trim())
      .filter((n): n is string => !!n)
    gltf.scene.traverse((node) => {
      const mesh = node as THREE.Mesh
      if (mesh.isMesh) {
        mesh.geometry?.dispose()
        const mat = mesh.material
        if (Array.isArray(mat)) mat.forEach((m) => m.dispose())
        else mat?.dispose()
      }
    })
    return [...new Set(names)]
  } catch {
    return []
  }
}

async function writeIndex(index: LibraryIndex): Promise<void> {
  await writePetMetaStore(PET_LIBRARY_META_KEY, index)
}

export function formatPetByteSize(bytes: number): string {
  return formatByteSize(bytes)
}

export async function listPetLibrary(): Promise<PetLibraryEntry[]> {
  const index = await readIndex()
  return [...index].sort((a, b) =>
    a.fileName.localeCompare(b.fileName, undefined, { sensitivity: 'base' })
  )
}

export async function getPetLibraryEntry(contentHash: string): Promise<PetLibraryEntry | null> {
  const key = contentHash.toLowerCase()
  const index = await readIndex()
  return index.find((e) => e.contentHash === key) ?? null
}

export async function loadPetLibraryBytes(contentHash: string): Promise<ArrayBuffer | null> {
  return readPetBytes(contentHash.toLowerCase())
}

export async function addPetFile(file: File, category: PetCategory): Promise<PetLibraryEntry> {
  const name = file.name.toLowerCase()
  if (!name.endsWith('.glb') && !name.endsWith('.gltf')) {
    throw new Error('Only .glb / .gltf pet models are supported')
  }
  const bytes = await file.arrayBuffer()
  return storePetEntry(bytes, file.name, category)
}

export async function storePetEntry(
  bytes: ArrayBuffer,
  fileName: string,
  category: PetCategory,
  extra?: { nickname?: string }
): Promise<PetLibraryEntry> {
  if (bytes.byteLength <= 0) throw new Error('File is empty')
  if (bytes.byteLength > PET_MAX_BYTES) {
    throw new Error(`Pet must be under ${formatByteSize(PET_MAX_BYTES)}`)
  }

  const contentHash = await sha256Hex(bytes)
  const existing = await getPetLibraryEntry(contentHash)
  if (existing) {
    // Update category / nickname if re-uploaded.
    const index = await readIndex()
    const row = index.find((e) => e.contentHash === contentHash)
    if (row) {
      row.category = normalizePetCategory(category)
      if (extra?.nickname) row.nickname = extra.nickname
      await writeIndex(index)
      return { ...row }
    }
    return existing
  }

  await writePetBytes(contentHash, bytes)
  const clipNames = await discoverClipNames(bytes)
  const entry: PetLibraryEntry = {
    contentHash,
    fileName,
    byteSize: bytes.byteLength,
    addedAt: Date.now(),
    category: normalizePetCategory(category),
    nickname: extra?.nickname,
    clipNames: clipNames.length ? clipNames : undefined
  }
  const index = await readIndex()
  index.push(entry)
  await writeIndex(index)
  return entry
}

/** Cache remote peer pet bytes after DPET fetch (no inventory ownership). */
export async function cacheRemotePetBytes(
  contentHash: string,
  bytes: ArrayBuffer,
  fileName = 'remote-pet.glb',
  category: PetCategory = 'walking'
): Promise<void> {
  const hash = contentHash.toLowerCase()
  if (bytes.byteLength <= 0 || bytes.byteLength > PET_MAX_BYTES) return
  const existing = await loadPetLibraryBytes(hash)
  if (existing && existing.byteLength === bytes.byteLength) {
    // Already have a full-size copy — keep it (hash verified by caller when from DPET).
    return
  }
  // Overwrite truncated/corrupt prior cache from a failed transfer.
  await writePetBytes(hash, bytes)
  const index = await readIndex()
  const row = index.find((e) => e.contentHash === hash)
  if (row) {
    row.byteSize = bytes.byteLength
    row.category = normalizePetCategory(category)
    row.fileName = row.fileName || fileName
  } else {
    index.push({
      contentHash: hash,
      fileName,
      byteSize: bytes.byteLength,
      addedAt: Date.now(),
      category: normalizePetCategory(category)
    })
  }
  await writeIndex(index)
}

export async function updatePetLibraryMeshYaw(
  contentHash: string,
  meshYawOffsetDeg: number
): Promise<PetLibraryEntry | null> {
  const hash = contentHash.toLowerCase()
  const index = await readIndex()
  const row = index.find((e) => e.contentHash === hash)
  if (!row) return null
  const deg = normalizeMeshYawOffsetDeg(meshYawOffsetDeg)
  if (deg === 0) delete row.meshYawOffsetDeg
  else row.meshYawOffsetDeg = deg
  await writeIndex(index)
  return { ...row }
}

export async function updatePetLibraryCategory(
  contentHash: string,
  category: PetCategory
): Promise<PetLibraryEntry | null> {
  const hash = contentHash.toLowerCase()
  const index = await readIndex()
  const row = index.find((e) => e.contentHash === hash)
  if (!row) return null
  row.category = normalizePetCategory(category)
  await writeIndex(index)
  return { ...row }
}

export async function updatePetLibraryAnimClipMap(
  contentHash: string,
  animClipMap: PetAnimClipMap | null
): Promise<PetLibraryEntry | null> {
  const hash = contentHash.toLowerCase()
  const index = await readIndex()
  const row = index.find((e) => e.contentHash === hash)
  if (!row) return null
  const next = normalizeAnimClipMap(animClipMap)
  if (next) row.animClipMap = next
  else delete row.animClipMap
  await writeIndex(index)
  return { ...row }
}

export async function updatePetLibraryClipNames(
  contentHash: string,
  clipNames: string[]
): Promise<PetLibraryEntry | null> {
  const hash = contentHash.toLowerCase()
  const index = await readIndex()
  const row = index.find((e) => e.contentHash === hash)
  if (!row) return null
  row.clipNames = [...new Set(clipNames.filter((n) => n.trim()))]
  await writeIndex(index)
  return { ...row }
}

/** Ensure clipNames is populated (lazy scan for older library rows). */
export async function ensurePetLibraryClipNames(
  contentHash: string
): Promise<string[]> {
  const entry = await getPetLibraryEntry(contentHash)
  if (entry?.clipNames?.length) return entry.clipNames
  const names = await listPetClipNames(contentHash)
  if (names.length) await updatePetLibraryClipNames(contentHash, names)
  return names
}

export async function removePetFromLibrary(contentHash: string): Promise<void> {
  const hash = contentHash.toLowerCase()
  const index = await readIndex()
  const next = index.filter((e) => e.contentHash !== hash)
  await writeIndex(next)
  try {
    await deletePetBytes(hash)
  } catch {
    /* ignore */
  }
}

/** Drop corrupt/partial cached bytes so the next peer fetch can replace them. */
export async function invalidatePetLibraryBytes(contentHash: string): Promise<void> {
  const hash = contentHash.toLowerCase()
  try {
    await deletePetBytes(hash)
  } catch {
    /* ignore */
  }
  const index = await readIndex()
  const next = index.filter((e) => e.contentHash !== hash)
  if (next.length !== index.length) await writeIndex(next)
}
