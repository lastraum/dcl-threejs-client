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
import { loginWithAuthDapp, type LoginWithAuthDappOptions } from './authDappLogin'
import type { AuthDappLoginMethod } from './constants'
export { openAuthWindow, AUTH_WINDOW_NAME } from './authDappLogin'

export type LoginResult =
  | { kind: 'guest'; address: string; identity: AuthIdentity; displayName: string }
  | { kind: 'wallet'; address: string; identity: AuthIdentity }

/** Guest or wallet with a usable AuthChain (LiveKit / signed fetch). */
export function loginHasCommsIdentity(
  login: LoginResult | null | undefined
): login is LoginResult & { address: string; identity: AuthIdentity } {
  return (
    !!login &&
    (login.kind === 'wallet' || login.kind === 'guest') &&
    typeof login.address === 'string' &&
    !!login.identity
  )
}

export function isWalletLogin(
  login: LoginResult | null | undefined
): login is Extract<LoginResult, { kind: 'wallet' }> {
  return login?.kind === 'wallet'
}

export type StatusCallback = (msg: string) => void

/** Progress for auth-dapp flows — includes 0–99 verification code to show in-app. */
export type AuthProgress = {
  message: string
  /** Present while waiting for the auth tab to confirm (matches Explorer). */
  verificationCode?: number | null
}

export type AuthProgressCallback = (progress: AuthProgress) => void

export type { AuthDappLoginMethod }

/** Social / WalletConnect / etc. via decentraland.org/auth tab + auth-api. */
export async function loginWithProvider(
  method: AuthDappLoginMethod,
  onStatus?: StatusCallback | AuthProgressCallback,
  options?: LoginWithAuthDappOptions
): Promise<LoginResult> {
  return loginWithAuthDapp(method, onStatus, options)
}

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

/** Resume cached **real wallet** identity from localStorage, or null (use ensureGuestLogin). */
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
