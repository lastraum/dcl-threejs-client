#!/usr/bin/env node
/**
 * Particle scene-budget law (Snow Drift snowfall asks maxParticles=6000).
 * Run: npm run test:particles
 */

const SCENE_PARTICLE_BUDGET = 1000

function particleLiveCap(specMax, budget = SCENE_PARTICLE_BUDGET) {
  const requested = Math.max(1, Math.floor(specMax ?? 1000))
  return Math.min(requested, budget)
}

function trimLiveToBudget(lengths, budget) {
  const next = lengths.slice()
  let total = 0
  for (const n of next) total += n
  if (total <= budget) return next
  const order = next.map((_, i) => i).sort((a, b) => next[b] - next[a])
  let overflow = total - budget
  for (const i of order) {
    if (overflow <= 0) break
    const cut = Math.min(next[i], overflow)
    next[i] -= cut
    overflow -= cut
  }
  return next
}

function specSignature(spec) {
  return JSON.stringify({
    rate: spec.rate,
    maxParticles: spec.maxParticles,
    lifetime: spec.lifetime,
    gravity: spec.gravity,
    additionalForce: spec.additionalForce,
    initialSize: spec.initialSize,
    sizeOverTime: spec.sizeOverTime,
    initialColor: spec.initialColor,
    colorOverTime: spec.colorOverTime,
    initialVelocitySpeed: spec.initialVelocitySpeed,
    initialRotation: spec.initialRotation,
    rotationOverTime: spec.rotationOverTime,
    faceTravelDirection: spec.faceTravelDirection,
    texture: spec.texture,
    blendMode: spec.blendMode,
    billboard: spec.billboard,
    spriteSheet: spec.spriteSheet,
    shape: spec.shape,
    loop: spec.loop,
    prewarm: spec.prewarm,
    simulationSpace: spec.simulationSpace,
    limitVelocity: spec.limitVelocity,
    bursts: spec.bursts
  })
}

function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`)
    process.exit(1)
  }
}

assert(particleLiveCap(6000) === 1000, 'snowfall 6000 request caps at scene budget')
assert(particleLiveCap(160) === 160, 'torch 160 stays 160')
assert(particleLiveCap(undefined) === 1000, 'default max is budget')

const trimmed = trimLiveToBudget([1000, 160, 120], 1000)
assert(trimmed[0] === 720, `snowfall trimmed first, got ${trimmed[0]}`)
assert(trimmed[1] === 160, 'torch kept')
assert(trimmed[2] === 120, 'campfire kept')
assert(trimmed.reduce((a, b) => a + b, 0) === 1000, 'total equals budget')

const under = trimLiveToBudget([10, 20], 1000)
assert(under[0] === 10 && under[1] === 20, 'under budget is a no-op')

const playing = specSignature({ rate: 40, maxParticles: 160, playbackState: 0, active: true, loop: true })
const stopped = specSignature({ rate: 40, maxParticles: 160, playbackState: 2, active: true, loop: true })
assert(playing === stopped, 'playbackState must not rebuild GPU runtime (torch on/off)')

const activeOff = specSignature({ rate: 40, maxParticles: 160, playbackState: 0, active: false, loop: true })
assert(playing === activeOff, 'active flag must not rebuild GPU runtime')

const rateChange = specSignature({ rate: 280, maxParticles: 160, loop: true })
assert(playing !== rateChange, 'rate change still rebuilds')

console.log('ok — particle budget + spec signature')
