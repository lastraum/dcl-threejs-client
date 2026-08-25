/**
 * Scene worker `fetch` — Explorer-parity egress (PLATFORM_COMPONENT_LAWS §3c).
 *
 * Law: the scene's URL is a **browser** request first (page origin, user IP).
 * `/api/scene-http` is only the CORS / 404 fallback. Proxy-first is forbidden —
 * datacenter IP 403s hosts the browser is allowed to read (Google gviz, etc.).
 *
 * On TypeError (CORS) or HTTP 404, retry the same-origin proxy and remember the
 * host when the proxy recovers so later polls do not re-trip the browser CORS
 * console. Bypass hosts (bulk content) stay direct-only.
 */
import {
  isPlacesUpstreamUrl,
  sceneFetchShouldFallbackToProxy,
  toSceneHttpProxyUrl
} from '../../network/sceneHttpProxy'

/** Hosts whose last direct attempt needed the proxy (CORS or recovered 404). */
const preferProxyHosts = new Set<string>()

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

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return ''
  }
}

function proxyAbsoluteUrl(rewritten: string): string {
  const origin =
    typeof location !== 'undefined' && location.origin.startsWith('http')
      ? location.origin
      : ''
  return rewritten.startsWith('/') && origin ? `${origin}${rewritten}` : rewritten
}

function asRequest(input: RequestInfo | URL, init?: RequestInit): Request {
  return input instanceof Request ? input : new Request(input, init)
}

function replayAt(nativeFetch: typeof fetch, targetUrl: string, src: Request): Promise<Response> {
  const copy = src.clone()
  const method = copy.method.toUpperCase()
  const init: RequestInit = {
    method: copy.method,
    headers: copy.headers,
    redirect: copy.redirect
  }
  if (method !== 'GET' && method !== 'HEAD') init.body = copy.body
  return nativeFetch(targetUrl, init)
}

/** Test helper. */
export function resetSceneFetchPreferProxyHosts(): void {
  preferProxyHosts.clear()
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

    const proxyUrl = proxyAbsoluteUrl(rewritten)
    const host = hostnameOf(url)
    const src = asRequest(input, init)

    const runDirect = () => replayAt(nativeFetch, url, src)
    const runProxy = () => replayAt(nativeFetch, proxyUrl, src)

    const wrapPlaces = (promise: Promise<Response>) =>
      isPlacesUpstreamUrl(url) || isPlacesUpstreamUrl(proxyUrl)
        ? promise.then(normalizePlacesJsonResponse)
        : promise

    if (host && preferProxyHosts.has(host)) {
      return wrapPlaces(runProxy())
    }

    return wrapPlaces(
      (async () => {
        try {
          const res = await runDirect()
          if (!sceneFetchShouldFallbackToProxy(res.status)) return res
          const proxied = await runProxy()
          if (proxied.ok && host) preferProxyHosts.add(host)
          return proxied
        } catch {
          if (host) preferProxyHosts.add(host)
          return runProxy()
        }
      })()
    )
  }) as typeof fetch
}
