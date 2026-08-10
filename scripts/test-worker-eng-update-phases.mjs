/**
 * Smoke test — WSP v2 Phase 0 / 0.5 meters (no budget/skip).
 * Run: node scripts/test-worker-eng-update-phases.mjs
 */
import assert from 'node:assert/strict'

// Minimal reimplementation of gate math for CI without TS bundle.
function simulatePhase({ pre, systems, react, post }) {
  const total = pre + systems + react + post
  return { total, pre, systems, react, post }
}

const a = simulatePhase({ pre: 10, systems: 100, react: 50, post: 20 })
assert.equal(a.total, 180)
assert.ok(a.systems + a.react + a.pre + a.post === a.total)

// EMA-style top systems keep last winner
const ema = new Map()
function record(name, ms) {
  const prev = ema.get(name) ?? 0
  ema.set(name, prev * 0.65 + ms * 0.35)
}
record('A', 100)
record('B', 10)
record('A', 100)
const top = [...ema.entries()].sort((x, y) => y[1] - x[1])
assert.equal(top[0][0], 'A')

// Phase 0.5 — encode vs transport split
function splitSend({ systemsLoopEnd, firstCrdtAt, lastCrdtAt, end, crdtMs }) {
  const sendMs = end - systemsLoopEnd
  if (firstCrdtAt <= 0) {
    return { sendMs, encodeMs: sendMs, transportMs: 0, tailMs: 0 }
  }
  return {
    sendMs,
    encodeMs: Math.max(0, firstCrdtAt - systemsLoopEnd),
    transportMs: crdtMs,
    tailMs: Math.max(0, end - lastCrdtAt)
  }
}

const slow = splitSend({
  systemsLoopEnd: 100,
  firstCrdtAt: 211,
  lastCrdtAt: 211.5,
  end: 212,
  crdtMs: 0.4
})
assert.ok(slow.encodeMs >= 110 && slow.encodeMs <= 112)
assert.ok(slow.transportMs < 1)
assert.ok(slow.tailMs < 2)
// Genesis-like: encode dominates send
assert.ok(slow.encodeMs / slow.sendMs > 0.9)

// Path histogram format
function formatPaths(paths) {
  return [...paths.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${k}:${n}`)
    .join('|')
}
const paths = new Map([
  ['cold', 3],
  ['empty-coal', 1]
])
assert.equal(formatPaths(paths), 'cold:3|empty-coal:1')

console.log('ok worker-eng-update-phases smoke (0 + 0.5)')
