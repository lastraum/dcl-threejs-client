import {
  getPetLibraryEntry,
  removePetFromLibrary,
  storePetEntry,
  updatePetLibraryAnimClipMap,
  updatePetLibraryCategory,
  updatePetLibraryMeshYaw
} from '../PetLibrary'
import {
  getActivePetEntry,
  getPetInventory,
  removeOwnedPet,
  setActivePetHash,
  setOwnedPetAnimClipMap,
  setOwnedPetCategory,
  setOwnedPetClipNames,
  setOwnedPetMeshYawOffset,
  setOwnedPetNickname,
  upsertOwnedPet
} from '../petInventoryStorage'
import { isPetAnimState, normalizeAnimClipMap } from '../petCategories'
import type { PetAnimClipMap } from '../types'
import { petBarnContentUrl } from './config'
import { getPetBarnAdded, markPetBarnAdded } from './addedStore'
import type { PetBarnListing } from './types'
import type { PetLibraryEntry } from '../types'

export type AddFromBarnResult =
  | { ok: true; entry: PetLibraryEntry; alreadyAdded: boolean }
  | { ok: false; error: string }

export type RefreshFromBarnResult =
  | { ok: true; entry: PetLibraryEntry; wasActive: boolean }
  | { ok: false; error: string }

/**
 * Download one barn listing GLB and store in local library + inventory.
 * Does not download if already marked added (returns existing path via contentHash when possible).
 */
export async function addPetFromBarn(
  listing: PetBarnListing,
  contentBaseUrl: string,
  wallet: string | null
): Promise<AddFromBarnResult> {
  const existing = getPetBarnAdded(listing.id)
  if (existing) {
    // Still ensure library has bytes? If missing, re-download.
    const { loadPetLibraryBytes, getPetLibraryEntry } = await import('../PetLibrary')
    const bytes = await loadPetLibraryBytes(existing.contentHash)
    const lib = await getPetLibraryEntry(existing.contentHash)
    if (bytes && lib) {
      if (wallet) upsertOwnedPet(wallet, lib)
      return { ok: true, entry: lib, alreadyAdded: true }
    }
  }

  if (!listing.glbCid) {
    return { ok: false, error: 'Listing has no glbCid' }
  }

  const url = petBarnContentUrl(contentBaseUrl, listing.glbCid)
  let res: Response
  try {
    res = await fetch(url, { method: 'GET' })
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Network error downloading pet'
    }
  }
  if (!res.ok) {
    return { ok: false, error: `Download failed (${res.status})` }
  }
  const bytes = await res.arrayBuffer()
  if (bytes.byteLength <= 0) {
    return { ok: false, error: 'Downloaded file is empty' }
  }

  try {
    const entry = await storePetEntry(bytes, `${listing.petName || 'barn-pet'}.glb`, listing.type, {
      nickname: listing.petName
    })
    // Prefer catalog clip names when library discovery is empty
    if ((!entry.clipNames || !entry.clipNames.length) && listing.clipNames?.length) {
      entry.clipNames = [...listing.clipNames]
    }
    if (wallet) {
      upsertOwnedPet(wallet, entry)
      if (entry.clipNames?.length) {
        setOwnedPetClipNames(wallet, entry.contentHash, entry.clipNames)
      }
    }
    markPetBarnAdded({
      barnId: listing.id,
      contentHash: entry.contentHash,
      glbCid: listing.glbCid,
      petName: listing.petName,
      type: listing.type
    })
    return { ok: true, entry, alreadyAdded: false }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Failed to store pet locally'
    }
  }
}

/** Keep only clip names that exist on the new GLB; drop empty states. */
function clipMapForNewGlb(
  raw: PetAnimClipMap | undefined,
  clipNames: string[] | undefined
): PetAnimClipMap | undefined {
  const map = normalizeAnimClipMap(raw)
  if (!map) return undefined
  const allow = new Set(clipNames ?? [])
  if (!allow.size) return undefined
  const next: PetAnimClipMap = {}
  for (const [state, names] of Object.entries(map)) {
    if (!isPetAnimState(state) || !names?.length) continue
    const keep = names.filter((n) => allow.has(n))
    if (keep.length) next[state] = keep
  }
  return Object.keys(next).length ? next : undefined
}

