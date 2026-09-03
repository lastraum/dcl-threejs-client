#!/usr/bin/env node
/**
 * Worlds forest layout: most-active pools sit closest to spawn.
 * Mirrors src/map/worldsForestLayout.ts — run: node scripts/test-worlds-forest-layout.mjs
 */
const LANDING = 10
const INNER = 24
const OCCUPIED = 62
const EMPTY = 48
const OUTER = 118
const MIN_GAP = 9.5
const MIN_LANDING_GAP = 10

function hashString(s) {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

function poolRadius(users) {
  return 3.2 + Math.log2(1 + Math.max(0, users)) * 0.52
}

function poolDistance(users, maxUsers, scatter = 0.5) {
  const u = Math.max(0, users)
  const s = Math.min(1, Math.max(0, scatter))
  if (u <= 0) return EMPTY + s * (OUTER - EMPTY)
  const max = Math.max(0, maxUsers)
  if (max <= 0) return INNER
  const t = 1 - Math.log2(1 + u) / Math.log2(1 + max)
  return INNER + t * (OCCUPIED - INNER)
}

function layout(entries) {
  const sorted = [...entries].sort((a, b) => {
    const byUsers = b.users - a.users
    if (byUsers !== 0) return byUsers
    return a.worldName.localeCompare(b.worldName, undefined, { sensitivity: 'base' })
  })
  const maxUsers = sorted.reduce((m, e) => Math.max(m, e.users), 0)
  const placed = []
  for (let rank = 0; rank < sorted.length; rank++) {
    const entry = sorted[rank]
    const h = hashString(entry.worldName.toLowerCase())
    const angle = ((h % 3600) / 3600) * Math.PI * 2
    const scatter = ((h >>> 11) % 1000) / 1000
    const poolR = poolRadius(entry.users)
    const padMin = LANDING + poolR + MIN_LANDING_GAP
    let x = Math.cos(angle) * Math.max(poolDistance(entry.users, maxUsers, scatter), padMin)
    let z = Math.sin(angle) * Math.max(poolDistance(entry.users, maxUsers, scatter), padMin)
    for (let guard = 0; guard < 36; guard++) {
      let pushed = false
      const dPad = Math.hypot(x, z)
      if (dPad < padMin) {
        const extra = padMin - Math.max(dPad, 1e-4) + 0.08
        x += Math.cos(angle) * extra
        z += Math.sin(angle) * extra
        pushed = true
      }
      for (const other of placed) {
        const dx = x - other.x
        const dz = z - other.z
        const min = other.radius + poolR + MIN_GAP
        const d = Math.hypot(dx, dz)
        if (d >= min) continue
        const extra = min - d + 0.08
        x += Math.cos(angle) * extra
        z += Math.sin(angle) * extra
        pushed = true
      }
      if (!pushed) break
    }
    placed.push({ ...entry, x, z, radius: poolR, rank, dist: Math.hypot(x, z) })
  }
  return placed
}

let failed = 0
function assert(label, cond) {
  if (cond) console.log(`  ok ${label}`)
  else {
    failed++
    console.error(` FAIL ${label}`)
  }
}

const worlds = [
  { worldName: 'quiet.dcl.eth', users: 0 },
  { worldName: 'party.dcl.eth', users: 42 },
  { worldName: 'mid.dcl.eth', users: 8 },
  { worldName: 'also-quiet.dcl.eth', users: 0 }
]
const posed = layout(worlds)
const byName = Object.fromEntries(posed.map((p) => [p.worldName, p]))

assert('party is rank 0', byName['party.dcl.eth'].rank === 0)
assert('mid is rank 1', byName['mid.dcl.eth'].rank === 1)
assert('party closer than mid', byName['party.dcl.eth'].dist < byName['mid.dcl.eth'].dist)
assert('mid closer than empty', byName['mid.dcl.eth'].dist < byName['quiet.dcl.eth'].dist)
assert('empty worlds outside inner ring', byName['quiet.dcl.eth'].dist >= EMPTY)
assert('busiest near inner ring', byName['party.dcl.eth'].dist < INNER + 8)
for (const p of posed) {
  const gap = p.dist - LANDING - p.radius
  assert(`${p.worldName} ≥ ${MIN_LANDING_GAP}m from landing`, gap >= MIN_LANDING_GAP - 0.02)
}

if (failed) {
  console.error(`\n${failed} failed`)
  process.exit(1)
}
console.log('worlds forest layout ok')
