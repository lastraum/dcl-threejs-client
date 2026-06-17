import type { AuthIdentity } from '@dcl/crypto/dist/types'
import signedFetch from 'decentraland-crypto-fetch'
import { clientDebugLog } from '../../client/debug/ClientDebugLog'
import { isLiveKitAdapter } from '../comms/livekitAdapter'

export type ParsedRealmCommsAdapter =
  | { kind: 'archipelago'; url: string }
  | { kind: 'signed-login'; url: string }
  | { kind: 'livekit'; adapter: string }

export type WorldCommsAdapterResult =
  | { ok: true; adapter: string }
  | { ok: false; status: number; error: string }

/** Strip `fixed-adapter:` and parse realm `/about` comms.adapter values. */
export function parseRealmCommsAdapter(adapterHint: string | undefined): ParsedRealmCommsAdapter | null {
  let raw = adapterHint?.trim() ?? ''
  if (!raw) return null
  if (raw.startsWith('fixed-adapter:')) {
    raw = raw.slice('fixed-adapter:'.length)
  }
  if (raw.startsWith('archipelago:')) {
    return { kind: 'archipelago', url: raw.slice('archipelago:'.length) }
  }
  if (raw.startsWith('signed-login:')) {
    return { kind: 'signed-login', url: raw.slice('signed-login:'.length) }
  }
  if (isLiveKitAdapter(raw)) {
    return { kind: 'livekit', adapter: raw }
  }
  return null
}

function commsHandshakeOrigin(contentUrl: string): string {
  if (typeof window !== 'undefined' && window.location?.origin) {
    return window.location.origin
  }
  try {
    return new URL(contentUrl).origin
  } catch {
    return 'https://decentraland.org'
  }
}

/** POST worlds-content-server `/worlds/{name}/comms` — Bevy `SignedLoginPlugin`. */
export async function fetchWorldCommsAdapter(
  identity: AuthIdentity,
  signedLoginUrl: string,
  contentUrl: string
): Promise<WorldCommsAdapterResult> {
  const metadata = {
    intent: 'dcl:explorer:comms-handshake',
    signer: 'dcl:explorer',
    isGuest: false,
    origin: commsHandshakeOrigin(contentUrl)
  }

  let res: Response
  try {
    res = await signedFetch(signedLoginUrl, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({}),
      identity,
      metadata
    })
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    return { ok: false, status: 503, error: `world_comms_unreachable: ${detail}` }
  }

  let body: unknown
  try {
    body = await res.json()
  } catch {
    body = null
  }

  if (!res.ok) {
    const err =
      body &&
      typeof body === 'object' &&
      'error' in body &&
      typeof (body as { error: unknown }).error === 'string'
        ? (body as { error: string }).error
        : res.statusText || 'world_comms_error'
    clientDebugLog.log('comms', `World comms handshake failed: ${err}`, { level: 'error' })
    return { ok: false, status: res.status, error: err }
  }

  const adapter =
    body &&
    typeof body === 'object' &&
    'fixedAdapter' in body &&
    typeof (body as { fixedAdapter: unknown }).fixedAdapter === 'string'
      ? (body as { fixedAdapter: string }).fixedAdapter
      : body &&
          typeof body === 'object' &&
          'adapter' in body &&
          typeof (body as { adapter: unknown }).adapter === 'string'
        ? (body as { adapter: string }).adapter
        : null

  if (!adapter) {
    return { ok: false, status: res.status, error: 'invalid_world_comms_response' }
  }

  clientDebugLog.log('comms', 'World comms adapter received', { level: 'success' })
  return { ok: true, adapter }
}
