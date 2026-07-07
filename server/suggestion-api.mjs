/**
 * Production suggestion API — POST /api/suggestions → GitHub Issues.
 *
 * Run on droplet (localhost); nginx proxies same-origin /api/suggestions here.
 *
 *   SUGGESTION_DISPATCH_TOKEN=github_pat_...  (Issues: Read and write)
 *   SUGGESTION_API_PORT=8788
 *   node server/suggestion-api.mjs
 */

import http from 'node:http'
import {
  createClientSuggestionIssue,
  validateSuggestionPayload
} from '../scripts/suggestion-dispatch-proxy.mjs'

const HOST = process.env.SUGGESTION_API_HOST ?? '127.0.0.1'
const PORT = Number(process.env.SUGGESTION_API_PORT ?? 8788)

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
    })
    req.on('end', () => resolve(raw))
    req.on('error', reject)
  })
}

function sendJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(payload))
}

const server = http.createServer(async (req, res) => {
  const path = (req.url ?? '').split('?')[0]

  if (req.method === 'OPTIONS' && path === '/api/suggestions') {
    res.writeHead(204, {
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    })
    res.end()
    return
  }

  if (req.method !== 'POST' || path !== '/api/suggestions') {
    sendJson(res, 404, { error: 'Not found' })
    return
  }

  let body
  try {
    const raw = await readBody(req)
    body = raw ? JSON.parse(raw) : {}
  } catch {
    sendJson(res, 400, { error: 'Invalid JSON' })
    return
  }

  const validated = validateSuggestionPayload(body)
  if (!validated.ok) {
    sendJson(res, validated.status, { error: validated.error })
    return
  }

  const created = await createClientSuggestionIssue(validated.payload)
  if (created.ok) {
    sendJson(res, 201, {
      ok: true,
      issue_number: created.issue_number,
      issue_url: created.issue_url
    })
    return
  }
  sendJson(res, created.status, { error: created.error })
})

server.listen(PORT, HOST, () => {
  console.log(`suggestion-api listening on http://${HOST}:${PORT}/api/suggestions`)
})