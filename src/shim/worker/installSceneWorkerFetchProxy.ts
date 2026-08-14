/**
 * Scene worker fetch → single generic same-origin pipe `/api/scene-http/...`
 * (see src/network/sceneHttpProxy.ts). Replaces per-host special cases.
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
    const absolute =
      rewritten.startsWith('/') && origin ? `${origin}${rewritten}` : rewritten

    const run = (target: RequestInfo | URL) => {
      const promise = nativeFetch(target, init)
      // Normalize when original (or proxy target) is Places
      return isPlacesUpstreamUrl(url) || isPlacesUpstreamUrl(String(target))
        ? promise.then(normalizePlacesJsonResponse)
        : promise
    }

    if (typeof input === 'string' || input instanceof URL) {
      return run(absolute)
    }
    if (input instanceof Request) {
      return run(new Request(absolute, input))
    }
    return nativeFetch(input, init)
  }) as typeof fetch
}