/** Swap a stale barn GLB; keep inventory nickname / category / yaw / clip map. */
export async function refreshPetFromBarn(
  listing: PetBarnListing,
  contentBaseUrl: string,
  wallet: string | null,
  oldContentHash: string
): Promise<RefreshFromBarnResult> {
  if (!listing.glbCid) {
    return { ok: false, error: 'Listing has no glbCid' }
  }
  const oldLib = await getPetLibraryEntry(oldContentHash)
  const oldOwned = wallet
    ? getPetInventory(wallet).owned.find(
        (e) => e.contentHash.toLowerCase() === oldContentHash.toLowerCase()
      )
    : undefined
  const nickname = oldOwned?.nickname?.trim() || oldLib?.nickname?.trim() || listing.petName
  const category = oldOwned?.category ?? oldLib?.category
  const meshYawOffsetDeg = oldOwned?.meshYawOffsetDeg ?? oldLib?.meshYawOffsetDeg
  const rawClipMap = oldOwned?.animClipMap ?? oldLib?.animClipMap

  const url = petBarnContentUrl(contentBaseUrl, listing.glbCid)
  let res: Response
  try {
    res = await fetch(url, { method: 'GET' })
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Network error downloading pet'
    }
  }
  if (!res.ok) {
    return { ok: false, error: `Download failed (${res.status})` }
  }
  const bytes = await res.arrayBuffer()
  if (bytes.byteLength <= 0) {
    return { ok: false, error: 'Downloaded file is empty' }
  }

  try {
    const entry = await storePetEntry(bytes, `${listing.petName || 'barn-pet'}.glb`, listing.type, {
      nickname
    })
    if ((!entry.clipNames || !entry.clipNames.length) && listing.clipNames?.length) {
      entry.clipNames = [...listing.clipNames]
    }
    const clipMap = clipMapForNewGlb(rawClipMap, entry.clipNames)
    if (category && category !== entry.category) {
      entry.category = category
      await updatePetLibraryCategory(entry.contentHash, category)
    }
    if (typeof meshYawOffsetDeg === 'number') {
      entry.meshYawOffsetDeg = meshYawOffsetDeg
      await updatePetLibraryMeshYaw(entry.contentHash, meshYawOffsetDeg)
    }
    if (clipMap) {
      entry.animClipMap = clipMap
      await updatePetLibraryAnimClipMap(entry.contentHash, clipMap)
    }

    let wasActive = false
    if (wallet) {
      upsertOwnedPet(wallet, entry)
      setOwnedPetNickname(wallet, entry.contentHash, nickname)
      if (entry.clipNames?.length) {
        setOwnedPetClipNames(wallet, entry.contentHash, entry.clipNames)
      }
      setOwnedPetCategory(wallet, entry.contentHash, entry.category)
      if (typeof meshYawOffsetDeg === 'number') {
        setOwnedPetMeshYawOffset(wallet, entry.contentHash, meshYawOffsetDeg)
      }
      if (clipMap) setOwnedPetAnimClipMap(wallet, entry.contentHash, clipMap)
      wasActive = getActivePetEntry(wallet)?.contentHash === oldContentHash
      if (wasActive) setActivePetHash(wallet, entry.contentHash)
    }

    // Point the added-flag at the new bytes BEFORE removing the old ones —
    // removePetFromLibrary clears added rows by contentHash, so this order
    // leaves exactly one row (the fresh one) behind.
    markPetBarnAdded({
      barnId: listing.id,
      contentHash: entry.contentHash,
      glbCid: listing.glbCid,
      petName: listing.petName,
      type: listing.type
    })
    if (oldContentHash !== entry.contentHash) {
      if (wallet) removeOwnedPet(wallet, oldContentHash)
      await removePetFromLibrary(oldContentHash)
    }
    return { ok: true, entry, wasActive }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Failed to store pet locally'
    }
  }
}
