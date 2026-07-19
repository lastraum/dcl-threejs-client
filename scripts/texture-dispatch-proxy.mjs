/**
 * GET /api/texture/<https|http>/<host>/<path> → fetches the real remote
 * image and streams it back same-origin (dev CORS workaround).
 *
 * Vite's built-in `server.proxy` is backed by the base `http-proxy` package,
 * which has no `router` option (that's an `http-proxy-middleware`-only
 * feature) — a static `target` always wins, so per-request host selection
 * silently never happens. This middleware does the routing itself instead.
 */

const TEXTURE_PROXY_RE = /^\/api\/texture\/(https?)\/([^/?#]+)(\/[^?#]*)?/

export function resolveTextureProxyTarget(url) {
  const match = url.match(TEXTURE_PROXY_RE)
  if (!match) return null
  const [, proto, host, rest = ''] = match
  return `${proto}://${host}${rest}`
}

/** Vite connect middleware handler. */
export function createTextureProxyMiddleware() {
  return async function textureProxy(req, res, next) {
    const target = req.url ? resolveTextureProxyTarget(req.url) : null
    if (req.method !== 'GET' || !target) {
      next()
      return
    }
    try {
      const upstream = await fetch(target)
      if (!upstream.ok) {
        res.statusCode = upstream.status
        res.end()
        return
      }
      res.statusCode = 200
      let contentType = upstream.headers.get('content-type')
      // Event posters often arrive as application/octet-stream — fix MIME from path so Image() loads.
      if (
        !contentType ||
        /octet-stream|application\/binary/i.test(contentType)
      ) {
        const leaf = (target.split('?')[0] ?? '').toLowerCase()
        if (leaf.endsWith('.webp')) contentType = 'image/webp'
        else if (leaf.endsWith('.png')) contentType = 'image/png'
        else if (leaf.endsWith('.jpg') || leaf.endsWith('.jpeg')) contentType = 'image/jpeg'
        else if (leaf.endsWith('.gif')) contentType = 'image/gif'
      }
      if (contentType) res.setHeader('Content-Type', contentType)
      const buffer = Buffer.from(await upstream.arrayBuffer())
      res.end(buffer)
    } catch (err) {
      res.statusCode = 502
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ error: String(err) }))
    }
  }
}
