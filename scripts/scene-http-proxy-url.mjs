/**
 * Shared pure helpers for generic scene HTTP proxy (Node / Vite middleware).
 * Keep path shape in sync with src/network/sceneHttpProxy.ts
 *
 *   /api/scene-http/<https|http>/<host>/<path>?<query>
 */

export const SCENE_HTTP_PROXY_PREFIX = '/api/scene-http'

const SCENE_HTTP_RE = /^\/api\/scene-http\/(https?)\/([^/?#]+)(\/[^?#]*)?(\?.*)?$/i

export function resolveSceneHttpProxyTarget(url) {
  const pathOnly = url.startsWith('http')
    ? (() => {
        try {
          const u = new URL(url)
          return u.pathname + u.search
        } catch {
          return url
        }
      })()
    : url
  const match = pathOnly.match(SCENE_HTTP_RE)
  if (!match) return null
  const [, proto, host, path = '', query = ''] = match
  return `${proto}://${host}${path || ''}${query || ''}`
}

function shouldBypassProxyHost(hostname) {
  const h = String(hostname || '').toLowerCase()
  if (h === 'localhost' || h === '127.0.0.1' || h === '[::1]') return true
  if (h.endsWith('.local')) return true
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) {
    const [a, b] = h.split('.').map(Number)
    if (a === 10 || a === 127 || a === 0) return true
    if (a === 192 && b === 168) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 169 && b === 254) return true
  }
  if (h.includes('worlds-content-server')) return true
  if (h.includes('content-assets')) return true
  // peer.decentraland.org lambdas/collections omits CORS — must proxy (see sceneHttpProxy.ts).
  return false
}

/** Keep in sync with sceneHttpProxy.ts `sceneFetchShouldFallbackToProxy`. */
export function sceneFetchShouldFallbackToProxy(status) {
  return status === 'network-error' || status === 0 || status === 404
}

/** Absolute URL → proxy path (same rules as TS client helper). */
export function toSceneHttpProxyUrl(absoluteUrl) {
  try {
    const u = new URL(absoluteUrl)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    if (shouldBypassProxyHost(u.hostname)) return null
    if (u.pathname.startsWith(`${SCENE_HTTP_PROXY_PREFIX}/`)) return null
    const proto = u.protocol === 'https:' ? 'https' : 'http'
    const path = u.pathname.startsWith('/') ? u.pathname : `/${u.pathname}`
    return `${SCENE_HTTP_PROXY_PREFIX}/${proto}/${u.host}${path}${u.search}`
  } catch {
    return null
  }
}
