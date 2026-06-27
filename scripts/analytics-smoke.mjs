#!/usr/bin/env node
/** Quick check that analytics.mjs is reachable and accepts login events. */

const base = process.env.ANALYTICS_BASE_URL ?? 'http://127.0.0.1:8787'
const writeToken = process.env.ANALYTICS_WRITE_TOKEN?.trim() ?? ''

async function main() {
  const health = await fetch(`${base}/health`)
  if (!health.ok) throw new Error(`health ${health.status}`)
  console.info('[analytics-smoke] health ok')

  const headers = { 'Content-Type': 'application/json' }
  if (writeToken) headers.Authorization = `Bearer ${writeToken}`

  const login = await fetch(`${base}/api/analytics/login`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      kind: 'guest',
      at: new Date().toISOString(),
      path: '/smoke-test',
      version: 'smoke'
    })
  })
  if (login.status !== 204) {
    const text = await login.text().catch(() => '')
    throw new Error(`login ${login.status} ${text}`)
  }
  console.info('[analytics-smoke] login event accepted (204)')
}

main().catch((err) => {
  console.error('[analytics-smoke] failed:', err instanceof Error ? err.message : err)
  process.exit(1)
})