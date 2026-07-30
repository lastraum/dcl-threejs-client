import { PETBARN_ADDED_STORAGE_KEY } from './constants'
import type { PetBarnAddedEntry, PetBarnAddedMap } from './types'
import type { PetCategory } from '../types'
import { normalizePetCategory } from '../petCategories'

function readMap(): PetBarnAddedMap {
  try {
    const raw = localStorage.getItem(PETBARN_ADDED_STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as PetBarnAddedMap
    if (!parsed || typeof parsed !== 'object') return {}
    return parsed
  } catch {
    return {}
  }
}

function writeMap(map: PetBarnAddedMap): void {
  try {
    localStorage.setItem(PETBARN_ADDED_STORAGE_KEY, JSON.stringify(map))
  } catch (err) {
    console.warn('[petBarn] failed to persist added map', err)
  }
}

export function listPetBarnAdded(): PetBarnAddedEntry[] {
  return Object.values(readMap()).sort((a, b) => b.addedAt - a.addedAt)
}

export function getPetBarnAdded(barnId: string): PetBarnAddedEntry | null {
  return readMap()[barnId] ?? null
}

export function isPetBarnAdded(barnId: string): boolean {
  return !!getPetBarnAdded(barnId)
}

export function markPetBarnAdded(entry: {
  barnId: string
  contentHash: string
  glbCid: string
  petName: string
  type: PetCategory
}): PetBarnAddedEntry {
  const map = readMap()
  const row: PetBarnAddedEntry = {
    barnId: entry.barnId,
    contentHash: entry.contentHash.toLowerCase(),
    glbCid: entry.glbCid,
    addedAt: Date.now(),
    petName: entry.petName,
    type: normalizePetCategory(entry.type)
  }
  map[entry.barnId] = row
  writeMap(map)
  return row
}

export function unmarkPetBarnAdded(barnId: string): void {
  const map = readMap()
  if (!map[barnId]) return
  delete map[barnId]
  writeMap(map)
}
