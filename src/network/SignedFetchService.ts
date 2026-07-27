import signedFetch from 'decentraland-crypto-fetch'
import { signedHeaderFactory } from 'decentraland-crypto-fetch/lib/factory'
import type { AuthIdentity } from '@dcl/crypto/dist/types'
import type {
  SignedFetchGetHeadersResponse,
  SignedFetchRequest,
  SignedFetchResponse
} from '../shim/types'

const signedHeader = signedHeaderFactory()

/** Scene metadata injected into gatekeeper SignedFetch calls (Explorer kernel parity). */
export type SignedFetchSceneContext = {
  sceneId: string
  parcel: string
  realmName: string
  isWorld?: boolean
}

function isGatekeeperSignedFetchUrl(url: string): boolean {
  try {
    return new URL(url).hostname.includes('comms-gatekeeper')
  } catch {
    return url.includes('comms-gatekeeper')
  }
}

/**
 * LastSlice camera-operator (RickRoll creator UI) authenticates via POST body wallet + JWT —
 * not ADR-44 gatekeeper signing. Plain fetch avoids crypto-fetch failures on third-party hosts.
 */
function prefersPlainSceneHttpFetch(url: string): boolean {
  try {
    return /\.lastslice\.co$/i.test(new URL(url).hostname)
  } catch {
    return /\.lastslice\.co/i.test(url)
  }
}

/**
 * Dev-only same-origin proxy for scene HTTP that third-party auth servers block via CORS
 * (e.g. fishing game auth host allows Explorer origins but not localhost:5173).
 *
 * Signature is always computed against the **original** pathname; only the transport URL
 * is rewritten to `/api/scene-http/...` (vite middleware).
 */
function sceneHttpProxyUrl(absoluteUrl: string): string | null {
  if (!import.meta.env.DEV) return null
  try {
    const u = new URL(absoluteUrl)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    if (u.hostname === 'localhost' || u.hostname === '127.0.0.1') return null
    // DCL first-party APIs already CORS-allow browser origins.
    if (u.hostname.endsWith('.decentraland.org') || u.hostname === 'decentraland.org') {
      return null
    }
    const proto = u.protocol === 'https:' ? 'https' : 'http'
    const path = u.pathname.startsWith('/') ? u.pathname : `/${u.pathname}`
    return `/api/scene-http/${proto}/${u.host}${path}${u.search}`
  } catch {
    return null
  }
}

function gatekeeperMetadata(context: SignedFetchSceneContext) {
  return {
    signer: 'decentraland-kernel-scene',
    sceneId: context.sceneId,
    parcel: context.parcel,
    realmName: context.realmName,
    isWorld: context.isWorld ?? false
  }
}

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
  identity: AuthIdentity | null,
  sceneContext?: SignedFetchSceneContext | null
): Promise<SignedFetchResponse> {
  const init = request.init ?? {}
  const method = init.method ?? 'GET'
  const requestHeaders = headersToRecord(init.headers)
  const fetchInit: RequestInit = {
    method,
    headers: requestHeaders,
    body: init.body
  }

  try {
    const usePlainFetch = prefersPlainSceneHttpFetch(request.url)
    const useGatekeeperMetadata =
      !usePlainFetch &&
      !!identity &&
      !!sceneContext?.sceneId &&
      isGatekeeperSignedFetchUrl(request.url)

    // Prefer same-origin proxy for third-party hosts in dev (fishing auth CORS).
    // Sign the original URL path; transport via /api/scene-http/...
    const proxyUrl = sceneHttpProxyUrl(request.url)
    if (proxyUrl) {
      const headers: Record<string, string> = { ...requestHeaders }
      if (identity && !usePlainFetch) {
        const auth = performGetSignedHeaders(
          {
            url: request.url,
            init: {
              method,
              headers: requestHeaders,
              body: init.body
            }
          },
          identity
        )
        Object.assign(headers, auth.headers)
        // Gatekeeper-style metadata is embedded by signedHeader when metadata is passed —
        // performGetSignedHeaders does not attach gatekeeper metadata. For gatekeeper
        // keep direct signedFetch (DCL hosts skip proxy). Non-gatekeeper auth servers
        // only need ADR-44 identity headers.
      }
      const res = await fetch(proxyUrl, { method, headers, body: init.body })
      const body = await res.text()
      return {
        ok: res.ok,
        status: res.status,
        statusText: res.statusText,
        body,
        headers: headersRecordFromResponse(res)
      }
    }

    const res =
      identity && !usePlainFetch
        ? await signedFetch(request.url, {
            ...fetchInit,
            identity,
            ...(useGatekeeperMetadata ? { metadata: gatekeeperMetadata(sceneContext!) } : {})
          })
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
