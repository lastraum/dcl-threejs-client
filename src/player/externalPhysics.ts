/**
 * Explorer-parity external force/impulse helpers (Unity CharacterController path).
 * Continuous force Y uses effective gravity; XZ + impulse use ExternalVelocity.
 * @see docs/PHYSICS_PARITY_PLAN.md
 */

import * as THREE from 'three'
import { GLIDING_FORCE_MULTIPLIER } from './locomotion'

/** Unity CharacterControllerSettings.CharacterMass (default 1). */
export const CHARACTER_MASS = 1

/** Unity gravity magnitude used when scenes author force/impulse (m/s²). */
export const EXPLORER_GRAVITY_MAG = 9.8

/**
 * Client arcade jump gravity (PlayerSystem GRAVITY). Kept for jump height curves.
 * Continuous force Y uses this as |g| in effective-g so pads match jump feel.
 */
export const CLIENT_ARCADE_GRAVITY = 20

/**
 * Scale scene-authored F/J so Explorer magnitudes feel similar under arcade g.
 * Option A: keep jump g=20, scale external F/J by g_client / g_explorer.
 */
export const EXTERNAL_SCENE_SCALE = CLIENT_ARCADE_GRAVITY / EXPLORER_GRAVITY_MAG

/** Unity ExternalEnvDrag — always applied to external velocity. */
export const EXTERNAL_ENV_DRAG = 0.5

/** Unity ExternalGroundFriction — extra damping while grounded. */
export const EXTERNAL_GROUND_FRICTION = 4

/** Unity MaxExternalVelocity (m/s). */
export const MAX_EXTERNAL_VELOCITY = 50

/**
 * Continuous force → acceleration (m=1).
 * Applies EXTERNAL_SCENE_SCALE then glide mult (force only).
 */
export function forceToAcceleration(
  forceWorld: THREE.Vector3,
  gliding: boolean,
  out: THREE.Vector3
): THREE.Vector3 {
  const mult = (gliding ? GLIDING_FORCE_MULTIPLIER : 1) * EXTERNAL_SCENE_SCALE
  return out.copy(forceWorld).multiplyScalar(mult / CHARACTER_MASS)
}

/**
 * Impulse world vector → Δv contribution (includes scene scale for g parity).
 */
export function scaleImpulseForClient(impulseWorld: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
  return out.copy(impulseWorld).multiplyScalar(EXTERNAL_SCENE_SCALE / CHARACTER_MASS)
}

/**
 * Effective gravity magnitude for this frame (arcade GRAVITY base, Explorer-style).
 * `accelY` is continuous force a.y (after glide mult / mass / scene scale).
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
 * Apply scaled impulse Δv into external channel.
 * Caller ungrounds / cancels fall when impulse Y > 0 (pre-scale world Y).
 */
export function applyImpulse(
  externalVelocity: THREE.Vector3,
  impulseWorld: THREE.Vector3
): void {
  scaleImpulseForClient(impulseWorld, impulseWorld)
  externalVelocity.x += impulseWorld.x
  externalVelocity.y += impulseWorld.y
  externalVelocity.z += impulseWorld.z
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
