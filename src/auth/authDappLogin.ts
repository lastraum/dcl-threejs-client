import { Authenticator, getEphemeralSignatureType } from '@dcl/crypto'
import { createUnsafeIdentity } from '@dcl/crypto/dist/crypto'
import type { AuthIdentity } from '@dcl/crypto/dist/types'
import { AuthLinkType } from '@dcl/schemas'
import type { LoginResult, StatusCallback } from './AuthClient'
import {
  AUTH_API_URL,
  AUTH_SITE_URL,
  IDENTITY_TTL_MS,
  type AuthDappLoginMethod
} from './constants'
import { writeStoredIdentity } from './identityStore'

type CreateRequestResponse = {
  requestId: string
  expiration: string
  code: number
}

type PollOutcome = {
  requestId: string
  sender: string
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

const POLL_MS = 1500
const POPUP_FEATURES = 'popup=yes,width=480,height=720,menubar=no,toolbar=no,location=yes,status=no'

function authApiBase(): string {
  return AUTH_API_URL.replace(/\/+$/, '')
}

function authSiteBase(): string {
  return AUTH_SITE_URL.replace(/\/+$/, '')
}

/** Build official auth dapp URL — same shape as Explorer. */
export function buildAuthLoginUrl(requestId: string, loginMethod: AuthDappLoginMethod): string {
  const redirectPath = `/auth/requests/${requestId}?targetConfigId=default`
  const params = new URLSearchParams({
    redirectTo: redirectPath,
    loginMethod
  })
  return `${authSiteBase()}/login?${params.toString()}`
}

async function createSignRequest(message: string): Promise<CreateRequestResponse> {
  const res = await fetch(`${authApiBase()}/requests`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      method: 'dcl_personal_sign',
      params: [message]
    })
  })
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null
    throw new Error(body?.error || `Auth request failed (${res.status})`)
  }
  return (await res.json()) as CreateRequestResponse
}

async function pollSignOutcome(
  requestId: string,
  expirationIso: string,
  signal?: AbortSignal
): Promise<PollOutcome> {
  const deadline = Date.parse(expirationIso)
  while (!signal?.aborted) {
    if (Number.isFinite(deadline) && Date.now() > deadline) {
      throw new Error('Login request expired — try again')
    }
    const res = await fetch(`${authApiBase()}/requests/${encodeURIComponent(requestId)}`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal
    })
    if (res.status === 204) {
      await sleep(POLL_MS, signal)
      continue
    }
    if (res.status === 404) throw new Error('Login request not found')
    if (res.status === 410) throw new Error('Login request expired — try again')
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null
      throw new Error(body?.error || `Auth poll failed (${res.status})`)
    }
    return (await res.json()) as PollOutcome
  }
  throw new Error('Login cancelled')
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('Login cancelled'))
      return
    }
    const t = window.setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      window.clearTimeout(t)
      reject(new Error('Login cancelled'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function openAuthPopup(url: string): Window | null {
  const w = window.open(url, 'dcl-auth-login', POPUP_FEATURES)
  try {
    w?.focus()
  } catch {
    /* ignore */
  }
  return w
}

function extractSignature(result: unknown): string {
  if (typeof result === 'string' && result.length > 0) return result
  if (result && typeof result === 'object') {
    const r = result as Record<string, unknown>
    if (typeof r.signature === 'string') return r.signature
    if (typeof r.result === 'string') return r.result
  }
  throw new Error('Auth dapp returned an unexpected signature payload')
}

/**
 * Sign-in via Decentraland auth dapp (Google / Discord / Apple / X / WalletConnect / …).
 *
 * 1. Create ephemeral identity + login message
 * 2. POST auth-api `/requests` (`dcl_personal_sign`)
 * 3. Open `decentraland.org/auth/login?loginMethod=…&redirectTo=/auth/requests/{id}`
 * 4. Poll until signature + sender address
 * 5. Build DCL AuthChain identity (same as wallet MetaMask path)
 */
export async function loginWithAuthDapp(
  loginMethod: AuthDappLoginMethod,
  onStatus?: StatusCallback
): Promise<LoginResult> {
  const abort = new AbortController()
  let popup: Window | null = null
  let closedPoll: number | null = null

  try {
    onStatus?.('Preparing secure login…')
    const ephemeral = createUnsafeIdentity()
    const expiration = new Date(Date.now() + IDENTITY_TTL_MS)
    const ephemeralMessage = Authenticator.getEphemeralMessage(ephemeral.address, expiration)

    onStatus?.('Opening Decentraland login…')
    // Open blank first so the click gesture is preserved for popup blockers.
    popup = openAuthPopup('about:blank')

    const created = await createSignRequest(ephemeralMessage)
    const loginUrl = buildAuthLoginUrl(created.requestId, loginMethod)

    if (popup && !popup.closed) {
      try {
        popup.location.href = loginUrl
      } catch {
        popup = openAuthPopup(loginUrl)
      }
    } else {
      popup = openAuthPopup(loginUrl)
    }
    if (!popup) {
      throw new Error('Popup blocked — allow popups for this site and try again')
    }

    onStatus?.(
      `Confirm code ${String(created.code).padStart(2, '0')} in the login window…`
    )

    closedPoll = window.setInterval(() => {
      if (popup?.closed) abort.abort()
    }, 800)

    const outcome = await pollSignOutcome(created.requestId, created.expiration, abort.signal)

    if (outcome.error) {
      throw new Error(outcome.error.message || 'Login failed')
    }

    const sender = outcome.sender?.trim().toLowerCase()
    if (!sender || !/^0x[a-f0-9]{40}$/.test(sender)) {
      throw new Error('Login did not return a wallet address')
    }

    const signature = extractSignature(outcome.result)
    const sigType = getEphemeralSignatureType(signature)

    const identity: AuthIdentity = {
      ephemeralIdentity: ephemeral,
      expiration,
      authChain: [
        { type: AuthLinkType.SIGNER, payload: sender, signature: '' },
        {
          type: sigType,
          payload: ephemeralMessage,
          signature
        }
      ]
    }

    onStatus?.('Identity created ✓')
    writeStoredIdentity(sender, identity)
    return { kind: 'wallet', address: sender, identity }
  } catch (err) {
    if (abort.signal.aborted) throw new Error('Login window closed')
    throw err
  } finally {
    if (closedPoll != null) window.clearInterval(closedPoll)
    try {
      if (popup && !popup.closed) popup.close()
    } catch {
      /* ignore */
    }
  }
}
