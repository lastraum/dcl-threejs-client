/**
 * Extra /localpreview tab — mint a one-shot wallet in sessionStorage.
 * Does not touch the stable guest key or wallet identity in localStorage.
 */
import { Authenticator } from '@dcl/crypto'
import { createUnsafeIdentity } from '@dcl/crypto/dist/crypto'
import type { AuthIdentity, IdentityType } from '@dcl/crypto/dist/types'
import { IDENTITY_TTL_MS } from '../../auth/constants'
import type { LoginResult } from '../../auth/AuthClient'
import { guestDisplayNameFromAddress } from '../../auth/guestIdentity'

export const EPHEMERAL_QUERY_PARAM = 'ephemeral'

const SESSION_KEY_PREFIX = 'dcl-ephemeral-wallet:'

export type EphemeralLogin = Extract<LoginResult, { kind: 'ephemeral' }>

type StoredEphemeral = {
  privateKey: string
  publicKey: string
  address: string
  displayName: string
  identity: {
    expiration: string
    authChain: AuthIdentity['authChain']
    ephemeralIdentity: IdentityType
  }
}

export function readEphemeralPeerId(search = window.location.search): string | null {
  const raw = new URLSearchParams(search).get(EPHEMERAL_QUERY_PARAM)?.trim() ?? ''
  return raw || null
}

export function isEphemeralPreviewPeer(search = window.location.search): boolean {
  return readEphemeralPeerId(search) != null
}

export function isLocalPreviewPath(pathname = window.location.pathname): boolean {
  const parts = pathname.replace(/\/+$/, '').split('/')
  const seg = parts[parts.length - 1] ?? ''
  return seg === 'localpreview' || seg === 'preview'
}

function displayNameFromAddress(address: string): string {
  return guestDisplayNameFromAddress(address)
}

function sessionKey(id: string): string {
  return `${SESSION_KEY_PREFIX}${id}`
}

function readStored(id: string): StoredEphemeral | null {
  try {
    const raw = sessionStorage.getItem(sessionKey(id))
    if (!raw) return null
    return JSON.parse(raw) as StoredEphemeral
  } catch {
    return null
  }
}

function writeStored(id: string, rec: StoredEphemeral): void {
  try {
    sessionStorage.setItem(sessionKey(id), JSON.stringify(rec))
  } catch {
    /* private mode / quota */
  }
}

function reviveIdentity(raw: StoredEphemeral['identity']): AuthIdentity | null {
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

async function buildAuthIdentity(root: IdentityType): Promise<AuthIdentity> {
  const ephemeral = createUnsafeIdentity()
  return Authenticator.initializeAuthChain(
    root.address,
    ephemeral,
    Math.max(1, Math.floor(IDENTITY_TTL_MS / 60_000)),
    async (message) => Authenticator.createSignature(root, message)
  )
}

/** Mint or resume the ephemeral wallet for this tab's `?ephemeral=` id. */
export async function ensureEphemeralLogin(): Promise<EphemeralLogin> {
  const id = readEphemeralPeerId()
  if (!id) throw new Error('Missing ephemeral peer id')

  let rec = readStored(id)
  if (!rec) {
    const created = createUnsafeIdentity()
    const address = created.address.toLowerCase()
    rec = {
      privateKey: created.privateKey.replace(/^0x/i, '').toLowerCase(),
      publicKey: created.publicKey.replace(/^0x/i, '').toLowerCase(),
      address,
      displayName: displayNameFromAddress(address),
      identity: {
        expiration: new Date(0).toISOString(),
        authChain: [],
        ephemeralIdentity: created
      }
    }
  }

  const root: IdentityType = {
    privateKey: rec.privateKey,
    publicKey: rec.publicKey,
    address: rec.address
  }
  let identity = reviveIdentity(rec.identity)
  if (!identity) {
    identity = await buildAuthIdentity(root)
    rec = {
      ...rec,
      identity: {
        expiration: identity.expiration.toISOString(),
        authChain: identity.authChain,
        ephemeralIdentity: identity.ephemeralIdentity
      }
    }
  }
  rec.displayName = displayNameFromAddress(rec.address)
  writeStored(id, rec)

  return {
    kind: 'ephemeral',
    address: rec.address,
    identity,
    displayName: rec.displayName
  }
}

/** Open a new tab on the same preview URL with a fresh ephemeral id. */
export function openEphemeralPreviewTab(): boolean {
  try {
    if (document.pointerLockElement) document.exitPointerLock()
  } catch {
    /* ignore */
  }
  const url = new URL(window.location.href)
  url.searchParams.set(EPHEMERAL_QUERY_PARAM, crypto.randomUUID())
  // Do not pass `noopener` — it makes window.open() return null even when the tab opens.
  const opened = window.open(url.toString(), '_blank')
  return opened != null
}
