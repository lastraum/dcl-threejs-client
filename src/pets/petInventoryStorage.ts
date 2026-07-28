import { PET_INVENTORY_STORAGE_KEY } from './constants'
import { normalizeAnimClipMap, normalizePetCategory } from './petCategories'
import type { PetAnimClipMap, PetInventoryState, PetLibraryEntry } from './types'

type StoreMap = Record<string, PetInventoryState>

function emptyState(): PetInventoryState {
  return { owned: [], activeHash: null }
}

function normalizeEntry(raw: unknown): PetLibraryEntry | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const contentHash = typeof o.contentHash === 'string' ? o.contentHash.toLowerCase() : ''
  if (contentHash.length !== 64) return null
  const fileName = typeof o.fileName === 'string' && o.fileName.trim() ? o.fileName : 'pet.glb'
  const byteSize = typeof o.byteSize === 'number' && o.byteSize > 0 ? o.byteSize : 0
  const addedAt = typeof o.addedAt === 'number' ? o.addedAt : Date.now()
  const category = normalizePetCategory(o.category)
  const nickname = typeof o.nickname === 'string' && o.nickname.trim() ? o.nickname.trim() : undefined
  const meshYawOffsetDeg =
    typeof o.meshYawOffsetDeg === 'number' && Number.isFinite(o.meshYawOffsetDeg)
      ? normalizeMeshYawOffsetDeg(o.meshYawOffsetDeg)
      : undefined
  const clipNames = Array.isArray(o.clipNames)
    ? o.clipNames.filter((n): n is string => typeof n === 'string' && n.trim().length > 0)
    : undefined
  const animClipMap = normalizeAnimClipMap(o.animClipMap)
  return {
    contentHash,
    fileName,
    byteSize,
    addedAt,
    category,
    nickname,
    meshYawOffsetDeg,
    clipNames: clipNames?.length ? clipNames : undefined,
    animClipMap
  }
}

/** Snap to common export fixes; keep any finite degree value. */
export function normalizeMeshYawOffsetDeg(deg: number): number {
  const n = ((deg % 360) + 360) % 360
  // Prefer clean 0 / 90 / 180 / 270 when within 1°.
  for (const snap of [0, 90, 180, 270]) {
    if (Math.abs(n - snap) < 1 || Math.abs(n - snap - 360) < 1) return snap === 360 ? 0 : snap
  }
  return n > 180 ? n - 360 : n
}

function normalizeState(raw: unknown): PetInventoryState {
  if (!raw || typeof raw !== 'object') return emptyState()
  const o = raw as Record<string, unknown>
  const ownedRaw = Array.isArray(o.owned) ? o.owned : []
  const owned: PetLibraryEntry[] = []
  for (const row of ownedRaw) {
    const e = normalizeEntry(row)
    if (e) owned.push(e)
  }
  let activeHash =
    typeof o.activeHash === 'string' && o.activeHash.length === 64
      ? o.activeHash.toLowerCase()
      : null
  if (activeHash && !owned.some((e) => e.contentHash === activeHash)) activeHash = null
  return { owned, activeHash }
}

