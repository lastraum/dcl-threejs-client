#!/usr/bin/env node
/**
 * Lightweight backend for the static client:
 *   POST /api/analytics/login — append login events to JSONL
 *   POST /api/report-bug       — create GitHub issues when GITHUB_BUG_REPORT_TOKEN is set
 *
 *   ANALYTICS_PORT=8787 ANALYTICS_LOG_PATH=/var/lib/dcl-analytics/logins.jsonl node server/analytics.mjs
 *
 * Nginx (see decentraland.lastslice.co):
 *   location /api/analytics/ { proxy_pass http://127.0.0.1:8787; }
 *   location = /api/report-bug { proxy_pass http://127.0.0.1:8787; }
 */

import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PORT = Number(process.env.ANALYTICS_PORT ?? 8787)
const LOG_PATH =
  process.env.ANALYTICS_LOG_PATH ??
  path.join(path.dirname(fileURLToPath(import.meta.url)), '../data/logins.jsonl')
const WRITE_TOKEN = process.env.ANALYTICS_WRITE_TOKEN?.trim() || ''
const GITHUB_REPO = process.env.GITHUB_BUG_REPORT_REPO?.trim() || 'lastraum/dcl-threejs-client'
const GITHUB_TOKEN =
  process.env.GITHUB_BUG_REPORT_TOKEN?.trim() || process.env.GITHUB_TOKEN?.trim() || ''

fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true })

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function normalizeEntry(raw) {
  const kind = raw?.kind === 'wallet' ? 'wallet' : 'guest'
  const at = typeof raw?.at === 'string' ? raw.at : new Date().toISOString()
  const entry = {
    kind,
    at,
    receivedAt: new Date().toISOString()
  }
  if (kind === 'wallet' && typeof raw?.address === 'string') {
    const address = raw.address.trim().toLowerCase()
    if (/^0x[a-f0-9]{40}$/.test(address)) entry.address = address
  }
  if (typeof raw?.path === 'string' && raw.path.length <= 512) entry.path = raw.path
  if (typeof raw?.version === 'string' && raw.version.length <= 32) entry.version = raw.version
  return entry
}

function appendLine(entry) {
  return new Promise((resolve, reject) => {
    const line = `${JSON.stringify(entry)}\n`
    fs.appendFile(LOG_PATH, line, { encoding: 'utf8' }, (err) => (err ? reject(err) : resolve()))
  })
}

function normalizeBugReport(raw) {
  const title = typeof raw?.title === 'string' ? raw.title.trim().slice(0, 256) : ''
  const body = typeof raw?.body === 'string' ? raw.body.trim().slice(0, 60000) : ''
  if (!title || !body) throw new Error('missing_title_or_body')
  return { title, body }
}

async function createGithubIssue({ title, body }) {
  if (!GITHUB_TOKEN) return null
  const [owner, repo] = GITHUB_REPO.split('/')
  if (!owner || !repo) throw new Error('invalid_repo')

  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/issues`, {
    method: 'POST',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      'Content-Type': 'application/json',
      'User-Agent': 'dcl-threejs-client-bug-report',
      'X-GitHub-Api-Version': '2022-11-28'
    },
    body: JSON.stringify({ title, body, labels: ['bug'] })
  })

  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const message = typeof data?.message === 'string' ? data.message : `github_${res.status}`
    throw new Error(message)
  }
  if (!data?.html_url || typeof data.number !== 'number') throw new Error('github_invalid_response')
  return { issueUrl: data.html_url, issueNumber: data.number }
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    })
    res.end()
    return
  }

  if (req.method === 'GET' && req.url === '/health') {
    json(res, 200, { ok: true })
    return
  }

  if (req.method === 'POST' && req.url === '/api/report-bug') {
    try {
      const text = await readBody(req)
      const raw = text ? JSON.parse(text) : {}
      const report = normalizeBugReport(raw)
      const created = await createGithubIssue(report)
      if (!created) {
        json(res, 503, { error: 'github_not_configured' })
        return
      }
      json(res, 201, created)
    } catch (err) {
      console.error('[analytics] bug report failed:', err)
      json(res, 400, { error: err instanceof Error ? err.message : 'bad_request' })
    }
    return
  }

  if (req.method !== 'POST' || req.url !== '/api/analytics/login') {
    json(res, 404, { error: 'not_found' })
    return
  }

  if (WRITE_TOKEN) {
    const auth = req.headers.authorization ?? ''
    if (auth !== `Bearer ${WRITE_TOKEN}`) {
      json(res, 401, { error: 'unauthorized' })
      return
    }
  }

  try {
    const text = await readBody(req)
    const raw = text ? JSON.parse(text) : {}
    const entry = normalizeEntry(raw)
    await appendLine(entry)
    res.writeHead(204)
    res.end()
  } catch (err) {
    console.error('[analytics] write failed:', err)
    json(res, 400, { error: 'bad_request' })
  }
})

server.listen(PORT, '127.0.0.1', () => {
  console.info(`[analytics] listening on 127.0.0.1:${PORT} → ${LOG_PATH}`)
})