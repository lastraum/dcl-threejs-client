/**
 * Cloudflare Worker — dev panel suggestions → GitHub Issues (label: suggestion).
 *
 * Dashboard: paste this file → Deploy
 * Secret: SUGGESTION_DISPATCH_TOKEN = fine-grained PAT (Issues: Read and write)
 * URL: https://dcl-threejs-client-suggestions.lastraum.workers.dev
 *
 * Prod build: VITE_SUGGESTION_DISPATCH_URL=https://dcl-threejs-client-suggestions.lastraum.workers.dev
 */

const REPO = 'lastraum/dcl-threejs-client'
const MIN_SUMMARY = 4
const MAX_SUMMARY = 120
const MIN_DETAILS = 10
const MAX_DETAILS = 8000

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
}

function json(data, status = 200) {
  return Response.json(data, { status, headers: CORS })
}

function formatIssueBody(p) {
  return [
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
}

function validate(body) {
  const summary = String(body?.summary ?? '').trim()
  const details = String(body?.details ?? '').trim()
  const category = String(body?.category ?? 'Other').trim() || 'Other'
  if (summary.length < MIN_SUMMARY || summary.length > MAX_SUMMARY) {
    return { ok: false, error: `summary must be ${MIN_SUMMARY}–${MAX_SUMMARY} characters` }
  }
  if (details.length < MIN_DETAILS || details.length > MAX_DETAILS) {
    return { ok: false, error: `details must be ${MIN_DETAILS}–${MAX_DETAILS} characters` }
  }
  return {
    ok: true,
    payload: {
      summary,
      details,
      category,
      author: String(body?.author ?? '').trim().slice(0, 120) || undefined,
      client_version: String(body?.client_version ?? 'unknown').trim().slice(0, 40),
      page_url: String(body?.page_url ?? '').trim().slice(0, 500),
      route: String(body?.route ?? '').trim().slice(0, 120) || undefined,
      user_agent: String(body?.user_agent ?? '').trim().slice(0, 300)
    }
  }
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS })
    }

    if (request.method !== 'POST') {
      return json({ error: 'Method not allowed — POST only' }, 405)
    }

    const token = env.SUGGESTION_DISPATCH_TOKEN
    if (!token) {
      return json(
        {
          error: 'SUGGESTION_DISPATCH_TOKEN secret not set',
          hint: 'Worker Settings → Variables and Secrets → Add secret → Redeploy'
        },
        503
      )
    }

    let body
    try {
      body = await request.json()
    } catch {
      return json({ error: 'Invalid JSON body' }, 400)
    }

    const validated = validate(body)
    if (!validated.ok) {
      return json({ error: validated.error }, 400)
    }

    const p = validated.payload
    const title = `[suggestion] ${p.summary}`.slice(0, 256)
    const issueBody = formatIssueBody(p)

    const gh = await fetch(`https://api.github.com/repos/${REPO}/issues`, {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'dcl-threejs-client-suggestions-worker'
      },
      body: JSON.stringify({
        title,
        body: issueBody,
        labels: ['suggestion']
      })
    })

    const ghText = await gh.text()
    let ghJson = {}
    try {
      ghJson = ghText ? JSON.parse(ghText) : {}
    } catch {
      ghJson = { message: ghText }
    }

    if (!gh.ok) {
      return json(
        {
          error: ghJson.message ?? 'GitHub request failed',
          github_status: gh.status,
          documentation_url: ghJson.documentation_url ?? null
        },
        gh.status
      )
    }

    return json(
      {
        ok: true,
        issue_number: ghJson.number,
        issue_url: ghJson.html_url
      },
      201
    )
  }
}