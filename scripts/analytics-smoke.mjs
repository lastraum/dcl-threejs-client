#!/usr/bin/env node
/** Smoke: events ingest + place summary. */

const base = process.env.ANALYTICS_BASE_URL ?? 'http://127.0.0.1:8787'

async function main() {
  const { randomUUID } = await import('node:crypto')
  const placeKey = 'world:smoke.dcl.eth'
  const visitor = randomUUID()
  const session = randomUUID()
  const play = randomUUID()
  const at = new Date().toISOString()

  const events = [
    {
      event_id: randomUUID(),
      event: 'landing_view',
      at,
      visitor_id: visitor,
      session_id: session,
      login_kind: 'guest',
      client_version: 'smoke',
      path: '/smoke.dcl.eth',
      place_kind: 'world',
      place_key: placeKey,
      world_name: 'smoke.dcl.eth',
      props: {}
    },
    {
      event_id: randomUUID(),
      event: 'jump_in_click',
      at,
      visitor_id: visitor,
      session_id: session,
      play_session_id: play,
      login_kind: 'guest',
      client_version: 'smoke',
      path: '/smoke.dcl.eth',
      place_kind: 'world',
      place_key: placeKey,
      world_name: 'smoke.dcl.eth',
      props: { entry: 'landing_cta' }
    },
    {
      event_id: randomUUID(),
      event: 'scene_enter',
      at,
      visitor_id: visitor,
      session_id: session,
      play_session_id: play,
      login_kind: 'guest',
      client_version: 'smoke',
      path: '/smoke.dcl.eth',
      place_kind: 'world',
      place_key: placeKey,
      world_name: 'smoke.dcl.eth',
      props: { load_ms: 1200 }
    },
    {
      event_id: randomUUID(),
      event: 'scene_leave',
      at,
      visitor_id: visitor,
      session_id: session,
      play_session_id: play,
      login_kind: 'guest',
      client_version: 'smoke',
      path: '/smoke.dcl.eth',
      place_kind: 'world',
      place_key: placeKey,
      world_name: 'smoke.dcl.eth',
      props: { dwell_ms: 45000, reason: 'navigate' }
    }
  ]

  const post = await fetch(`${base}/api/analytics/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ events })
  })
  if (!post.ok) {
    throw new Error(`events ${post.status} ${await post.text()}`)
  }
  console.info('[analytics-smoke] events accepted', await post.json())

  const summaryUrl = `${base}/api/analytics/places/${encodeURIComponent(placeKey)}/summary?window=7d`
  const sum = await fetch(summaryUrl)
  if (!sum.ok) throw new Error(`summary ${sum.status}`)
  const body = await sum.json()
  console.info('[analytics-smoke] summary', body)
  if ((body.landing_views ?? 0) < 1 || (body.scene_enters ?? 0) < 1) {
    throw new Error('summary missing expected counts')
  }
  console.info('[analytics-smoke] ok')
}

main().catch((err) => {
  console.error('[analytics-smoke] failed:', err instanceof Error ? err.message : err)
  process.exit(1)
})