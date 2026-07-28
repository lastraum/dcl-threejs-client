import { sha256Hex } from '../avatar/vrm/vrmHash'
import { PET_MAX_BYTES } from './constants'
import {
  cacheRemotePetBytes,
  getPetLibraryEntry,
  loadPetLibraryBytes,
  updatePetLibraryAnimClipMap,
  updatePetLibraryClipNames,
  updatePetLibraryMeshYaw
} from './PetLibrary'
import type { PetAnimClipMap, PetCategory, PetLibraryEntry } from './types'

/**
 * A pet GLB that ships in `public/` — listed in the panel for everyone without
 * an upload, and equipped through the same toggle as an uploaded pet.
 *
 * `contentHash` is the sha256 of the bundled file and is verified after every
 * fetch, so a built-in is byte-identical across clients: peers already holding
 * it skip the DPET transfer entirely (see PetPeerSync.requestPeerPet).
 */
export type BuiltinPet = {
  contentHash: string
  /** Root-absolute URL under public/. */
  url: string
  fileName: string
  nickname: string
  category: PetCategory
  byteSize: number
  meshYawOffsetDeg: number
  /** Clip names baked into the GLB — lets the mapper render before download. */
  clipNames: string[]
  animClipMap: PetAnimClipMap
}

export const BUILTIN_PETS: readonly BuiltinPet[] = [
  {
    contentHash: 'd51f4f4bf21db36dac18413cd0c72ee5bda91abfc7452797a9b4cb9ca246bce6',
    url: '/pets/Doggo01_rigged.glb',
    fileName: 'Doggo01_rigged.glb',
    nickname: 'Pebbles',
    category: 'walking',
    byteSize: 1_346_704,
    // Export faces away from travel direction.
    meshYawOffsetDeg: 180,
    clipNames: ['Idle', 'Sit', 'Walk', 'Trot', 'Run', 'Run2'],
    animClipMap: {
      idle: ['Idle'],
      walk: ['Walk'],
      trot: ['Trot'],
      // Two gallop takes — picked at random each time the run band is entered.
      run: ['Run2', 'Run'],
      // Bound to AFK only, so the mapper reads "AFK" for the Sit track. The sit
      // band still resolves the Sit clip through the walking aliases.
      afk: ['Sit']
    }
  }
] as const

const BY_HASH = new Map<string, BuiltinPet>(
  BUILTIN_PETS.map((p) => [p.contentHash.toLowerCase(), p])
)

export function getBuiltinPet(contentHash: string): BuiltinPet | null {
  return BY_HASH.get(contentHash.toLowerCase()) ?? null
}

export function isBuiltinPetHash(contentHash: string): boolean {
  return BY_HASH.has(contentHash.toLowerCase())
}

/** Panel row for a built-in, listable before the GLB has been downloaded. */
export function builtinPetToLibraryEntry(pet: BuiltinPet): PetLibraryEntry {
  return {
    contentHash: pet.contentHash,
    fileName: pet.fileName,
    byteSize: pet.byteSize,
    addedAt: 0,
    category: pet.category,
    nickname: pet.nickname,
    meshYawOffsetDeg: pet.meshYawOffsetDeg,
    clipNames: [...pet.clipNames],
    animClipMap: { ...pet.animClipMap }
  }
}

const inflight = new Map<string, Promise<PetLibraryEntry | null>>()

/**
 * Download a built-in into the local byte cache if it is not already there, and
 * seed its shipped defaults (category / face offset / clip map).
 *
 * Caches bytes only — inventory ownership is the panel's call. Returns null if
 * the fetch fails or the bytes do not match the manifest hash.
 */
export async function ensureBuiltinPetBytes(
  contentHash: string
): Promise<PetLibraryEntry | null> {
  const hash = contentHash.toLowerCase()
  const pet = BY_HASH.get(hash)
  if (!pet) return null

  const existing = await loadPetLibraryBytes(hash)
  if (existing && existing.byteLength === pet.byteSize) {
    return (await getPetLibraryEntry(hash)) ?? builtinPetToLibraryEntry(pet)
  }

  const pending = inflight.get(hash)
  if (pending) return pending

  const task = (async (): Promise<PetLibraryEntry | null> => {
    try {
      const res = await fetch(pet.url)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const bytes = await res.arrayBuffer()
      if (bytes.byteLength <= 0 || bytes.byteLength > PET_MAX_BYTES) {
        throw new Error(`unexpected size ${bytes.byteLength}`)
      }
      // Peers trust that this hash means these exact bytes — never cache a mismatch.
      const digest = await sha256Hex(bytes)
      if (digest !== hash) {
        throw new Error(`hash mismatch (got ${digest.slice(0, 12)}…)`)
      }
      await cacheRemotePetBytes(hash, bytes, pet.fileName, pet.category)
      await updatePetLibraryMeshYaw(hash, pet.meshYawOffsetDeg)
      await updatePetLibraryClipNames(hash, pet.clipNames)
      await updatePetLibraryAnimClipMap(hash, pet.animClipMap)
      return (await getPetLibraryEntry(hash)) ?? builtinPetToLibraryEntry(pet)
    } catch (err) {
      console.warn(`[pets] failed to load built-in pet ${pet.fileName}`, err)
      return null
    } finally {
      inflight.delete(hash)
    }
  })()

  inflight.set(hash, task)
  return task
}
