/**
 * Single generic same-origin egress for scene / third-party HTTP.
 *
 * Path shape (dev Vite middleware + prod nginx):
 *   /api/scene-http/<https|http>/<host>/<path>?<query>
 *   →  https://host/path?query
 *
 * Used by:
 * - Scene worker plain `fetch` (installSceneWorkerFetchProxy)
 * - ~system/SignedFetch (SignedFetchService)
 *
 * App-owned same-origin bases (/api/places, /api/marketplace, /api/dcl-auth-api, …)
 * stay as fixed contracts for main-thread UI — they are not replaced by this helper.
 * Absolute URLs from scene scripts always go through this one pipe when eligible.
 */

export const SCENE_HTTP_PROXY_PREFIX = '/api/scene-http'

/** Hosts that already work cross-origin or must not be double-proxied (bulk content). */
function shouldBypassProxyHost(hostname: string): boolean {
  const h = hostname.toLowerCase()
  if (h === 'localhost' || h === '127.0.0.1' || h === '[::1]') return true
  if (h.endsWith('.local')) return true

  // Private / link-local IPv4 (basic SSRF guard)
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) {
    const [a, b] = h.split('.').map(Number)
    if (a === 10 || a === 127 || a === 0) return true
    if (a === 192 && b === 168) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 169 && b === 254) return true
  }

  // Catalyst / content bulk — keep direct (bandwidth + existing content pipeline)
  if (h.includes('worlds-content-server')) return true
  if (h.includes('content-assets')) return true
  if (/^peer(-[a-z0-9]+)?\.decentraland\.org$/i.test(h)) return true
  if (h.endsWith('.decentraland.zone') || h.endsWith('.decentraland.today')) return true

  return false
}

/**
 * Absolute http(s) URL → same-origin generic proxy path, or null if direct fetch is fine.
 * Relative or same-origin `/api/*` must not be double-wrapped.
 */
export function toSceneHttpProxyUrl(absoluteUrl: string): string | null {
  try {
    // Relative same-origin paths — never wrap
    if (absoluteUrl.startsWith('/') && !absoluteUrl.startsWith('//')) return null

    const u = new URL(absoluteUrl, typeof location !== 'undefined' ? location.href : undefined)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null

    // Same-origin (page host) — already CORS-free
    if (typeof location !== 'undefined' && u.host === location.host) return null

    // Already a generic proxy path on some host
    if (
      u.pathname === SCENE_HTTP_PROXY_PREFIX ||
      u.pathname.startsWith(`${SCENE_HTTP_PROXY_PREFIX}/`)
    ) {
      return null
    }

    if (shouldBypassProxyHost(u.hostname)) return null

    const proto = u.protocol === 'https:' ? 'https' : 'http'
    const path = u.pathname.startsWith('/') ? u.pathname : `/${u.pathname}`
    return `${SCENE_HTTP_PROXY_PREFIX}/${proto}/${u.host}${path}${u.search}`
  } catch {
    return null
  }
}

/**
 * Decode a proxy path back to the upstream absolute URL (server / tests).
 * Accepts full path starting with /api/scene-http/ or a full same-origin href.
 */
export function resolveSceneHttpProxyTarget(proxyUrlOrPath: string): string | null {
  try {
    const pathOnly = proxyUrlOrPath.startsWith('http')
      ? new URL(proxyUrlOrPath).pathname + new URL(proxyUrlOrPath).search
      : proxyUrlOrPath
    const match = pathOnly.match(
      /^\/api\/scene-http\/(https?)\/([^/?#]+)(\/[^?#]*)?(\?.*)?$/i
    )
    if (!match) return null
    const [, proto, host, path = '', query = ''] = match
    return `${proto}://${host}${path || ''}${query || ''}`
  } catch {
    return null
  }
}

/** True when URL is (or rewrites to) Places API — response shape normalize. */
export function isPlacesUpstreamUrl(url: string): boolean {
  try {
    if (url.includes('places.decentraland.org')) return true
    const target = resolveSceneHttpProxyTarget(url)
    if (target && new URL(target).hostname.includes('places.decentraland.org')) return true
    // Legacy same-origin alias still used by main-thread map UI
    return url.includes('/api/places/') || /\/api\/places(\?|$)/.test(url)
  } catch {
    return url.includes('places.decentraland.org') || url.includes('/api/places')
  }
}
