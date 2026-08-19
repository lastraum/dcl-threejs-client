/**
 * Stable browser-only guest wallet — one computer / origin = one guest account.
 * Root key lives in localStorage; AuthChain is rebuilt when the session TTL expires.
 */
import { Authenticator } from '@dcl/crypto'
import { createUnsafeIdentity } from '@dcl/crypto/dist/crypto'
import type { AuthIdentity, IdentityType } from '@dcl/crypto/dist/types'
import { IDENTITY_TTL_MS } from './constants'

export const GUEST_WALLET_STORAGE_KEY = 'dcl-client-guest-wallet'

export type GuestWalletRecord = {
  privateKey: string
  publicKey: string
  address: string
  displayName: string
  /** ISO time of last successful Catalyst profile deploy (create or update). */
  profileDeployedAt?: string
  /** Cached AuthIdentity JSON (expiration as ISO string). */
  identity?: {
    expiration: string
    authChain: AuthIdentity['authChain']
    ephemeralIdentity: IdentityType
  }
}

export type GuestLogin = {
  kind: 'guest'
  address: string
  identity: AuthIdentity
  displayName: string
}

/** Display name: Guest-a1b2 from address (stable for this machine). */
export function guestDisplayNameFromAddress(address: string): string {
  const a = address.trim().toLowerCase().replace(/^0x/, '')
  if (a.length < 4) return 'Guest'
  return `Guest-${a.slice(0, 4)}`
}

function normalizeAddress(value: string): string | null {
  const address = value.trim().toLowerCase()
  return /^0x[a-f0-9]{40}$/.test(address) ? address : null
}

function rootFromRecord(rec: GuestWalletRecord): IdentityType | null {
  const address = normalizeAddress(rec.address)
  if (!address || !rec.privateKey?.trim() || !rec.publicKey?.trim()) return null
  return {
    privateKey: rec.privateKey.replace(/^0x/i, '').toLowerCase(),
    publicKey: rec.publicKey.replace(/^0x/i, '').toLowerCase(),
    address
  }
}

function reviveIdentity(raw: GuestWalletRecord['identity']): AuthIdentity | null {
  if (!raw) return null
  try {
    const expiration = new Date(raw.expiration)
    if (Number.isNaN(expiration.getTime()) || expiration.getTime() <= Date.now() + 60_000) {
      return null
    }
    return {
      ephemeralIdentity: raw.ephemeralIdentity,
      expiration,
      authChain: raw.authChain
    }
  } catch {
    return null
  }
}

function readGuestRecord(): GuestWalletRecord | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = localStorage.getItem(GUEST_WALLET_STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as GuestWalletRecord
    if (!rootFromRecord(parsed)) return null
    if (!parsed.displayName?.trim()) {
      parsed.displayName = guestDisplayNameFromAddress(parsed.address)
    }
    return parsed
  } catch {
    return null
  }
}

function writeGuestRecord(rec: GuestWalletRecord): void {
  if (typeof window === 'undefined') return
  localStorage.setItem(GUEST_WALLET_STORAGE_KEY, JSON.stringify(rec))
}

async function buildGuestAuthIdentity(root: IdentityType, ttlMs = IDENTITY_TTL_MS): Promise<AuthIdentity> {
  const ephemeral = createUnsafeIdentity()
  return Authenticator.initializeAuthChain(
    root.address,
    ephemeral,
    Math.max(1, Math.floor(ttlMs / 60_000)),
    async (message) => Authenticator.createSignature(root, message)
  )
}

/**
 * Load or mint the stable guest wallet for this browser, return a usable LoginResult-shaped guest.
 * Idempotent — same address across reloads on this origin.
 */
export async function ensureGuestLogin(): Promise<GuestLogin> {
  let rec = readGuestRecord()
  let root = rec ? rootFromRecord(rec) : null

  if (!root) {
    const created = createUnsafeIdentity()
    const address = created.address.toLowerCase()
    rec = {
      privateKey: created.privateKey.replace(/^0x/i, '').toLowerCase(),
      publicKey: created.publicKey.replace(/^0x/i, '').toLowerCase(),
      address,
      displayName: guestDisplayNameFromAddress(address)
    }
    root = rootFromRecord(rec)!
    writeGuestRecord(rec)
  }

  let identity = reviveIdentity(rec!.identity)
  if (!identity) {
    identity = await buildGuestAuthIdentity(root)
    rec = {
      ...rec!,
      address: root.address,
      identity: {
        expiration: identity.expiration.toISOString(),
        authChain: identity.authChain,
        ephemeralIdentity: identity.ephemeralIdentity
      }
    }
    writeGuestRecord(rec)
  }

  return {
    kind: 'guest',
    address: root.address,
    identity,
    displayName: rec!.displayName || guestDisplayNameFromAddress(root.address)
  }
}

/** True when guest already has a Catalyst profile deploy recorded (or we skip redeploy). */
export function guestProfileDeployed(): boolean {
  const rec = readGuestRecord()
  return Boolean(rec?.profileDeployedAt)
}

export function markGuestProfileDeployed(): void {
  const rec = readGuestRecord()
  if (!rec) return
  writeGuestRecord({ ...rec, profileDeployedAt: new Date().toISOString() })
}

/** Persist a typed guest display name on this browser wallet. */
export function setGuestDisplayName(displayName: string): GuestLogin | null {
  const rec = readGuestRecord()
  const root = rec ? rootFromRecord(rec) : null
  if (!rec || !root) return null
  const name = displayName.trim() || guestDisplayNameFromAddress(root.address)
  writeGuestRecord({ ...rec, displayName: name })
  const identity = reviveIdentity(rec.identity)
  if (!identity) return null
  return {
    kind: 'guest',
    address: root.address,
    identity,
    displayName: name
  }
}

/** Drop guest wallet (rare — new guest on this browser). */
export function clearGuestWallet(): void {
  if (typeof window === 'undefined') return
  localStorage.removeItem(GUEST_WALLET_STORAGE_KEY)
}

/**
 * Root private key for the stable guest wallet (hex, with 0x).
 * Only available in this browser; null if no guest record.
 */
export function getGuestPrivateKeyHex(): string | null {
  const rec = readGuestRecord()
  const root = rec ? rootFromRecord(rec) : null
  if (!root?.privateKey) return null
  const hex = root.privateKey.replace(/^0x/i, '').toLowerCase()
  if (!/^[a-f0-9]{64}$/.test(hex)) return null
  return `0x${hex}`
}
