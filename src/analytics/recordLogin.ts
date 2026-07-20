import type { LoginResult } from '../auth/AuthClient'
import { setAnalyticsLogin, track } from './track'

/**
 * Fire-and-forget login event — guest or wallet.
 * Opt-in only: set VITE_ANALYTICS_ENABLED=true.
 */
export function recordLoginEvent(login: LoginResult | null): void {
  setAnalyticsLogin(login)
  if (import.meta.env.VITE_ANALYTICS_ENABLED !== 'true') return
  if (typeof window === 'undefined') return
  track('login', {
    props: {
      kind: login?.kind === 'wallet' ? 'wallet' : 'guest'
    }
  })
}
