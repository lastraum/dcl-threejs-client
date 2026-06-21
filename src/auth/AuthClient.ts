import { Authenticator } from '@dcl/crypto'
import { createUnsafeIdentity } from '@dcl/crypto/dist/crypto'
import type { AuthIdentity } from '@dcl/crypto/dist/types'
import { IDENTITY_TTL_MS } from './constants'
import { readStoredIdentity, writeStoredIdentity } from './identityStore'
import {
  getEthereumProvider,
  requestWalletAddress,
  setActiveEthereumProvider,
  signPersonalMessage
} from './ethereumProvider'
import { ensureMetaMaskProvider, shouldUseMetaMaskSdk } from './metaMaskSdk'

export type LoginResult =
  | { kind: 'guest' }
  | { kind: 'wallet'; address: string; identity: AuthIdentity }

export type StatusCallback = (msg: string) => void

async function createWalletIdentity(
  address: string,
  onStatus?: StatusCallback,
  ttlMs = IDENTITY_TTL_MS
): Promise<AuthIdentity> {
  const provider = getEthereumProvider()
  if (!provider) throw new Error('No Ethereum wallet found')

  onStatus?.('Creating ephemeral identity…')
  const ephemeral = createUnsafeIdentity()

  onStatus?.(
    shouldUseMetaMaskSdk() ? 'Sign the message in the MetaMask app…' : 'Sign the message in your wallet…'
  )
  const identity = await Authenticator.initializeAuthChain(
    address,
    ephemeral,
    Math.floor(ttlMs / 60_000),
    (message) => signPersonalMessage(message, address)
  )

  onStatus?.('Identity created ✓')
  return identity
}

/** Wallet-first login using injected provider + DCL AuthChain. */
export async function loginWithWallet(onStatus?: StatusCallback): Promise<LoginResult> {
  onStatus?.('Requesting wallet connection…')
  const address = await requestWalletAddress()
  onStatus?.(`Connected: ${address.slice(0, 6)}…${address.slice(-4)}`)

  const identity = await createWalletIdentity(address, onStatus)
  writeStoredIdentity(address, identity)
  return { kind: 'wallet', address, identity }
}

/** MetaMask login — opens the mobile app via deeplink when no extension is injected. */
export async function loginWithMetaMask(onStatus?: StatusCallback): Promise<LoginResult> {
  const provider = await ensureMetaMaskProvider(onStatus)
  setActiveEthereumProvider(provider)

  onStatus?.(shouldUseMetaMaskSdk() ? 'Approve connection in MetaMask…' : 'Requesting wallet connection…')
  const address = await requestWalletAddress()
  onStatus?.(`Connected: ${address.slice(0, 6)}…${address.slice(-4)}`)

  const identity = await createWalletIdentity(address, onStatus)
  writeStoredIdentity(address, identity)
  return { kind: 'wallet', address, identity }
}

/** Resume cached identity or show splash choices. */
export function resumeStoredLogin(): LoginResult | null {
  const stored = readStoredIdentity()
  if (!stored) return null
  return { kind: 'wallet', address: stored.address, identity: stored.identity }
}

/** Re-authenticate an existing wallet session (session refresh / expiry). */
export async function refreshWalletIdentity(
  address: string,
  onStatus?: StatusCallback
): Promise<LoginResult> {
  const normalized = address.trim().toLowerCase()
  if (!/^0x[a-f0-9]{40}$/.test(normalized)) {
    throw new Error('Invalid wallet address')
  }

  if (!getEthereumProvider()) {
    const provider = await ensureMetaMaskProvider(onStatus)
    setActiveEthereumProvider(provider)
  }

  onStatus?.(
    shouldUseMetaMaskSdk() ? 'Approve connection in MetaMask…' : 'Requesting wallet connection…'
  )
  const connected = await requestWalletAddress()
  if (connected !== normalized) {
    throw new Error(
      `Connected wallet (${connected.slice(0, 6)}…${connected.slice(-4)}) does not match ${normalized.slice(0, 6)}…${normalized.slice(-4)}.`
    )
  }

  const identity = await createWalletIdentity(normalized, onStatus)
  writeStoredIdentity(normalized, identity)
  return { kind: 'wallet', address: normalized, identity }
}
