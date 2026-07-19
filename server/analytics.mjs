#!/usr/bin/env node
/**
 * Place analytics service:
 *   POST /api/analytics/events
 *   POST /api/analytics/login   (legacy)
 *   GET  /api/analytics/places/:placeKey/summary?window=7d|30d
 *   GET  /health
 *
 * Deploy layouts:
 *   Flat (PM2 / FTP):  analytics.mjs + analytics-core.mjs in same folder
 *   Repo:              server/analytics.mjs + scripts/analytics-core.mjs
 *
 *   ANALYTICS_PORT=8787 node analytics.mjs
 *
 * Optional Supabase mirror:
 *   SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
 *
 * Storage: data/place-events.jsonl (or ANALYTICS_EVENTS_PATH)
 */
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/** Flat deploy: ./analytics-core.mjs · Repo: ../scripts/analytics-core.mjs */
function resolveCoreUrl() {
  const flat = path.join(__dirname, 'analytics-core.mjs')
  const nested = path.join(__dirname, '../scripts/analytics-core.mjs')
  if (fs.existsSync(flat)) return pathToFileURL(flat).href
  if (fs.existsSync(nested)) return pathToFileURL(nested).href
  throw new Error(
    `[analytics] analytics-core.mjs not found next to this file or at ../scripts/\n  tried: ${flat}\n  tried: ${nested}`
  )
}

const { handleAnalyticsRequest, ensureEventsFile, resolveEventsPath } = await import(resolveCoreUrl())

const PORT = Number(process.env.ANALYTICS_PORT ?? 8787)

ensureEventsFile()

const server = http.createServer(async (req, res) => {
  try {
    const handled = await handleAnalyticsRequest(req, res)
    if (!handled) {
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'not_found' }))
    }
  } catch (err) {
    console.error('[analytics] request failed', err)
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'internal' }))
    }
  }
})

server.listen(PORT, '127.0.0.1', () => {
  console.info(`[analytics] listening on 127.0.0.1:${PORT}`)
  console.info(`[analytics] events → ${resolveEventsPath()}`)
  if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.info('[analytics] Supabase mirror enabled')
  } else {
    console.info('[analytics] Supabase mirror off (set SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY)')
  }
})
