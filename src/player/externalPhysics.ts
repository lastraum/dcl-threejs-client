/**
 * Explorer-parity external force/impulse helpers (Unity CharacterController path).
 * Continuous force Y uses effective gravity; XZ + impulse use ExternalVelocity.
 * @see docs/PHYSICS_PARITY_PLAN.md
 */

import * as THREE from 'three'
import { GLIDING_FORCE_MULTIPLIER } from './locomotion'

/** Unity CharacterControllerSettings.CharacterMass (default 1). */
export const CHARACTER_MASS = 1

/** Unity ExternalEnvDrag — always applied to external velocity. */
export const EXTERNAL_ENV_DRAG = 0.5

/** Unity ExternalGroundFriction — extra damping while grounded. */
export const EXTERNAL_GROUND_FRICTION = 4

/** Unity MaxExternalVelocity (m/s). */
export const MAX_EXTERNAL_VELOCITY = 50

/**
 * Continuous force → acceleration (m=1). Glide multiplies force only (not impulse).
 */
export function forceToAcceleration(
  forceWorld: THREE.Vector3,
  gliding: boolean,
  out: THREE.Vector3
): THREE.Vector3 {
  const mult = gliding ? GLIDING_FORCE_MULTIPLIER : 1
  return out.copy(forceWorld).multiplyScalar(mult / CHARACTER_MASS)
}

/**
 * Effective gravity magnitude for this frame (arcade GRAVITY base, Explorer-style).
 * `accelY` is continuous force a.y (after glide mult / mass).
 * Returns value to use as downward accel (positive = down).
 */
export function effectiveGravityDown(baseGravity: number, accelY: number): number {
  // Unity: effectiveGravity = |g| - ExternalAcceleration.y
  return baseGravity - accelY
}

/** True when continuous upward accel should break grounded contact. */
export function shouldUngroundFromForce(baseGravity: number, accelY: number): boolean {
  return accelY > 0 && effectiveGravityDown(baseGravity, accelY) <= 0
}

/**
 * Integrate continuous force XZ into external velocity (not Y — that is effective-g).
 */
export function integrateForceXZ(
  externalVelocity: THREE.Vector3,
  accel: THREE.Vector3,
  dt: number
): void {
  externalVelocity.x += accel.x * dt
  externalVelocity.z += accel.z * dt
}

/**
 * Impulse Δv = J/m into external channel. Caller ungrounds / cancels fall when J.y > 0.
 */
export function applyImpulse(
  externalVelocity: THREE.Vector3,
  impulseWorld: THREE.Vector3
): void {
  externalVelocity.x += impulseWorld.x / CHARACTER_MASS
  externalVelocity.y += impulseWorld.y / CHARACTER_MASS
  externalVelocity.z += impulseWorld.z / CHARACTER_MASS
}

/**
 * Unity ExternalVelocity drag + clamp. Grounded zeros external Y.
 */
export function dampAndClampExternal(
  externalVelocity: THREE.Vector3,
  grounded: boolean,
  dt: number
): void {
  const damp = EXTERNAL_ENV_DRAG + (grounded ? EXTERNAL_GROUND_FRICTION : 0)
  const scale = Math.max(0, 1 - damp * dt)
  externalVelocity.multiplyScalar(scale)
  if (grounded) externalVelocity.y = 0
  const mag = externalVelocity.length()
  if (mag > MAX_EXTERNAL_VELOCITY && mag > 1e-8) {
    externalVelocity.multiplyScalar(MAX_EXTERNAL_VELOCITY / mag)
  }
}
