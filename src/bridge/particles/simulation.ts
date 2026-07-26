import * as THREE from 'three'
import { DCL_SCENE_GRAVITY } from './constants'
import type { BurstRuntime, LiveParticle, ParticleSpec } from './types'

const _scratchColor = new THREE.Color(1, 1, 1)
const _scratchQuat = new THREE.Quaternion()
const _scratchEuler = new THREE.Euler(0, 0, 0, 'XYZ')
const _emitPos = new THREE.Vector3()
const _emitVel = new THREE.Vector3()
const _dir = new THREE.Vector3()
const _gravity = new THREE.Vector3()
const _force = new THREE.Vector3()

export function specSignature(spec: ParticleSpec): string {
  return JSON.stringify({
    active: spec.active,
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
    bursts: spec.bursts,
    playbackState: spec.playbackState
  })
}

export function createBurstRuntimes(spec: ParticleSpec, loop: boolean): BurstRuntime[] {
  const values = spec.bursts?.values ?? []
  return values.map((b) => {
    let cycles = b.cycles ?? 1
    if (!loop && cycles === 0) cycles = 1
    return {
      time: b.time,
      count: b.count,
      cycles,
      interval: b.interval ?? 0.01,
      probability: b.probability ?? 1,
      firedCycles: 0,
      nextFireTime: b.time
    }
  })
}

export function resetBurstRuntimes(bursts: BurstRuntime[], spec: ParticleSpec, loop: boolean): void {
  const values = spec.bursts?.values ?? []
  for (let i = 0; i < bursts.length; i++) {
    const src = values[i]
    const b = bursts[i]!
    b.time = src?.time ?? b.time
    b.count = src?.count ?? b.count
    let cycles = src?.cycles ?? 1
    if (!loop && cycles === 0) cycles = 1
    b.cycles = cycles
    b.interval = src?.interval ?? 0.01
    b.probability = src?.probability ?? 1
    b.firedCycles = 0
    b.nextFireTime = b.time
  }
}

export function cycleDuration(spec: ParticleSpec, bursts: BurstRuntime[]): number {
  const lifetime = Math.max(0.05, spec.lifetime ?? 5)
  let maxT = lifetime
  for (const b of bursts) {
    const span = b.time + Math.max(0, b.cycles - 1) * b.interval + b.interval
    if (span > maxT) maxT = span
  }
  return Math.max(lifetime, maxT)
}

/**
 * Random sample between FloatRange start/end (Explorer MinMaxCurve for startSize / startSpeed).
 * Missing range → constant `fallback` (initialSize default 1, velocity default 1).
 */
function lerpRange(range: { start?: number; end?: number } | undefined, fallback: number): number {
  if (!range) return fallback
  const a = range.start ?? range.end ?? fallback
  const b = range.end ?? range.start ?? fallback
  return a + Math.random() * (b - a)
}

type Color4 = { r?: number; g?: number; b?: number; a?: number }

/** Birth color: random between ColorRange start/end (Explorer MinMaxGradient). */
function sampleBirthColor(
  range: { start?: Color4; end?: Color4 } | undefined,
  out: THREE.Color,
  alphaOut: { value: number },
  fallback: THREE.Color
): void {
  const start = range?.start
  const end = range?.end ?? start
  const t = Math.random()
  const r0 = start?.r ?? fallback.r
  const g0 = start?.g ?? fallback.g
  const b0 = start?.b ?? fallback.b
  const a0 = start?.a ?? 1
  const r1 = end?.r ?? start?.r ?? fallback.r
  const g1 = end?.g ?? start?.g ?? fallback.g
  const b1 = end?.b ?? start?.b ?? fallback.b
  const a1 = end?.a ?? a0
  out.setRGB(r0 + t * (r1 - r0), g0 + t * (g1 - g0), b0 + t * (b1 - b0))
  alphaOut.value = a0 + t * (a1 - a0)
}

