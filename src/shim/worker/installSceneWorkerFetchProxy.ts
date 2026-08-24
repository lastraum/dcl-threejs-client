/**
 * Scene worker `fetch` — same-origin `/api/scene-http` egress.
 *
 * This client is a website: cross-origin `fetch` from the worker hits CORS
 * (NASA Horizons, GDACS, many CDNs). Direct-first logged a false CORS error
 * on every first request even when the retry succeeded.
 *
 * Cross-origin http(s) always goes through `/api/scene-http` (Vite + nginx).
 * Same-origin / relative / bypass hosts stay direct. SSRF guards live in
 * `toSceneHttpProxyUrl`.
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

/** Patch worker global fetch before scene bundle eval — idempotent. */
export function installSceneWorkerFetchProxy(): void {
  const g = globalThis as typeof globalThis & { __sceneWorkerFetchProxy?: boolean }
  if (g.__sceneWorkerFetchProxy) return
  g.__sceneWorkerFetchProxy = true

  const nativeFetch = globalThis.fetch.bind(globalThis)

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

    if (typeof input === 'string' || input instanceof URL) {
      return wrapPlaces(proxyAbsolute, nativeFetch(proxyAbsolute, init))
    }
    if (input instanceof Request) {
      return wrapPlaces(proxyAbsolute, nativeFetch(new Request(proxyAbsolute, input)))
    }
    return wrapPlaces(proxyAbsolute, nativeFetch(proxyAbsolute, init))
  }) as typeof fetch
}
