/**
 * POST /api/suggestions → GitHub Issues API (labeled `suggestion`).
 * Used by vite dev middleware and optional production edge proxy.
 *
 * Env: SUGGESTION_DISPATCH_TOKEN — PAT with Issues write on the repo.
 *   Fine-grained: Repository access → dcl-threejs-client, Issues → Read and write.
 *   Classic: `public_repo` (public repo) or `repo` scope.
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

export function formatSuggestionIssue(p) {
  const title = `[suggestion] ${p.summary}`.slice(0, 256)
  const body = [
    '### Summary',
    p.summary,
    '',
    '### Category',
    p.category,
    '',
    '### Details',
    p.details,
    '',
    '### Context',
    `- Client: \`${p.client_version}\``,
    p.route ? `- Route: \`${p.route}\`` : null,
    p.page_url ? `- Page: ${p.page_url}` : null,
    p.author ? `- Author: ${p.author}` : null,
    p.user_agent ? `- UA: \`${p.user_agent}\`` : null,
    '',
    '---',
    '_Submitted from the Three.js client dev panel._'
  ]
    .filter((line) => line !== null)
    .join('\n')
  return { title, body }
}

function githubHeaders() {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${TOKEN}`,
    'Content-Type': 'application/json',
    'X-GitHub-Api-Version': '2022-11-28'
  }
}

async function readGitHubError(res) {
  const text = await res.text().catch(() => '')
  let error = text.trim() || `GitHub request failed (${res.status})`
  try {
    const json = JSON.parse(text)
    if (json?.message) {
      error = String(json.message)
      if (json.documentation_url) error += ` — see ${json.documentation_url}`
    }
  } catch {
    /* keep raw text */
  }
  return error
}

/** Create a labeled suggestion issue (Issues API — no repository_dispatch scope needed). */
export async function createClientSuggestionIssue(clientPayload) {
  if (!TOKEN) {
    return { ok: false, status: 503, error: 'SUGGESTION_DISPATCH_TOKEN not configured' }
  }
  const { title, body } = formatSuggestionIssue(clientPayload)
  const res = await fetch(`https://api.github.com/repos/${REPO}/issues`, {
    method: 'POST',
    headers: githubHeaders(),
    body: JSON.stringify({
      title,
      body,
      labels: ['suggestion']
    })
  })
  if (res.status === 201) {
    const issue = await res.json()
    return {
      ok: true,
      status: 201,
      issue_number: issue.number,
      issue_url: issue.html_url
    }
  }
  const error = await readGitHubError(res)
  if (res.status === 403 && error.includes('personal access token')) {
    return {
      ok: false,
      status: 403,
      error:
        `${error} — use a fine-grained PAT with Issues: Read and write on ${REPO}, or a classic PAT with public_repo/repo scope.`
    }
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
      const created = await createClientSuggestionIssue(validated.payload)
      res.statusCode = created.status
      res.setHeader('Content-Type', 'application/json')
      if (created.ok) {
        res.end(
          JSON.stringify({
            ok: true,
            issue_number: created.issue_number,
            issue_url: created.issue_url
          })
        )
      } else {
        res.end(JSON.stringify({ error: created.error }))
      }
    })
  }
}