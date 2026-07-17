import type { AuthIdentity } from '@dcl/crypto/dist/types'
import signedFetch from 'decentraland-crypto-fetch'
import { GATEKEEPER_URL } from './GatekeeperClient'

export type PrivateMessagesTokenResult =
  | { ok: true; adapter: string }
  | { ok: false; status: number; error: string }

/**
 * ADR-208 — LiveKit credentials for the global private-messages room.
 * Signed-fetch like get-scene-adapter; response is `adapter` (livekit:wss…?access_token=…).
 */
export async function getPrivateMessagesToken(
  identity: AuthIdentity,
  gatekeeperUrl = GATEKEEPER_URL
): Promise<PrivateMessagesTokenResult> {
  const url = `${gatekeeperUrl.replace(/\/$/, '')}/private-messages/token`
  // Explorer-signed fetch (docs: SignedFetchExplorer) — same pattern as world signed-login.
  const metadata = {
    signer: 'dcl:explorer',
    intent: 'dcl:explorer:comms-handshake'
  }

  let res: Response
  try {
    res = await signedFetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      identity,
      metadata
    })
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    return { ok: false, status: 503, error: `gatekeeper_unreachable: ${detail}` }
  }

  let body: unknown
  try {
    body = await res.json()
  } catch {
    body = null
  }

  if (!res.ok) {
    const error =
      body && typeof body === 'object' && typeof (body as { error?: unknown }).error === 'string'
        ? (body as { error: string }).error
        : res.statusText || 'private_messages_token_failed'
    return { ok: false, status: res.status, error }
  }

  const adapter =
    body && typeof body === 'object' && typeof (body as { adapter?: unknown }).adapter === 'string'
      ? (body as { adapter: string }).adapter.trim()
      : body &&
          typeof body === 'object' &&
          typeof (body as { connection_url?: unknown }).connection_url === 'string'
        ? (body as { connection_url: string }).connection_url.trim()
        : ''

  if (!adapter) {
    return { ok: false, status: res.status, error: 'invalid_private_messages_response' }
  }

  return { ok: true, adapter }
}
