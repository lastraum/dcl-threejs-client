import { storePetEntry } from '../PetLibrary'
import { upsertOwnedPet, setOwnedPetClipNames } from '../petInventoryStorage'
import { petBarnContentUrl } from './config'
import { getPetBarnAdded, markPetBarnAdded } from './addedStore'
import type { PetBarnListing } from './types'
import type { PetLibraryEntry } from '../types'

export type AddFromBarnResult =
  | { ok: true; entry: PetLibraryEntry; alreadyAdded: boolean }
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
