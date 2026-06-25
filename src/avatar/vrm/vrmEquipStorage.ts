import { VRM_EQUIP_STORAGE_KEY, type CustomAvatarFormat } from './constants'

export type EquippedCustomAvatar = {
  format: CustomAvatarFormat
  contentHash: string
}

type EquipStore = Record<string, EquippedCustomAvatar | string | null>

function normalizeEntry(value: EquippedCustomAvatar | string | null | undefined): EquippedCustomAvatar | null {
  if (!value) return null
  if (typeof value === 'string') {
    return value.length === 64 ? { format: 'vrm', contentHash: value.toLowerCase() } : null
  }
  if (typeof value.contentHash === 'string' && value.contentHash.length === 64) {
    return {
      format: value.format === 'odk' ? 'odk' : 'vrm',
      contentHash: value.contentHash.toLowerCase()
    }
  }
  return null
}

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
    console.warn('[avatar] failed to persist equip prefs', err)
  }
}

export function getEquippedCustomAvatar(address?: string | null): EquippedCustomAvatar | null {
  if (!address) return null
  return normalizeEntry(readStore()[address.toLowerCase()])
}

export function setEquippedCustomAvatar(
  address: string,
  equip: EquippedCustomAvatar | null
): void {
  const key = address.toLowerCase()
  const store = readStore()
  if (equip) {
    store[key] = {
      format: equip.format === 'odk' ? 'odk' : 'vrm',
      contentHash: equip.contentHash.toLowerCase()
    }
  } else {
    delete store[key]
  }
  writeStore(store)
}

/** @deprecated Use getEquippedCustomAvatar — returns hash when any custom avatar is equipped. */
export function getEquippedVrmHash(address?: string | null): string | null {
  return getEquippedCustomAvatar(address)?.contentHash ?? null
}

export function setEquippedVrmHash(address: string, contentHash: string | null): void {
  if (contentHash) {
    setEquippedCustomAvatar(address, { format: 'vrm', contentHash })
  } else {
    setEquippedCustomAvatar(address, null)
  }
}

export function isCustomAvatarEquipped(address?: string | null): boolean {
  return !!getEquippedCustomAvatar(address)
}

export function isVrmEquipped(address?: string | null): boolean {
  const equip = getEquippedCustomAvatar(address)
  return equip?.format === 'vrm'
}