export const IDENTITY_STORAGE_KEY = 'dcl-client-auth-identity'
export const IDENTITY_TTL_MS = 24 * 60 * 60 * 1000

/**
 * Auth Server (create/poll `dcl_personal_sign` requests).
 *
 * auth-api.decentraland.org only allows CORS for localhost + official DCL hosts
 * (e.g. play.decentraland.org). Custom domains get `Access-Control-Allow-Origin: false`
 * → browser "Failed to fetch". Production builds use same-origin nginx proxy:
 *   /api/dcl-auth-api/ → https://auth-api.decentraland.org/
 * Override anytime with VITE_AUTH_API_URL.
 */
function defaultAuthApiUrl(): string {
  const fromEnv =
    typeof import.meta !== 'undefined' ? import.meta.env?.VITE_AUTH_API_URL?.trim() : ''
  if (fromEnv) return fromEnv
  // Vite production bundle (staging + prod hosts)
  if (typeof import.meta !== 'undefined' && import.meta.env?.PROD) {
    return '/api/dcl-auth-api'
  }
  return 'https://auth-api.decentraland.org'
}

export const AUTH_API_URL = defaultAuthApiUrl()

/** Official auth dapp (login UI + social / wallet providers). */
export const AUTH_SITE_URL =
  (typeof import.meta !== 'undefined' && import.meta.env?.VITE_AUTH_SITE_URL?.trim()) ||
  'https://decentraland.org/auth'

/**
 * loginMethod query values for https://decentraland.org/auth/login
 * (match ConnectionOptionType in @dcl/auth-site — lowercase).
 */
export type AuthDappLoginMethod =
  | 'google'
  | 'apple'
  | 'discord'
  | 'x'
  | 'wallet-connect'
  | 'metamask'
  | 'email'
  | 'fortmatic'
