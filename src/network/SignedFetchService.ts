import signedFetch from 'decentraland-crypto-fetch'
import { signedHeaderFactory } from 'decentraland-crypto-fetch/lib/factory'
import type { AuthIdentity } from '@dcl/crypto/dist/types'
import type {
  SignedFetchGetHeadersResponse,
  SignedFetchRequest,
  SignedFetchResponse
} from '../shim/types'

const signedHeader = signedHeaderFactory()

/**
 * Scene metadata for Explorer-parity SignedFetch (ADR-289).
 * Colyseus fishing auth and most third-party scene backends validate this payload.
 */
export type SignedFetchSceneContext = {
  sceneId: string
  parcel: string
  realmName: string
  isWorld?: boolean
  isGuest?: boolean
  /** Realm hostname (Genesis: realm.decentraland.org; worlds: content host/world/name). */
  realmHostname?: string
  realmProtocol?: string
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
 * (e.g. fishing Colyseus host allows Explorer origins but not localhost:5173).
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

/** Gatekeeper-only compact metadata (legacy companion-compatible). */
function gatekeeperMetadata(context: SignedFetchSceneContext) {
  return {
    signer: 'decentraland-kernel-scene',
    sceneId: context.sceneId,
    parcel: context.parcel,
    realmName: context.realmName,
    isWorld: context.isWorld ?? false
  }
}

/**
 * ADR-289 Explorer kernel metadata for scene SignedFetch.
 * Fishing Colyseus `/auth-token` and similar backends reject empty `{}` metadata with 400.
 */
async function buildSceneKernelMetadata(
  context: SignedFetchSceneContext | null | undefined,
  body: string | undefined | null
): Promise<Record<string, unknown>> {
  const hashPayload =
    body != null && String(body).length > 0 ? await sha256HexUtf8(String(body)) : ''

  if (!context?.sceneId) {
    return {
      signer: 'decentraland-kernel-scene',
      hashPayload
    }
  }

  const isGuest = context.isGuest === true
  const isWorld = context.isWorld === true
  const realmName = context.realmName || 'main'

  if (isWorld) {
    const hostname =
      context.realmHostname?.replace(/^https?:\/\//i, '').replace(/\/+$/, '') ||
      `worlds-content-server.decentraland.org/world/${realmName}`
    return {
      sceneId: context.sceneId,
      parcel: context.parcel,
      tld: 'org',
      network: 'mainnet',
      isGuest,
      realm: {
        hostname,
        protocol: context.realmProtocol ?? 'v3',
        serverName: realmName
      },
      signer: 'decentraland-kernel-scene',
      hashPayload
    }
  }

  return {
    signer: 'decentraland-kernel-scene',
    sceneId: context.sceneId,
    parcel: context.parcel,
    tld: 'org',
    network: 'mainnet',
    isGuest,
    realmName,
    realm: {
      hostname: context.realmHostname ?? 'realm.decentraland.org',
      protocol: context.realmProtocol ?? 'https',
      serverName: realmName
    },
    hashPayload
  }
}

async function sha256HexUtf8(text: string): Promise<string> {
  const data = new TextEncoder().encode(text)
  const digest = await crypto.subtle.digest('SHA-256', data)
  const bytes = new Uint8Array(digest)
  let hex = ''
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i]!.toString(16).padStart(2, '0')
  }
  return hex
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

function headersFromSigned(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {}
  headers.forEach((value, key) => {
    out[key] = value
  })
  return out
}

/** ADR-44 auth headers for WebSocket/RPC handshakes (`~system/SignedFetch.getHeaders`). */
export function performGetSignedHeaders(
  request: SignedFetchRequest,
  identity: AuthIdentity | null,
  sceneContext?: SignedFetchSceneContext | null
): SignedFetchGetHeadersResponse {
  if (!identity) return { headers: {} }

  const init = request.init ?? {}
  const url = new URL(request.url)
  const method = init.method ?? 'GET'
  // getHeaders is sync in the RPC surface — use empty hashPayload (no body on WS handshake).
  // Full body-hash ADR-289 is applied in performSignedFetch for HTTP.
  const metadata: Record<string, unknown> = sceneContext?.sceneId
    ? {
        signer: 'decentraland-kernel-scene',
        sceneId: sceneContext.sceneId,
        parcel: sceneContext.parcel,
        tld: 'org',
        network: 'mainnet',
        isGuest: sceneContext.isGuest === true,
        realmName: sceneContext.realmName || 'main',
        realm: {
          hostname: sceneContext.realmHostname ?? 'realm.decentraland.org',
          protocol: sceneContext.realmProtocol ?? 'https',
          serverName: sceneContext.realmName || 'main'
        },
        hashPayload: ''
      }
    : {}

  const authHeaders = signedHeader(
    identity,
    method,
    url.pathname,
    metadata,
    headersToRecord(init.headers)
  )

  return { headers: headersFromSigned(authHeaders) }
}

/** Scene `~system/SignedFetch.signedFetch` — signed when wallet/guest identity present. */
export async function performSignedFetch(
  request: SignedFetchRequest,
  identity: AuthIdentity | null,
  sceneContext?: SignedFetchSceneContext | null
): Promise<SignedFetchResponse> {
  const init = request.init ?? {}
  const method = init.method ?? 'GET'
  const requestHeaders = headersToRecord(init.headers)
  const body =
    typeof init.body === 'string'
      ? init.body
      : init.body != null
        ? String(init.body)
        : undefined

  try {
    const usePlainFetch = prefersPlainSceneHttpFetch(request.url)
    const useGatekeeperOnly =
      !usePlainFetch &&
      !!identity &&
      !!sceneContext?.sceneId &&
      isGatekeeperSignedFetchUrl(request.url)

    // ADR-289 kernel metadata for all non-plain scene signed fetches (Colyseus fishing, etc.).
    // Gatekeeper uses compact companion-compatible metadata.
    const metadata =
      identity && !usePlainFetch
        ? useGatekeeperOnly
          ? gatekeeperMetadata(sceneContext!)
          : await buildSceneKernelMetadata(sceneContext, body)
        : null

    // Prefer same-origin proxy for third-party hosts in dev (CORS).
    // Sign the original URL path; transport via /api/scene-http/...
    const proxyUrl = sceneHttpProxyUrl(request.url)
    if (proxyUrl) {
      let headers: Record<string, string> = { ...requestHeaders }
      if (identity && !usePlainFetch && metadata) {
        const url = new URL(request.url)
        const signed = signedHeader(identity, method, url.pathname, metadata, requestHeaders)
        headers = { ...headers, ...headersFromSigned(signed) }
      }
      if (body != null && !headers['Content-Type'] && !headers['content-type']) {
        headers['Content-Type'] = 'application/json'
      }
      const res = await fetch(proxyUrl, { method, headers, body })
      const text = await res.text()
      if (!res.ok && import.meta.env.DEV) {
        console.warn(
          `[SignedFetch] proxy ${res.status} ${request.url.slice(0, 80)}… body=${text.slice(0, 200)}`
        )
      }
      return {
        ok: res.ok,
        status: res.status,
        statusText: res.statusText,
        body: text,
        headers: headersRecordFromResponse(res)
      }
    }

    const fetchInit: RequestInit = {
      method,
      headers: requestHeaders,
      body
    }

    const res =
      identity && !usePlainFetch
        ? await signedFetch(request.url, {
            ...fetchInit,
            identity,
            ...(metadata ? { metadata } : {})
          })
        : await fetch(request.url, fetchInit)

    const text = await res.text()
    if (!res.ok && import.meta.env.DEV) {
      console.warn(
        `[SignedFetch] ${res.status} ${request.url.slice(0, 80)}… body=${text.slice(0, 200)}`
      )
    }
    return {
      ok: res.ok,
      status: res.status,
      statusText: res.statusText,
      body: text,
      headers: headersRecordFromResponse(res)
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (import.meta.env.DEV) {
      console.warn(`[SignedFetch] failed ${request.url.slice(0, 80)}…`, message)
    }
    return {
      ok: false,
      status: 0,
      statusText: message,
      body: '',
      headers: {}
    }
  }
}
