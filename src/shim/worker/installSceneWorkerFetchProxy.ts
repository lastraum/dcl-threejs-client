/**
 * Rewrite scene-script fetches to same-origin API proxies — Genesis Plaza and other
 * deployed scenes hardcode decentraland.org hosts that block custom client origins.
 */
const PLACES_API_ORIGIN = 'https://places.decentraland.org/api'
const MARKETPLACE_API_ORIGIN = 'https://marketplace-api.decentraland.org'

function rewriteFetchUrl(input: string): string {
  if (input.startsWith(PLACES_API_ORIGIN)) {
    const rest = input.slice(PLACES_API_ORIGIN.length)
    return `/api/places${rest.startsWith('/') ? rest : `/${rest}`}`
  }
  if (input.startsWith(MARKETPLACE_API_ORIGIN)) {
    const rest = input.slice(MARKETPLACE_API_ORIGIN.length)
    return `/api/marketplace${rest.startsWith('/') ? rest : `/${rest}`}`
  }
  return input
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

    const rewritten = rewriteFetchUrl(url)
    if (rewritten === url) return nativeFetch(input, init)

    if (typeof input === 'string' || input instanceof URL) {
      return nativeFetch(rewritten, init)
    }
    if (input instanceof Request) {
      return nativeFetch(new Request(rewritten, input), init)
    }
    return nativeFetch(input, init)
  }) as typeof fetch
}