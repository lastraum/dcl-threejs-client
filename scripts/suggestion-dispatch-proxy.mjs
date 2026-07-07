/**
 * POST /api/suggestions → GitHub repository_dispatch (client-suggestion).
 * Used by vite dev middleware and optional production edge proxy.
 *
 * Env: SUGGESTION_DISPATCH_TOKEN — PAT or fine-grained token with `repo` / contents write.
 */

const REPO = process.env.SUGGESTION_DISPATCH_REPO ?? 'lastraum/dcl-threejs-client'
const TOKEN = process.env.SUGGESTION_DISPATCH_TOKEN ?? ''

const MIN_SUMMARY = 4
const MAX_SUMMARY = 120
const MIN_DETAILS = 10
const MAX_DETAILS = 8000

export function validateSuggestionPayload(body) {
  const summary = String(body?.summary ?? '').trim()
  const details = String(body?.details ?? '').trim()
  const category = String(body?.category ?? 'Other').trim() || 'Other'
  if (summary.length < MIN_SUMMARY || summary.length > MAX_SUMMARY) {
    return { ok: false, status: 400, error: `summary must be ${MIN_SUMMARY}–${MAX_SUMMARY} characters` }
  }
  if (details.length < MIN_DETAILS || details.length > MAX_DETAILS) {
    return { ok: false, status: 400, error: `details must be ${MIN_DETAILS}–${MAX_DETAILS} characters` }
  }
  return {
    ok: true,
    payload: {
      summary,
      details,
      category,
      author: String(body?.author ?? body?.contact ?? '').trim().slice(0, 120) || undefined,
      client_version: String(body?.client_version ?? 'unknown').trim().slice(0, 40),
      page_url: String(body?.page_url ?? '').trim().slice(0, 500),
      route: String(body?.route ?? '').trim().slice(0, 120) || undefined,
      user_agent: String(body?.user_agent ?? '').trim().slice(0, 300)
    }
  }
}

export async function dispatchClientSuggestion(clientPayload) {
  if (!TOKEN) {
    return { ok: false, status: 503, error: 'SUGGESTION_DISPATCH_TOKEN not configured' }
  }
  const res = await fetch(`https://api.github.com/repos/${REPO}/dispatches`, {
    method: 'POST',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28'
    },
    body: JSON.stringify({
      event_type: 'client-suggestion',
      client_payload: clientPayload
    })
  })
  if (res.status === 204) return { ok: true, status: 204 }
  const text = await res.text().catch(() => '')
  let error = text.trim() || `GitHub dispatch failed (${res.status})`
  try {
    const json = JSON.parse(text)
    if (json?.message) error = String(json.message)
  } catch {
    /* keep raw text */
  }
  return { ok: false, status: res.status || 502, error }
}

/** Vite connect middleware handler. */
export function createSuggestionProxyMiddleware() {
  return async function suggestionProxy(req, res, next) {
    const path = (req.url ?? '').split('?')[0]
    if (req.method !== 'POST' || path !== '/api/suggestions') {
      next()
      return
    }
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
    })
    req.on('end', async () => {
      let body
      try {
        body = raw ? JSON.parse(raw) : {}
      } catch {
        res.statusCode = 400
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ error: 'Invalid JSON' }))
        return
      }
      const validated = validateSuggestionPayload(body)
      if (!validated.ok) {
        res.statusCode = validated.status
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ error: validated.error }))
        return
      }
      const dispatched = await dispatchClientSuggestion(validated.payload)
      res.statusCode = dispatched.status
      res.setHeader('Content-Type', 'application/json')
      if (dispatched.ok) {
        res.end(JSON.stringify({ ok: true }))
      } else {
        res.end(JSON.stringify({ error: dispatched.error }))
      }
    })
  }
}