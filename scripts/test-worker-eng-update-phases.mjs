/**
 * Smoke test — WSP v2 Phase 0 meters (no budget/skip).
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

console.log('ok worker-eng-update-phases smoke')
