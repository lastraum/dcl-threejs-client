import type { AuthIdentity } from '@dcl/crypto/dist/types'
import { readStoredIdentity, writeStoredIdentity } from './identityStore'

const REFRESH_SOON_MS = 15 * 60 * 1000

export function getStoredIdentityExpiresAtMs(): number | null {
  const stored = readStoredIdentity()
  if (!stored) return null
  const ms = stored.identity.expiration.getTime()
  return Number.isFinite(ms) ? ms : null
}

export function formatIdentityExpiry(expiresAtMs: number | null): string {
  if (expiresAtMs == null) return 'No saved session'
  const remaining = expiresAtMs - Date.now()
  if (remaining <= 0) return 'Session expired'
  const hours = Math.floor(remaining / 3_600_000)
  const minutes = Math.floor((remaining % 3_600_000) / 60_000)
  if (hours >= 48) {
    const days = Math.floor(hours / 24)
    return `Session valid · ${days}d remaining`
  }
  if (hours >= 1) return `Session valid · ${hours}h ${minutes}m remaining`
  return `Session valid · ${minutes}m remaining`
}

export function identityNeedsRefreshSoon(expiresAtMs: number | null): boolean {
  if (expiresAtMs == null) return true
  return expiresAtMs - Date.now() < REFRESH_SOON_MS
}

/** Touch stored identity to persist latest expiration (no-op if missing). */
export function touchStoredIdentity(): { address: string; identity: AuthIdentity } | null {
  const stored = readStoredIdentity()
  if (!stored) return null
  writeStoredIdentity(stored.address, stored.identity)
  return stored
}
