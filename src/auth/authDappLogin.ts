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

/** Prefer a full browser tab (not a sized popup window). */
function openAuthTab(url: string): Window | null {
  // No windowFeatures → browsers open a normal tab. Avoid noopener so we can
  // set location after create-request and detect tab close while polling.
  const w = window.open(url, '_blank')
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
  let authTab: Window | null = null
  let closedPoll: number | null = null

  try {
    onStatus?.('Preparing secure login…')
    const ephemeral = createUnsafeIdentity()
    const expiration = new Date(Date.now() + IDENTITY_TTL_MS)
    const ephemeralMessage = Authenticator.getEphemeralMessage(ephemeral.address, expiration)

    onStatus?.('Opening Decentraland login…')
    // Open blank tab on the user gesture first (avoids blockers after await).
    authTab = openAuthTab('about:blank')

    const created = await createSignRequest(ephemeralMessage)
    const loginUrl = buildAuthLoginUrl(created.requestId, loginMethod)

    if (authTab && !authTab.closed) {
      try {
        // about:blank + noopener may block location writes — reopen if needed.
        authTab.location.href = loginUrl
      } catch {
        authTab = openAuthTab(loginUrl)
      }
    } else {
      authTab = openAuthTab(loginUrl)
    }
    if (!authTab) {
      throw new Error('Tab blocked — allow popups/tabs for this site and try again')
    }

    onStatus?.(
      `Confirm code ${String(created.code).padStart(2, '0')} in the login tab…`
    )

    closedPoll = window.setInterval(() => {
      if (authTab?.closed) abort.abort()
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
    if (abort.signal.aborted) throw new Error('Login tab closed')
    throw err
  } finally {
    if (closedPoll != null) window.clearInterval(closedPoll)
    try {
      if (authTab && !authTab.closed) authTab.close()
    } catch {
      /* ignore */
    }
  }
}
