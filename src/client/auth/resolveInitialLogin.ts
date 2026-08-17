import type { LoginResult } from '../../auth/AuthClient'
import { resumeStoredLogin } from '../../auth/AuthClient'
import { ensureGuestLogin } from '../../auth/guestIdentity'
import { ensureGuestCatalystProfile } from '../../avatar/guestProfile'
import { clientDebugLog } from '../debug/ClientDebugLog'
import { ensureEphemeralLogin, isEphemeralPreviewPeer } from '../preview/ephemeralPreview'

/**
 * Session bootstrap — resume stored wallet, else stable browser guest + Catalyst profile.
 * One computer / origin = one guest account (localStorage root key).
 * `?ephemeral=` preview tabs mint a session-only peer and skip guest/wallet storage.
 */
export async function resolveInitialLogin(): Promise<LoginResult> {
  if (isEphemeralPreviewPeer()) {
    const peer = await ensureEphemeralLogin()
    console.log(`[preview-peer] wallet=${peer.address} name=${peer.displayName}`)
    clientDebugLog.log('client', `Ephemeral preview peer · ${peer.displayName}`, {
      alsoConsole: true,
      level: 'success'
    })
    return peer
  }

  const wallet = resumeStoredLogin()
  if (wallet) return wallet

  const guest = await ensureGuestLogin()
  console.log(
    `[guest] wallet=${guest.address} name=${guest.displayName} · profile https://peer.decentraland.org/lambdas/profiles/${guest.address}`
  )
  void ensureGuestCatalystProfile({
    address: guest.address,
    identity: guest.identity,
    displayName: guest.displayName
  })
    .then((r) => {
      if (r.created) {
        console.log(`[guest] Catalyst profile CREATED for ${guest.address}`)
        clientDebugLog.log('client', `Guest Catalyst profile created · ${guest.displayName}`, {
          level: 'success',
          alsoConsole: true
        })
      } else {
        console.log(`[guest] Catalyst profile already present for ${guest.address}`)
      }
    })
    .catch((err) => {
      const msg = err instanceof Error ? err.message : String(err)
      console.warn(`[guest] Catalyst profile deploy failed: ${msg}`)
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
  console.log(
    `[guest] wallet=${guest.address} name=${guest.displayName} · profile https://peer.decentraland.org/lambdas/profiles/${guest.address}`
  )
  try {
    const r = await ensureGuestCatalystProfile({
      address: guest.address,
      identity: guest.identity,
      displayName: guest.displayName
    })
    console.log(
      r.created
        ? `[guest] Catalyst profile CREATED for ${guest.address}`
        : `[guest] Catalyst profile already present for ${guest.address}`
    )
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.warn(`[guest] Catalyst profile deploy failed: ${msg}`)
    clientDebugLog.log('client', `Guest profile deploy: ${msg}`, { level: 'warn', alsoConsole: true })
  }
  return guest
}
