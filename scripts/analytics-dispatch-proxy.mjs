/**
 * Vite dev middleware: same-origin /api/analytics/* without a separate process.
 */
import { handleAnalyticsRequest, ensureEventsFile } from './analytics-core.mjs'

export function createAnalyticsProxyMiddleware() {
  ensureEventsFile()
  return function analyticsProxyMiddleware(req, res, next) {
    const url = req.url || ''
    if (!url.startsWith('/api/analytics') && url !== '/health') {
      next()
      return
    }
    // Only claim analytics paths (not /health globally)
    if (url === '/health') {
      next()
      return
    }
    void handleAnalyticsRequest(req, res, { url })
      .then((handled) => {
        if (!handled) next()
      })
      .catch((err) => {
        console.error('[analytics-proxy]', err)
        if (!res.headersSent) {
          res.statusCode = 500
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({ error: 'internal' }))
        }
      })
  }
}
