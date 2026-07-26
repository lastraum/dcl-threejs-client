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
 * Continuous force only: scale so F balances arcade jump g the way Explorer’s F balances g≈9.8.
 */
export const EXTERNAL_SCENE_SCALE = CLIENT_ARCADE_GRAVITY / EXPLORER_GRAVITY_MAG

/**
 * Platform-wide impulse Δv scale (all scenes — not per-scene).
 *
 * Explorer: `Δv = J / CharacterMass` with mass=1 ({@link ApplyExternalImpulse}).
 * Our client keeps arcade jump `g=20` + PhysX CCT + external channel integration, which
 * launches ~2–2.5× hotter than Unity CharacterController (g≈9.8) for the same scene J.
 * Single constant keeps every pad/knockback consistent with DCL client feel.
 *
 * Continuous force stays on {@link EXTERNAL_SCENE_SCALE} (force fights gravity every frame).
 */
export const IMPULSE_CLIENT_SCALE = EXPLORER_GRAVITY_MAG / CLIENT_ARCADE_GRAVITY

/** @deprecated Use {@link IMPULSE_CLIENT_SCALE} — same value, platform-wide. */
export const IMPULSE_SCENE_SCALE = IMPULSE_CLIENT_SCALE

/** Unity ExternalEnvDrag — always applied to external velocity. */
export const EXTERNAL_ENV_DRAG = 0.5

/** Unity ExternalGroundFriction — extra damping while grounded. */
export const EXTERNAL_GROUND_FRICTION = 4

/** Unity MaxExternalVelocity (m/s). */
export const MAX_EXTERNAL_VELOCITY = 50

/**
 * Brief window after a pad/knockback where CCT may still report grounded under the
 * trampoline mesh — suppress re-stick so the launch can leave the surface (Explorer
 * ungrounds on J.y > 0). After this, grounded always clears external Y like Unity.
 */
export const IMPULSE_LAUNCH_GRACE_SEC = 0.18

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
 * Impulse world vector → Δv (mass=1 × platform client scale).
 */
export function scaleImpulseForClient(impulseWorld: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
  return out.copy(impulseWorld).multiplyScalar(IMPULSE_CLIENT_SCALE / CHARACTER_MASS)
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
