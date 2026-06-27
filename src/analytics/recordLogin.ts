import type { LoginResult } from '../auth/AuthClient'
import { APP_VERSION } from '../client/appVersion'
import { clientDebugLog } from '../client/debug/ClientDebugLog'

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
  return { kind: 'guest', at, path, version: APP_VERSION }
}

/** Fire-and-forget login event — guest or wallet address + timestamp. */
export function recordLoginEvent(login: LoginResult | null): void {
  if (import.meta.env.VITE_ANALYTICS_ENABLED === 'false') return
  if (typeof window === 'undefined') return

  const payload = buildPayload(login)
  const writeToken = import.meta.env.VITE_ANALYTICS_WRITE_TOKEN?.trim()
  void fetch('/api/analytics/login', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(writeToken ? { Authorization: `Bearer ${writeToken}` } : {})
    },
    body: JSON.stringify(payload),
    keepalive: true
  })
    .then((res) => {
      if (res.ok) {
        clientDebugLog.log('analytics', `login event recorded (${payload.kind})`, {
          level: 'success',
          throttleMs: 60_000
        })
        return
      }
      clientDebugLog.log('analytics', `login event rejected (HTTP ${res.status})`, {
        level: 'warn',
        throttleMs: 30_000
      })
    })
    .catch((err) => {
      clientDebugLog.log(
        'analytics',
        `login event failed: ${err instanceof Error ? err.message : 'network'}`,
        { level: 'warn', throttleMs: 30_000 }
      )
    })
}