function readStore(): StoreMap {
  if (typeof window === 'undefined') return {}
  try {
    const raw = localStorage.getItem(PET_INVENTORY_STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as StoreMap
    if (!parsed || typeof parsed !== 'object') return {}
    const out: StoreMap = {}
    for (const [k, v] of Object.entries(parsed)) {
      out[k.toLowerCase()] = normalizeState(v)
    }
    return out
  } catch {
    return {}
  }
}

function writeStore(store: StoreMap): void {
  if (typeof window === 'undefined') return
  try {
    localStorage.setItem(PET_INVENTORY_STORAGE_KEY, JSON.stringify(store))
  } catch (err) {
    console.warn('[pets] failed to persist inventory', err)
  }
}

function walletKey(address?: string | null): string | null {
  const k = address?.trim().toLowerCase()
  return k || null
}

export function getPetInventory(address?: string | null): PetInventoryState {
  const key = walletKey(address)
  if (!key) return emptyState()
  return normalizeState(readStore()[key])
}

export function setPetInventory(address: string, state: PetInventoryState): void {
  const key = walletKey(address)
  if (!key) return
  const store = readStore()
  store[key] = normalizeState(state)
  writeStore(store)
}

export function upsertOwnedPet(address: string, entry: PetLibraryEntry): PetInventoryState {
  const state = getPetInventory(address)
  const hash = entry.contentHash.toLowerCase()
  const nextEntry: PetLibraryEntry = {
    ...entry,
    contentHash: hash,
    category: normalizePetCategory(entry.category)
  }
  const idx = state.owned.findIndex((e) => e.contentHash === hash)
  if (idx >= 0) state.owned[idx] = { ...state.owned[idx], ...nextEntry }
  else state.owned.push(nextEntry)
  setPetInventory(address, state)
  return state
}

export function removeOwnedPet(address: string, contentHash: string): PetInventoryState {
  const state = getPetInventory(address)
  const hash = contentHash.toLowerCase()
  state.owned = state.owned.filter((e) => e.contentHash !== hash)
  if (state.activeHash === hash) state.activeHash = null
  setPetInventory(address, state)
  return state
}

export function setActivePetHash(address: string, contentHash: string | null): PetInventoryState {
  const state = getPetInventory(address)
  const hash = contentHash?.toLowerCase() ?? null
  if (hash && !state.owned.some((e) => e.contentHash === hash)) {
    return state
  }
  state.activeHash = hash
  setPetInventory(address, state)
  return state
}

export function setOwnedPetCategory(
  address: string,
  contentHash: string,
  category: PetLibraryEntry['category']
): PetInventoryState {
  const state = getPetInventory(address)
  const hash = contentHash.toLowerCase()
  const row = state.owned.find((e) => e.contentHash === hash)
  if (row) {
    row.category = normalizePetCategory(category)
    setPetInventory(address, state)
  }
  return state
}

export function setOwnedPetNickname(
  address: string,
  contentHash: string,
  nickname: string | null
): PetInventoryState {
  const state = getPetInventory(address)
  const hash = contentHash.toLowerCase()
  const row = state.owned.find((e) => e.contentHash === hash)
  if (row) {
    const n = nickname?.trim()
    if (n) row.nickname = n
    else delete row.nickname
    setPetInventory(address, state)
  }
  return state
}

export function setOwnedPetMeshYawOffset(
  address: string,
  contentHash: string,
  meshYawOffsetDeg: number
): PetInventoryState {
  const state = getPetInventory(address)
  const hash = contentHash.toLowerCase()
  const row = state.owned.find((e) => e.contentHash === hash)
  if (row) {
    const deg = normalizeMeshYawOffsetDeg(meshYawOffsetDeg)
    if (deg === 0) delete row.meshYawOffsetDeg
    else row.meshYawOffsetDeg = deg
    setPetInventory(address, state)
  }
  return state
}

export function setOwnedPetAnimClipMap(
  address: string,
  contentHash: string,
  animClipMap: PetAnimClipMap | null
): PetInventoryState {
  const state = getPetInventory(address)
  const hash = contentHash.toLowerCase()
  const row = state.owned.find((e) => e.contentHash === hash)
  if (row) {
    const next = normalizeAnimClipMap(animClipMap)
    if (next) row.animClipMap = next
    else delete row.animClipMap
    setPetInventory(address, state)
  }
  return state
}

export function setOwnedPetClipNames(
  address: string,
  contentHash: string,
  clipNames: string[]
): PetInventoryState {
  const state = getPetInventory(address)
  const hash = contentHash.toLowerCase()
  const row = state.owned.find((e) => e.contentHash === hash)
  if (row) {
    row.clipNames = [...new Set(clipNames.filter((n) => n.trim()))]
    setPetInventory(address, state)
  }
  return state
}

export function getActivePetEntry(address?: string | null): PetLibraryEntry | null {
  const state = getPetInventory(address)
  if (!state.activeHash) return null
  return state.owned.find((e) => e.contentHash === state.activeHash) ?? null
}
