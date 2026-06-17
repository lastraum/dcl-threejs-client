import signedFetch from 'decentraland-crypto-fetch'
import { signedHeaderFactory } from 'decentraland-crypto-fetch/lib/factory'
import type { AuthIdentity } from '@dcl/crypto/dist/types'
import type {
  SignedFetchGetHeadersResponse,
  SignedFetchRequest,
  SignedFetchResponse
} from '../shim/types'

const signedHeader = signedHeaderFactory()

function headersToRecord(
  headers: Record<string, string> | Array<{ key: string; value: string }> | undefined
): Record<string, string> {
  if (!headers) return {}
  if (Array.isArray(headers)) {
    const out: Record<string, string> = {}
    for (const entry of headers) out[entry.key] = entry.value
    return out
  }
  return headers
}

function headersRecordFromResponse(res: Response): Record<string, string> {
  const out: Record<string, string> = {}
  res.headers.forEach((value, key) => {
    out[key] = value
  })
  return out
}

/** ADR-44 auth headers for WebSocket/RPC handshakes (`~system/SignedFetch.getHeaders`). */
export function performGetSignedHeaders(
  request: SignedFetchRequest,
  identity: AuthIdentity | null
): SignedFetchGetHeadersResponse {
  if (!identity) return { headers: {} }

  const init = request.init ?? {}
  const url = new URL(request.url)
  const method = init.method ?? 'GET'
  const authHeaders = signedHeader(
    identity,
    method,
    url.pathname,
    {},
    headersToRecord(init.headers)
  )

  const headers: Record<string, string> = {}
  authHeaders.forEach((value, key) => {
    headers[key] = value
  })
  return { headers }
}

/** Scene `~system/SignedFetch.signedFetch` — signed when wallet connected, plain fetch otherwise. */
export async function performSignedFetch(
  request: SignedFetchRequest,
  identity: AuthIdentity | null
): Promise<SignedFetchResponse> {
  const init = request.init ?? {}
  const fetchInit: RequestInit = {
    method: init.method ?? 'GET',
    headers: headersToRecord(init.headers),
    body: init.body
  }

  try {
    const res = identity
      ? await signedFetch(request.url, { ...fetchInit, identity })
      : await fetch(request.url, fetchInit)

    const body = await res.text()
    return {
      ok: res.ok,
      status: res.status,
      statusText: res.statusText,
      body,
      headers: headersRecordFromResponse(res)
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return {
      ok: false,
      status: 0,
      statusText: message,
      body: '',
      headers: {}
    }
  }
}
