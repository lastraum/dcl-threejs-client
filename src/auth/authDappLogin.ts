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

/** Named window so we can navigate it after await without a second popup. */
export const AUTH_WINDOW_NAME = 'dcl-threejs-auth'

function authApiBase(): string {
  return AUTH_API_URL.replace(/\/+$/, '')
}

function authSiteBase(): string {
  return AUTH_SITE_URL.replace(/\/+$/, '')
}

/**
 * Build official auth dapp URL.
 *
 * `redirectTo=/` keeps web flow (no Explorer deep-link). We poll auth-api for the signature.
 */
export function buildAuthLoginUrl(requestId: string, loginMethod: AuthDappLoginMethod): string {
  const requestQuery = new URLSearchParams({
    targetConfigId: 'default',
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

/**
 * Open (or focus) the auth window. Call only from a direct user gesture
 * (click handler) — before any await — or browsers will block it.
 */
export function openAuthWindow(url = 'about:blank'): Window | null {
  const w = window.open(url, AUTH_WINDOW_NAME)
  try {
    w?.focus()
  } catch {
    /* ignore */
  }
  if (w) {
    try {
      // Show something immediately so a failed navigate is not a silent blank tab.
      w.document.open()
      w.document.write(
        `<!doctype html><title>Signing in…</title><body style="font:15px system-ui;padding:24px;background:#1a0f28;color:#fff">
          Opening Decentraland login…</body>`
      )
      w.document.close()
    } catch {
      /* cross-origin / already navigated */
    }
  }
  return w
}

/** Navigate a window opened earlier on the user gesture (safe after await). */
function navigateAuthWindow(authTab: Window | null, loginUrl: string): Window | null {
  // Named window reuse is allowed after await if the window was opened with a gesture.
  const reused = window.open(loginUrl, AUTH_WINDOW_NAME)
  if (reused) {
    try {
      reused.focus()
    } catch {
      /* ignore */
    }
    return reused
  }
  if (authTab) {
    try {
      authTab.location.replace(loginUrl)
      return authTab
    } catch {
      try {
        authTab.location.href = loginUrl
        return authTab
      } catch {
        /* fall through */
      }
    }
  }
  return null
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
  ;(onStatus as AuthProgressCallback)(progress)
}

export type LoginWithAuthDappOptions = {
  /**
   * Window opened with `openAuthWindow()` in the click handler (same user gesture).
   * Required for reliable tab open; without it we try openAuthWindow here (may be blocked).
   */
  authWindow?: Window | null
}

/**
 * Sign-in via Decentraland auth dapp (Google / Discord / Apple / X / WalletConnect / …).
 */
export async function loginWithAuthDapp(
  loginMethod: AuthDappLoginMethod,
  onStatus?: StatusCallback | AuthProgressCallback,
  options?: LoginWithAuthDappOptions
): Promise<LoginResult> {
  let authTab: Window | null = options?.authWindow ?? null
  let codePulse: number | null = null
  let closeTabOnExit = true

  const progress = (message: string, verificationCode?: number | null) =>
    emitProgress(onStatus, message, verificationCode)

  try {
    // Prefer pre-opened window from the click handler.
    if (!authTab || authTab.closed) {
      progress('Opening Decentraland login…')
      authTab = openAuthWindow('about:blank')
    }
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

    const navigated = navigateAuthWindow(authTab, loginUrl)
    if (!navigated) {
      // Last resort: show clickable link in the blank tab if we still have document access.
      try {
        if (authTab && !authTab.closed) {
          authTab.document.open()
          authTab.document.write(
            `<!doctype html><title>Sign in</title><body style="font:15px system-ui;padding:24px;background:#1a0f28;color:#fff">
              <p>Popup navigation was blocked.</p>
              <p><a href="${loginUrl}" style="color:#7dd3fc;font-weight:700">Click here to open Decentraland login</a></p>
            </body>`
          )
          authTab.document.close()
          closeTabOnExit = false
        } else {
          throw new Error('blocked')
        }
      } catch {
        throw new Error(
          'Could not open login tab. Allow popups for this site, then try again.'
        )
      }
    } else {
      authTab = navigated
    }

    progress(
      'Does this number match the one in the login tab? Tap Yes there when it does.',
      code
    )

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
    // Only close if we still control a loading/error blank — leave auth.dapp open for the user.
    if (closeTabOnExit) {
      try {
        // Do not force-close: auth-site COOP often makes close a no-op or wrong.
        // Closing a successful login tab is optional; leave open so user sees "done".
      } catch {
        /* ignore */
      }
    }
  }
}
