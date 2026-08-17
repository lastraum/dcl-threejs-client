/**
 * Scene worker `fetch` — Explorer parity.
 *
 * Explorer's worker talks to the real URL from the user's browser (CORS as the
 * page origin). `/api/scene-http` is only a fallback for hosts that reject
 * that (no ACAO). Proxy-first used the server IP and broke any sheet/CDN that
 * allows the browser but 403s datacenter egress.
 *
 * Per-host memory: first request is direct; TypeError (CORS / failed to fetch)
 * retries via the proxy and sticks that host on the proxy path.
 */
import {
  isPlacesUpstreamUrl,
  toSceneHttpProxyUrl
} from '../../network/sceneHttpProxy'

/** Places lookups assume `data` is an array — normalize empty/error bodies. */
async function normalizePlacesJsonResponse(res: Response): Promise<Response> {
  if (!res.ok) return res
  try {
    const body = (await res.clone().json()) as { data?: unknown }
    if (!body || typeof body !== 'object' || Array.isArray(body.data)) return res
    return new Response(JSON.stringify({ ...body, data: [] }), {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers
    })
  } catch {
    return res
  }
}

function requestUrl(input: RequestInfo | URL): string | null {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.href
  if (input instanceof Request) return input.url
  return null
}

function hostnameOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return null
  }
}

/** Browser CORS / offline — not HTTP 4xx (those still have ACAO and must not retry). */
function isCorsOrNetworkFail(err: unknown): boolean {
  if (!(err instanceof TypeError)) return false
  const m = String(err.message).toLowerCase()
  return (
    m.includes('fetch') ||
    m.includes('network') ||
    m.includes('cors') ||
    m.includes('load failed') ||
    m.includes('failed to load')
  )
}

/** Patch worker global fetch before scene bundle eval — idempotent. */
export function installSceneWorkerFetchProxy(): void {
  const g = globalThis as typeof globalThis & { __sceneWorkerFetchProxy?: boolean }
  if (g.__sceneWorkerFetchProxy) return
  g.__sceneWorkerFetchProxy = true

  const nativeFetch = globalThis.fetch.bind(globalThis)
  /** Per-host: Explorer-direct works, or this origin needs the CORS proxy. */
  const hostMode = new Map<string, 'direct' | 'proxy'>()

  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = requestUrl(input)
    if (!url || (!url.startsWith('http://') && !url.startsWith('https://'))) {
      return nativeFetch(input, init)
    }

    const rewritten = toSceneHttpProxyUrl(url)
    if (!rewritten) return nativeFetch(input, init)
    // Dedicated workers must fetch an absolute same-origin URL (blob workers
    // resolve `/api/...` against the worker script, not the page).
    const origin =
      typeof location !== 'undefined' && location.origin.startsWith('http')
        ? location.origin
        : ''
    const proxyAbsolute =
      rewritten.startsWith('/') && origin ? `${origin}${rewritten}` : rewritten

    const wrapPlaces = (target: RequestInfo | URL, promise: Promise<Response>) =>
      isPlacesUpstreamUrl(url) || isPlacesUpstreamUrl(String(target))
        ? promise.then(normalizePlacesJsonResponse)
        : promise

    const fetchDirect = (): Promise<Response> => wrapPlaces(input, nativeFetch(input, init))
    const fetchProxy = (): Promise<Response> => {
      if (typeof input === 'string' || input instanceof URL) {
        return wrapPlaces(proxyAbsolute, nativeFetch(proxyAbsolute, init))
      }
      if (input instanceof Request) {
        return wrapPlaces(proxyAbsolute, nativeFetch(new Request(proxyAbsolute, input)))
      }
      return wrapPlaces(proxyAbsolute, nativeFetch(proxyAbsolute, init))
    }

    const host = hostnameOf(url)
    const mode = host ? hostMode.get(host) : undefined
    if (mode === 'proxy') return fetchProxy()
    if (mode === 'direct') return fetchDirect()

    return fetchDirect()
      .then((res) => {
        if (host) hostMode.set(host, 'direct')
        return res
      })
      .catch((err: unknown) => {
        if (!isCorsOrNetworkFail(err)) throw err
        if (host) hostMode.set(host, 'proxy')
        return fetchProxy()
      })
  }) as typeof fetch
}
