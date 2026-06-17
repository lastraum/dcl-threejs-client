import { PROFILE_STORAGE_KEY } from '../avatar/constants'
import { IDENTITY_STORAGE_KEY } from './constants'
import type { AuthIdentity } from '@dcl/crypto/dist/types'

type StoredIdentity = {
  address: string
  identity: AuthIdentity
}

function normalizeAddress(value: string): string | undefined {
  const address = value.trim().toLowerCase()
  return /^0x[a-f0-9]{40}$/.test(address) ? address : undefined
}

function reviveIdentity(raw: StoredIdentity): AuthIdentity | null {
  try {
    const expiration = new Date(raw.identity.expiration)
    if (Number.isNaN(expiration.getTime()) || expiration.getTime() <= Date.now()) return null
    return {
      ...raw.identity,
      expiration
    }
  } catch {
    return null
  }
}

export function readStoredIdentity(): { address: string; identity: AuthIdentity } | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = localStorage.getItem(IDENTITY_STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as StoredIdentity
    const address = normalizeAddress(parsed.address)
    if (!address) return null
    const identity = reviveIdentity({ ...parsed, address })
    if (!identity) return null
    return { address, identity }
  } catch {
    return null
  }
}

export function writeStoredIdentity(address: string, identity: AuthIdentity): void {
  if (typeof window === 'undefined') return
  const normalized = normalizeAddress(address)
  if (!normalized) return
  localStorage.setItem(
    IDENTITY_STORAGE_KEY,
    JSON.stringify({
      address: normalized,
      identity: {
        ...identity,
        expiration: identity.expiration.toISOString()
      }
    })
  )
  localStorage.setItem(PROFILE_STORAGE_KEY, normalized)
}

export function clearStoredIdentity(): void {
  if (typeof window === 'undefined') return
  localStorage.removeItem(IDENTITY_STORAGE_KEY)
  localStorage.removeItem(PROFILE_STORAGE_KEY)
}

export function persistProfileAddress(address: string): void {
  const normalized = normalizeAddress(address)
  if (!normalized || typeof window === 'undefined') return
  localStorage.setItem(PROFILE_STORAGE_KEY, normalized)
}
