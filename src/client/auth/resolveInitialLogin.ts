import type { LoginResult } from '../../auth/AuthClient'
import { resumeStoredLogin } from '../../auth/AuthClient'
import { ensureGuestLogin } from '../../auth/guestIdentity'
import { ensureGuestCatalystProfile } from '../../avatar/guestProfile'
import { clientDebugLog } from '../debug/ClientDebugLog'

/**
 * Session bootstrap — resume stored wallet, else stable browser guest + Catalyst profile.
 * One computer / origin = one guest account (localStorage root key).
 */
export async function resolveInitialLogin(): Promise<LoginResult> {
  const wallet = resumeStoredLogin()
  if (wallet) return wallet

  const guest = await ensureGuestLogin()
  void ensureGuestCatalystProfile({
    address: guest.address,
    identity: guest.identity,
    displayName: guest.displayName
  })
    .then((r) => {
      if (r.created) {
        clientDebugLog.log('client', `Guest Catalyst profile created · ${guest.displayName}`, {
          level: 'success',
          alsoConsole: true
        })
      }
    })
    .catch((err) => {
      const msg = err instanceof Error ? err.message : String(err)
      clientDebugLog.log('client', `Guest profile deploy deferred: ${msg}`, {
        level: 'warn',
        alsoConsole: true
      })
    })
  return guest
}

/** True when a real wallet session was restored (not guest). */
export function hasResumedWalletSession(): boolean {
  return resumeStoredLogin()?.kind === 'wallet'
}

/** Ensure guest login + fire-and-forget Catalyst profile (explicit Continue as Guest). */
export async function ensureGuestSession(): Promise<LoginResult> {
  const guest = await ensureGuestLogin()
  try {
    await ensureGuestCatalystProfile({
      address: guest.address,
      identity: guest.identity,
      displayName: guest.displayName
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    clientDebugLog.log('client', `Guest profile deploy: ${msg}`, { level: 'warn', alsoConsole: true })
  }
  return guest
}
