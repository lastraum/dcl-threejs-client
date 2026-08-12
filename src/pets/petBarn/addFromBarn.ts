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
  removeOwnedPet,
  setActivePetHash,
  setOwnedPetAnimClipMap,
  setOwnedPetCategory,
  setOwnedPetClipNames,
  setOwnedPetMeshYawOffset,
  upsertOwnedPet
} from '../petInventoryStorage'
import { normalizeAnimClipMap } from '../petCategories'
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

/**
 * Swap a stale library pet for its listing's current build.
 *
 * Listings are content-addressed snapshots: updating one in the Barn changes
 * what NEW adds download, but every library that already holds the old bytes
 * keeps them forever. This downloads the current GLB, carries the user's
 * settings (nickname, locomotion, face offset, clip map) onto the new entry,
 * re-activates it if the old pet was equipped, and only then removes the old
 * bytes — so a mid-refresh failure leaves the working pet in place.
 */
export async function refreshPetFromBarn(
  listing: PetBarnListing,
  contentBaseUrl: string,
  wallet: string | null,
  oldContentHash: string
): Promise<RefreshFromBarnResult> {
  if (!listing.glbCid) {
    return { ok: false, error: 'Listing has no glbCid' }
  }
  const old = await getPetLibraryEntry(oldContentHash)

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
      nickname: old?.nickname?.trim() ? old.nickname : listing.petName
    })
    if ((!entry.clipNames || !entry.clipNames.length) && listing.clipNames?.length) {
      entry.clipNames = [...listing.clipNames]
    }
    // Carry user tuning from the old entry onto the new bytes.
    if (old) {
      if (old.category && old.category !== entry.category) {
        entry.category = old.category
        await updatePetLibraryCategory(entry.contentHash, old.category)
      }
      if (typeof old.meshYawOffsetDeg === 'number') {
        entry.meshYawOffsetDeg = old.meshYawOffsetDeg
        await updatePetLibraryMeshYaw(entry.contentHash, old.meshYawOffsetDeg)
      }
      const map = normalizeAnimClipMap(old.animClipMap)
      if (map) {
        entry.animClipMap = map
        await updatePetLibraryAnimClipMap(entry.contentHash, map)
      }
    }

    let wasActive = false
    if (wallet) {
      upsertOwnedPet(wallet, entry)
      if (entry.clipNames?.length) {
        setOwnedPetClipNames(wallet, entry.contentHash, entry.clipNames)
      }
      if (old) {
        setOwnedPetCategory(wallet, entry.contentHash, entry.category)
        if (typeof old.meshYawOffsetDeg === 'number') {
          setOwnedPetMeshYawOffset(wallet, entry.contentHash, old.meshYawOffsetDeg)
        }
        const map = normalizeAnimClipMap(old.animClipMap)
        if (map) setOwnedPetAnimClipMap(wallet, entry.contentHash, map)
      }
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