/**
 * Explorer colorOverLifetime: final = startColor * gradient(t).
 * Bakes absolute t=0 / t=1 colors so the GPU path keeps a simple lerp.
 */
function applyColorOverLifetime(
  startColor: THREE.Color,
  startAlphaOut: { value: number },
  cot: { start?: Color4; end?: Color4 } | undefined,
  endColor: THREE.Color,
  endAlphaOut: { value: number }
): void {
  if (!cot) {
    endColor.copy(startColor)
    endAlphaOut.value = startAlphaOut.value
    return
  }
  const c0 = cot.start
  const c1 = cot.end ?? cot.start
  const r0 = c0?.r ?? 1
  const g0 = c0?.g ?? 1
  const b0 = c0?.b ?? 1
  const a0 = c0?.a ?? 1
  const r1 = c1?.r ?? r0
  const g1 = c1?.g ?? g0
  const b1 = c1?.b ?? b0
  const a1 = c1?.a ?? a0
  const birthA = startAlphaOut.value
  endColor.setRGB(startColor.r * r1, startColor.g * g1, startColor.b * b1)
  endAlphaOut.value = birthA * a1
  startColor.setRGB(startColor.r * r0, startColor.g * g0, startColor.b * b0)
  startAlphaOut.value = birthA * a0
}

/**
 * Explorer sizeOverLifetime is a **multiplier** curve on startSize (not an absolute size).
 * When SizeOverTime is null the module is disabled → multiplier stays 1.
 * @see ParticleSystemApplyPropertiesSystem.ApplySizeOverLifetime (unity-explorer)
 */
function sizeEndsFromSpec(
  birthSize: number,
  sizeOverTime: { start?: number; end?: number } | undefined
): { startSize: number; endSize: number } {
  if (!sizeOverTime) {
    return { startSize: birthSize, endSize: birthSize }
  }
  const mul0 = sizeOverTime.start ?? 1
  const mul1 = sizeOverTime.end ?? mul0
  return {
    startSize: Math.max(0.001, birthSize * mul0),
    endSize: Math.max(0.001, birthSize * mul1)
  }
}

/** Explorer: gravity omitted → 0 (not 1). */
function gravityMultiplier(spec: ParticleSpec): number {
  return spec.gravity ?? 0
}

function quatToEulerRates(q?: { x?: number; y?: number; z?: number; w?: number }): THREE.Vector3 {
  if (!q) return new THREE.Vector3(0, 0, 0)
  _scratchQuat.set(q.x ?? 0, q.y ?? 0, q.z ?? 0, q.w ?? 1).normalize()
  _scratchEuler.setFromQuaternion(_scratchQuat, 'XYZ')
  return new THREE.Vector3(
    THREE.MathUtils.degToRad(_scratchEuler.x),
    THREE.MathUtils.degToRad(_scratchEuler.y),
    THREE.MathUtils.degToRad(_scratchEuler.z)
  )
}

function quatToEuler(q?: { x?: number; y?: number; z?: number; w?: number }): THREE.Euler {
  if (!q) return new THREE.Euler(0, 0, 0, 'XYZ')
  _scratchQuat.set(q.x ?? 0, q.y ?? 0, q.z ?? 0, q.w ?? 1).normalize()
  return new THREE.Euler().setFromQuaternion(_scratchQuat, 'XYZ')
}

export function sampleShapePosition(shape: ParticleSpec['shape']): THREE.Vector3 {
  const pos = new THREE.Vector3()
  if (!shape || shape.$case === 'point') return pos

  if (shape.$case === 'sphere') {
    const radius = shape.sphere.radius ?? 1
    const u = Math.random()
    const v = Math.random()
    const theta = 2 * Math.PI * u
    const phi = Math.acos(2 * v - 1)
    const onSurface = Math.random() < 0.5
    const r = onSurface ? radius : radius * Math.cbrt(Math.random())
    pos.set(r * Math.sin(phi) * Math.cos(theta), r * Math.cos(phi), r * Math.sin(phi) * Math.sin(theta))
    return pos
  }

  if (shape.$case === 'box') {
    const size = shape.box.size ?? { x: 1, y: 1, z: 1 }
    pos.set(
      (Math.random() - 0.5) * (size.x ?? 1),
      (Math.random() - 0.5) * (size.y ?? 1),
      (Math.random() - 0.5) * (size.z ?? 1)
    )
    return pos
  }

  if (shape.$case === 'cone') {
    const radius = shape.cone.radius ?? 1
    const r = Math.sqrt(Math.random()) * radius
    const theta = Math.random() * 2 * Math.PI
    pos.set(r * Math.cos(theta), 0, r * Math.sin(theta))
    return pos
  }

  return pos
}

