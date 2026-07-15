import type { LoginResult } from '../auth/AuthClient'
import { APP_VERSION } from '../client/appVersion'

export type LoginAnalyticsPayload = {
  kind: 'guest' | 'wallet'
  address?: string
  at: string
  path: string
  version: string
}

function buildPayload(login: LoginResult | null): LoginAnalyticsPayload {
  const at = new Date().toISOString()
  const path = `${window.location.pathname}${window.location.search}`
  if (login?.kind === 'wallet') {
    return {
      kind: 'wallet',
      address: login.address.toLowerCase(),
      at,
      path,
      version: APP_VERSION
    }
  }
  if (login?.kind === 'guest') {
    return {
      kind: 'guest',
      address: login.address.toLowerCase(),
      at,
      path,
      version: APP_VERSION
    }
  }
  return { kind: 'guest', at, path, version: APP_VERSION }
}

/**
 * Fire-and-forget login event — guest or wallet address + timestamp.
 * Opt-in only: set VITE_ANALYTICS_ENABLED=true (avoids localhost 404 spam).
 */
export function recordLoginEvent(login: LoginResult | null): void {
  if (import.meta.env.VITE_ANALYTICS_ENABLED !== 'true') return
  if (typeof window === 'undefined') return

  const payload = buildPayload(login)
  void fetch('/api/analytics/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    keepalive: true
  }).catch(() => {
    /* analytics must never block or surface errors to the player */
  })
}