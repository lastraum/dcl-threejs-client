import { VRM_EQUIP_STORAGE_KEY } from './constants'

type EquipStore = Record<string, string | null>

function readStore(): EquipStore {
  if (typeof window === 'undefined') return {}
  try {
    const raw = localStorage.getItem(VRM_EQUIP_STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as EquipStore
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function writeStore(store: EquipStore): void {
  if (typeof window === 'undefined') return
  try {
    localStorage.setItem(VRM_EQUIP_STORAGE_KEY, JSON.stringify(store))
  } catch (err) {
    console.warn('[vrm] failed to persist equip prefs', err)
  }
}

export function getEquippedVrmHash(address?: string | null): string | null {
  if (!address) return null
  const hash = readStore()[address.toLowerCase()]
  return typeof hash === 'string' && hash.length === 64 ? hash : null
}

export function setEquippedVrmHash(address: string, contentHash: string | null): void {
  const key = address.toLowerCase()
  const store = readStore()
  if (contentHash) {
    store[key] = contentHash.toLowerCase()
  } else {
    delete store[key]
  }
  writeStore(store)
}

export function isVrmEquipped(address?: string | null): boolean {
  return !!getEquippedVrmHash(address)
}