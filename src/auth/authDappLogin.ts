import { Authenticator, getEphemeralSignatureType } from '@dcl/crypto'
import { createUnsafeIdentity } from '@dcl/crypto/dist/crypto'
import type { AuthIdentity } from '@dcl/crypto/dist/types'
import { AuthLinkType } from '@dcl/schemas'
import type { AuthProgressCallback, LoginResult, StatusCallback } from './AuthClient'
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

/**
 * Build official auth dapp URL.
 *
 * After the user approves the request, auth-site chooses between:
 * - Explorer flow (`skipSetup`): auto-opens the desktop app via `decentraland://`
 * - Web flow: "Sign in complete — close this window" only
 *
 * `skipSetup` is true when targetConfig says so, OR when the
 * ONBOARDING_TO_EXPLORER flag is on and there is no "explicit" redirect
 * (internal `/auth/requests/…` alone counts as non-explicit). That matches
 * Explorer, but opens the DCL client for our poll-only web client.
 *
 * Passing `redirectTo=/` on the request URL is treated as an explicit
 * non-auth redirect, so skipSetup stays false and success does not deep-link.
 * We still land on the request page (path is `/auth/requests/{id}`) and poll
 * auth-api from this app for the signature.
 */
export function buildAuthLoginUrl(requestId: string, loginMethod: AuthDappLoginMethod): string {
  const requestQuery = new URLSearchParams({
    targetConfigId: 'default',
    // Sentinel for auth-site useSkipSetup / hasExplicitRedirect — do not remove.
    redirectTo: '/'
  })
  const redirectPath = `/auth/requests/${requestId}?${requestQuery.toString()}`
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
 * Emit auth UI progress. Only include `verificationCode` when the caller
 * passes it — intermediate status lines must not wipe a code already shown.
 * Pass `null` explicitly to clear the code (e.g. after success).
 */
function emitProgress(
  onStatus: StatusCallback | AuthProgressCallback | undefined,
  message: string,
  verificationCode?: number | null
): void {
  if (!onStatus) return
  const progress: { message: string; verificationCode?: number | null } = { message }
  if (verificationCode !== undefined) {
    progress.verificationCode = verificationCode
  }
  // Always pass AuthProgress — UI handlers accept this shape; string-only
  // handlers (MetaMask) are not used on this path.
  ;(onStatus as AuthProgressCallback)(progress)
}

/**
 * Sign-in via Decentraland auth dapp (Google / Discord / Apple / X / WalletConnect / …).
 *
 * 1. Create ephemeral identity + login message
 * 2. POST auth-api `/requests` (`dcl_personal_sign`) → verification `code` (0–99)
 * 3. Open `decentraland.org/auth/login?loginMethod=…&redirectTo=/auth/requests/{id}`
 * 4. Poll GET `/requests/{id}` until signature + sender (204 = still pending)
 * 5. Build DCL AuthChain identity (same as wallet MetaMask path)
 *
 * Note: do not abort when `authTab.closed` is true — auth.dapp COOP often
 * detaches the opener so `closed` is a false positive while the tab is open.
 * Wait on auth-api until the user confirms or the request expires.
 */
export async function loginWithAuthDapp(
  loginMethod: AuthDappLoginMethod,
  onStatus?: StatusCallback | AuthProgressCallback
): Promise<LoginResult> {
  let authTab: Window | null = null
  let codePulse: number | null = null

  const progress = (message: string, verificationCode?: number | null) =>
    emitProgress(onStatus, message, verificationCode)

  try {
    // MUST open on the same user gesture tick (before any await) or browsers block it.
    progress('Opening Decentraland login…')
    authTab = openAuthTab('about:blank')
    if (!authTab) {
      throw new Error('Tab blocked — allow popups/tabs for this site and try again')
    }

    progress('Preparing secure login…')
    const ephemeral = createUnsafeIdentity()
    const expiration = new Date(Date.now() + IDENTITY_TTL_MS)
    const ephemeralMessage = Authenticator.getEphemeralMessage(ephemeral.address, expiration)

    const created = await createSignRequest(ephemeralMessage)
    const loginUrl = buildAuthLoginUrl(created.requestId, loginMethod)
    const code = created.code

    if (authTab && !authTab.closed) {
      try {
        // about:blank may block location writes in some browsers — reopen if needed.
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

    // Same verification number the auth tab displays (Explorer parity).
    progress(
      'Does this number match the one in the login tab? Tap Yes there when it does.',
      code
    )

    // Re-emit code while waiting so the modal stays in sync if it re-renders.
    codePulse = window.setInterval(() => {
      progress('Waiting for confirmation in the login tab…', code)
    }, 2000)

    let outcome: PollOutcome
    try {
      outcome = await pollSignOutcome(created.requestId, created.expiration)
    } finally {
      if (codePulse != null) window.clearInterval(codePulse)
      codePulse = null
    }

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

    progress('Identity created ✓', null)
    writeStoredIdentity(sender, identity)
    return { kind: 'wallet', address: sender, identity }
  } finally {
    if (codePulse != null) window.clearInterval(codePulse)
    // Best-effort close — COOP may make this a no-op; leave tab if we can't.
    try {
      if (authTab && !authTab.closed) authTab.close()
    } catch {
      /* ignore */
    }
  }
}
