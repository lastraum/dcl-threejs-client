export const IDENTITY_STORAGE_KEY = 'dcl-client-auth-identity'
export const IDENTITY_TTL_MS = 24 * 60 * 60 * 1000

/** Auth Server (create/poll `dcl_personal_sign` requests). */
export const AUTH_API_URL =
  (typeof import.meta !== 'undefined' && import.meta.env?.VITE_AUTH_API_URL?.trim()) ||
  'https://auth-api.decentraland.org'

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
