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

function lerpRange(range: { start: number; end: number } | undefined, fallback: number): number {
  if (!range) return fallback
  return range.start + Math.random() * (range.end - range.start)
}

function sampleColorRange(
  range: { start?: { r?: number; g?: number; b?: number; a?: number }; end?: { r?: number; g?: number; b?: number; a?: number } } | undefined,
  out: THREE.Color,
  alphaOut: { value: number },
  fallback: THREE.Color
): void {
  const start = range?.start
  const end = range?.end ?? start
  const t = Math.random()
  const r = (start?.r ?? fallback.r) + t * ((end?.r ?? start?.r ?? fallback.r) - (start?.r ?? fallback.r))
  const g = (start?.g ?? fallback.g) + t * ((end?.g ?? start?.g ?? fallback.g) - (start?.g ?? fallback.g))
  const b = (start?.b ?? fallback.b) + t * ((end?.b ?? start?.b ?? fallback.b) - (start?.b ?? fallback.b))
  out.setRGB(r, g, b)
  const a0 = start?.a ?? 1
  const a1 = end?.a ?? a0
  alphaOut.value = a0 + t * (a1 - a0)
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

  const startSize = Math.max(0.001, lerpRange(spec.initialSize, 0.1))
  const endSize = Math.max(0.001, lerpRange(spec.sizeOverTime, startSize))

  const startColor = new THREE.Color()
  const endColor = new THREE.Color()
  const startAlpha = { value: 1 }
  const endAlpha = { value: 1 }
  sampleColorRange(spec.initialColor, startColor, startAlpha, _scratchColor)
  sampleColorRange(spec.colorOverTime, endColor, endAlpha, startColor)

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
    const gMul = spec.gravity ?? 1
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
  const gMul = spec.gravity ?? 1
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