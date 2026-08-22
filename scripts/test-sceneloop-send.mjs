#!/usr/bin/env node
/**
 * Standing-in send picker — keep in sync with src/core/sceneLoop/pickGuestsToSend.ts
 * Run: node scripts/test-sceneloop-send.mjs
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const src = readFileSync(join(process.cwd(), 'src/core/sceneLoop/pickGuestsToSend.ts'), 'utf8')
if (!src.includes('(dist * dist) / wait')) {
  console.error('FAIL: pickGuestsToSend.ts missing dist²/wait score')
  process.exit(1)
}

function muteScore(g, now) {
  const dist = Number.isFinite(g.distM) ? g.distM : Number.POSITIVE_INFINITY
  const wait = Math.max(1, now - (g.lastSentMs || 0))
  return (dist * dist) / wait
}

function pickGuestsToSend(guests, opts) {
  const sendIds = []
  let due = 0
  let inFlight = 0
  let muteSent = 0
  const currentId = opts.currentGuestId
  const eligible = []

  for (const g of guests) {
    if (g.inFlight) {
      inFlight++
      continue
    }
    if (!g.due) continue
    due++
    eligible.push(g)
  }

  if (opts.exclusiveSecondarySlot) {
    const currentDue = eligible.some((g) => g.kind === 'secondary' && g.id === currentId)
    let secondarySent = 0
    const ordered = [...eligible].sort((a, b) => {
      if (a.priority !== b.priority) return a.priority ? -1 : 1
      if (a.kind === 'primary') return -1
      if (b.kind === 'primary') return 1
      return 0
    })
    for (const g of ordered) {
      if (g.kind === 'secondary') {
        if (secondarySent >= 1) continue
        if (currentDue && g.id !== currentId) continue
        secondarySent++
      }
      sendIds.push(g.id)
    }
    return { sendIds, due, inFlight, muteSent }
  }

  const sent = new Set()
  const push = (id) => {
    if (sent.has(id)) return
    sent.add(id)
    sendIds.push(id)
  }

  const priorityDue = eligible
    .filter((g) => g.priority)
    .sort((a, b) => {
      if (a.kind === 'primary') return -1
      if (b.kind === 'primary') return 1
      return 0
    })
  for (const g of priorityDue) push(g.id)

  if (currentId) {
    const cur = eligible.find((g) => g.id === currentId && g.kind === 'secondary')
    if (cur) push(cur.id)
  }

  if (opts.allowMuteSecondary) {
    const mutes = eligible
      .filter((g) => g.kind === 'secondary' && g.id !== currentId && !sent.has(g.id))
      .sort((a, b) => muteScore(a, opts.now) - muteScore(b, opts.now))
    if (mutes[0]) {
      push(mutes[0].id)
      muteSent = 1
    }
  }

  return { sendIds, due, inFlight, muteSent }
}

function guest(partial) {
  return {
    id: 'x',
    kind: 'secondary',
    priority: false,
    inFlight: false,
    due: true,
    lastSentMs: 0,
    distM: 10,
    ...partial
  }
}

let failed = 0
function assert(label, cond) {
  if (cond) console.log(`  ok ${label}`)
  else {
    failed++
    console.error(` FAIL ${label}`)
  }
}

const now = 1000
const primary = guest({ id: 'primary', kind: 'primary', priority: true, distM: 0 })
const pe = guest({ id: 'pe:1', kind: 'pe', priority: true, distM: 0 })
const current = guest({ id: 'secondary:cur', lastSentMs: 980, distM: 0 })
const nearWaited = guest({ id: 'secondary:near', lastSentMs: 980, distM: 8 })
const farStarved = guest({ id: 'secondary:far', lastSentMs: 0, distM: 18 })
const inflight = guest({ id: 'secondary:busy', inFlight: true, distM: 4 })

{
  const r = pickGuestsToSend([primary, pe, current, nearWaited, farStarved, inflight], {
    now,
    currentGuestId: 'secondary:cur',
    exclusiveSecondarySlot: true,
    allowMuteSecondary: false
  })
  assert('exclusive sends primary+pe+current only', r.sendIds.join(',') === 'primary,pe:1,secondary:cur')
  assert('exclusive muteSent 0', r.muteSent === 0)
  assert('exclusive counts inFlight', r.inFlight === 1)
}

{
  const r = pickGuestsToSend([primary, pe, current, nearWaited, farStarved, inflight], {
    now,
    currentGuestId: 'secondary:cur',
    exclusiveSecondarySlot: false,
    allowMuteSecondary: true
  })
  assert(
    'fair sends current plus one mute',
    r.sendIds.includes('primary') &&
      r.sendIds.includes('pe:1') &&
      r.sendIds.includes('secondary:cur') &&
      r.muteSent === 1
  )
  assert('fair mute is starved-far not near-recent', r.sendIds.includes('secondary:far') && !r.sendIds.includes('secondary:near'))
  assert('fair skips inFlight', !r.sendIds.includes('secondary:busy'))
}

{
  const r = pickGuestsToSend([primary, current, nearWaited], {
    now,
    currentGuestId: 'secondary:cur',
    exclusiveSecondarySlot: false,
    allowMuteSecondary: false
  })
  assert('overrun: current but no mute', r.sendIds.join(',') === 'primary,secondary:cur' && r.muteSent === 0)
}

{
  const r = pickGuestsToSend([primary, nearWaited, farStarved], {
    now,
    currentGuestId: 'primary',
    exclusiveSecondarySlot: false,
    allowMuteSecondary: true
  })
  assert('on primary: still one mute', r.muteSent === 1 && r.sendIds.includes('secondary:far'))
}

if (failed) {
  console.error(`\n${failed} failed`)
  process.exit(1)
}
console.log('\nok sceneloop send picker')