export function sampleShapeDirection(shape: ParticleSpec['shape']): THREE.Vector3 {
  if (shape?.$case === 'cone') {
    const angleDeg = shape.cone.angle ?? 25
    const angleRad = THREE.MathUtils.degToRad(angleDeg)
    const theta = Math.random() * 2 * Math.PI
    const cosA = Math.cos(angleRad * Math.random())
    const sinA = Math.sqrt(Math.max(0, 1 - cosA * cosA))
    return new THREE.Vector3(sinA * Math.cos(theta), cosA, sinA * Math.sin(theta)).normalize()
  }
  _dir.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5)
  if (_dir.lengthSq() < 1e-6) _dir.set(0, 1, 0)
  return _dir.normalize()
}

export type SpawnContext = {
  worldSpace: boolean
  parent: THREE.Object3D
}

function maxParticles(spec: ParticleSpec): number {
  return Math.max(1, Math.floor(spec.maxParticles ?? 1000))
}

function buildParticle(spec: ParticleSpec, ctx: SpawnContext, lifetime: number, age: number): LiveParticle {
  const localEmit = sampleShapePosition(spec.shape)
  const speed = Math.max(0, lerpRange(spec.initialVelocitySpeed, 1))
  const dir = sampleShapeDirection(spec.shape)

  // Explorer: startSize default 1; sizeOverLifetime multiplies startSize (null → ×1).
  const birthSize = Math.max(0.001, lerpRange(spec.initialSize, 1))
  const { startSize, endSize } = sizeEndsFromSpec(birthSize, spec.sizeOverTime)

  const startColor = new THREE.Color()
  const endColor = new THREE.Color()
  const startAlpha = { value: 1 }
  const endAlpha = { value: 1 }
  sampleBirthColor(spec.initialColor, startColor, startAlpha, _scratchColor)
  // Mutates startColor/startAlpha when colorOverTime is set (Unity multiplies gradient).
  applyColorOverLifetime(startColor, startAlpha, spec.colorOverTime, endColor, endAlpha)

  if (ctx.worldSpace) {
    ctx.parent.updateWorldMatrix(true, false)
    _emitPos.copy(localEmit).applyMatrix4(ctx.parent.matrixWorld)
    _emitVel.copy(dir).multiplyScalar(speed).transformDirection(ctx.parent.matrixWorld)
  } else {
    _emitPos.copy(localEmit)
    _emitVel.copy(dir).multiplyScalar(speed)
  }

  const angularVelocity = quatToEulerRates(spec.rotationOverTime)
  const rotation = quatToEuler(spec.initialRotation)
  if (age > 0) {
    rotation.x += angularVelocity.x * age
    rotation.y += angularVelocity.y * age
    rotation.z += angularVelocity.z * age
    _emitPos.addScaledVector(_emitVel, age)
    const gMul = gravityMultiplier(spec)
    _gravity.set(0, gMul * DCL_SCENE_GRAVITY * age, 0)
    const force = spec.additionalForce ?? { x: 0, y: 0, z: 0 }
    _force.set(force.x ?? 0, force.y ?? 0, force.z ?? 0)
    _emitVel.add(_gravity).addScaledVector(_force, age)
  }

  return {
    position: _emitPos.clone(),
    velocity: _emitVel.clone(),
    age,
    lifetime,
    startSize,
    endSize,
    startColor: startColor.clone(),
    endColor: endColor.clone(),
    startAlpha: startAlpha.value,
    endAlpha: endAlpha.value,
    rotation: rotation.clone(),
    angularVelocity: angularVelocity.clone()
  }
}

