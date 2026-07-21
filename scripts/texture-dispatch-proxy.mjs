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

/** Magic-byte MIME for content CDN hashes (no extension) served as octet-stream. */
function sniffImageMime(buf) {
  if (!buf || buf.length < 12) return null
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png'
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg'
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return 'image/gif'
  if (
    buf[0] === 0x52 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x46 &&
    buf[8] === 0x57 &&
    buf[9] === 0x45 &&
    buf[10] === 0x42 &&
    buf[11] === 0x50
  ) {
    return 'image/webp'
  }
  if (buf[0] === 0x42 && buf[1] === 0x4d) return 'image/bmp'
  return null
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
      const buffer = Buffer.from(await upstream.arrayBuffer())
      // Event posters / content CDN often arrive as application/octet-stream (+ nosniff).
      // Fix MIME from path or magic bytes so Image() loads (Jump Zone logos, etc.).
      if (
        !contentType ||
        /octet-stream|application\/binary/i.test(contentType) ||
        !/^image\//i.test(contentType)
      ) {
        const leaf = (target.split('?')[0] ?? '').toLowerCase()
        if (leaf.endsWith('.webp')) contentType = 'image/webp'
        else if (leaf.endsWith('.png')) contentType = 'image/png'
        else if (leaf.endsWith('.jpg') || leaf.endsWith('.jpeg')) contentType = 'image/jpeg'
        else if (leaf.endsWith('.gif')) contentType = 'image/gif'
        else contentType = sniffImageMime(buffer) ?? contentType ?? 'image/png'
      }
      if (contentType) res.setHeader('Content-Type', contentType)
      res.end(buffer)
    } catch (err) {
      res.statusCode = 502
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ error: String(err) }))
    }
  }
}
