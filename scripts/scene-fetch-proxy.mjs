/**
 * Dev CORS bypass for scene `~system/SignedFetch` / plain scene HTTP.
 *
 * Path: `/api/scene-http/<https|http>/<host>/<path>?<query>`
 * Forwards method, body, and allowlisted headers to the remote host.
 *
 * Auth signatures must be computed for the **original** URL pathname (see
 * SignedFetchService) — this proxy only transports the already-signed request.
 */

const SCENE_HTTP_RE = /^\/api\/scene-http\/(https?)\/([^/?#]+)(\/[^?#]*)?(\?.*)?$/

/** Headers safe to forward (exclude hop-by-hop / browser-only). */
const FORWARD_REQ_HEADERS = new Set([
  'accept',
  'accept-language',
  'authorization',
  'content-type',
  'x-identity-auth-chain-0',
  'x-identity-auth-chain-1',
  'x-identity-auth-chain-2',
  'x-identity-timestamp',
  'x-identity-metadata',
  'x-identity-auth-chain',
  // ADR-44 / crypto-fetch often lowercases multi-part chain headers
])

export function resolveSceneHttpProxyTarget(url) {
  const match = url.match(SCENE_HTTP_RE)
  if (!match) return null
  const [, proto, host, path = '', query = ''] = match
  return `${proto}://${host}${path}${query}`
}

function shouldForwardHeader(name) {
  const lower = name.toLowerCase()
  if (FORWARD_REQ_HEADERS.has(lower)) return true
  // ADR-44 chain can be many headers: x-identity-auth-chain-N
  if (lower.startsWith('x-identity-')) return true
  if (lower.startsWith('x-decentraland-')) return true
  return false
}

/**
 * @returns {import('connect').NextHandleFunction}
 */
export function createSceneFetchProxyMiddleware() {
  return async function sceneFetchProxy(req, res, next) {
    const target = req.url ? resolveSceneHttpProxyTarget(req.url) : null
    if (!target) {
      next()
      return
    }

    // CORS preflight for same-origin is rare, but answer anyway.
    if (req.method === 'OPTIONS') {
      res.statusCode = 204
      res.setHeader('Access-Control-Allow-Origin', '*')
      res.setHeader('Access-Control-Allow-Methods', 'GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS')
      res.setHeader('Access-Control-Allow-Headers', '*')
      res.end()
      return
    }

    try {
      const headers = {}
      for (const [key, value] of Object.entries(req.headers)) {
        if (value == null) continue
        if (!shouldForwardHeader(key)) continue
        headers[key] = Array.isArray(value) ? value.join(', ') : value
      }

      /** @type {Buffer | undefined} */
      let body
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        const chunks = []
        for await (const chunk of req) chunks.push(chunk)
        body = Buffer.concat(chunks)
      }

      const upstream = await fetch(target, {
        method: req.method,
        headers,
        body: body && body.length ? body : undefined
      })

      res.statusCode = upstream.status
      // Mirror useful response headers
      for (const [key, value] of upstream.headers.entries()) {
        const lower = key.toLowerCase()
        if (lower === 'transfer-encoding' || lower === 'connection') continue
        // Avoid double-compression issues
        if (lower === 'content-encoding') continue
        res.setHeader(key, value)
      }
      res.setHeader('Access-Control-Allow-Origin', '*')
      const buf = Buffer.from(await upstream.arrayBuffer())
      res.end(buf)
    } catch (err) {
      res.statusCode = 502
      res.setHeader('Content-Type', 'application/json')
      res.setHeader('Access-Control-Allow-Origin', '*')
      res.end(JSON.stringify({ error: String(err), target }))
    }
  }
}