export function spawnParticle(live: LiveParticle[], spec: ParticleSpec, ctx: SpawnContext, lifetime: number, age = 0): boolean {
  if (live.length >= maxParticles(spec)) return false
  live.push(buildParticle(spec, ctx, lifetime, age))
  return true
}

export function processBursts(
  live: LiveParticle[],
  spec: ParticleSpec,
  bursts: BurstRuntime[],
  elapsed: number,
  prevElapsed: number,
  ctx: SpawnContext,
  lifetime: number
): void {
  for (const burst of bursts) {
    const infinite = burst.cycles === 0
    if (!infinite && burst.firedCycles >= burst.cycles) continue

    while (burst.nextFireTime <= elapsed) {
      if (!infinite && burst.firedCycles >= burst.cycles) break
      if (burst.nextFireTime >= prevElapsed && Math.random() <= burst.probability) {
        for (let i = 0; i < burst.count; i++) {
          if (!spawnParticle(live, spec, ctx, lifetime)) break
        }
      }
      burst.firedCycles++
      if (!infinite && burst.firedCycles >= burst.cycles) break
      burst.nextFireTime += Math.max(0.001, burst.interval)
    }
  }
}

export function prewarmParticles(live: LiveParticle[], spec: ParticleSpec, ctx: SpawnContext): void {
  const rate = Math.max(0, spec.rate ?? 10)
  const lifetime = Math.max(0.05, spec.lifetime ?? 5)
  const fill = Math.min(maxParticles(spec), Math.max(1, Math.floor(rate * lifetime)))
  for (let i = 0; i < fill; i++) {
    const age = Math.random() * lifetime
    spawnParticle(live, spec, ctx, lifetime, age)
  }
}

export function emitContinuous(
  live: LiveParticle[],
  spec: ParticleSpec,
  ctx: SpawnContext,
  delta: number,
  emitCarry: number,
  rateScale: number
): number {
  const lifetime = Math.max(0.05, spec.lifetime ?? 5)
  const rate = Math.max(0, (spec.rate ?? 10) * rateScale)
  let carry = emitCarry + rate * delta
  while (carry >= 1 && live.length < maxParticles(spec)) {
    carry -= 1
    spawnParticle(live, spec, ctx, lifetime)
  }
  return carry
}

export function simulateParticles(live: LiveParticle[], spec: ParticleSpec, delta: number): void {
  const gMul = gravityMultiplier(spec)
  _gravity.set(0, gMul * DCL_SCENE_GRAVITY, 0)
  const force = spec.additionalForce ?? { x: 0, y: 0, z: 0 }
  _force.set(force.x ?? 0, force.y ?? 0, force.z ?? 0)

  const limit = spec.limitVelocity
  const maxSpeed = limit?.speed
  const dampen = limit?.dampen ?? 1

  for (let i = live.length - 1; i >= 0; i--) {
    const p = live[i]!
    p.age += delta
    if (p.age >= p.lifetime) {
      live[i] = live[live.length - 1]!
      live.pop()
      continue
    }

    p.velocity.addScaledVector(_gravity, delta)
    p.velocity.addScaledVector(_force, delta)
    if (maxSpeed !== undefined && maxSpeed >= 0) {
      const speed = p.velocity.length()
      if (speed > maxSpeed) {
        const excess = speed - maxSpeed
        p.velocity.addScaledVector(p.velocity, (-excess * dampen) / Math.max(speed, 1e-6))
      }
    }
    p.position.addScaledVector(p.velocity, delta)
    if (!spec.faceTravelDirection) {
      p.rotation.x += p.angularVelocity.x * delta
      p.rotation.y += p.angularVelocity.y * delta
      p.rotation.z += p.angularVelocity.z * delta
    }
  }
}