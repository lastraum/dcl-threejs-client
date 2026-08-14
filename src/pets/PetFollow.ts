import * as THREE from 'three'
import { AVATAR_YAW_OFFSET } from '../avatar/constants'
import { PET_CATEGORY_CONFIG, resolvePetAnimState } from './petCategories'
import type { PetCategory, PetPose } from './types'

/** Walking: beside owner (right hip), not behind. */
const WALK_SIDE_M = 0.7
/** Walking: tiny back so they don't clip the body mesh. */
const WALK_BACK_M = 0.08
/** Flying: lateral offset to the right shoulder (visual facing). */
const FLY_SHOULDER_SIDE_M = 0.48
/** Flying: slight back from center so it sits on the shoulder, not in the face. */
const FLY_SHOULDER_BACK_M = 0.12
/** Walking: stay close beside you. */
const COMFORT_WALK_M = 0.22
/** Flying: stick tight to shoulder slot. */
const COMFORT_FLY_M = 0.18
const TELEPORT_M = 14
const WALK_SPEED = 2.4
const RUN_SPEED = 7.5
/**
 * Smoothing on the reported follow speed (1/s). Raw step/dt swings hard as the
 * pet closes on its slot, which would flap the gait band across its thresholds.
 */
const SPEED_SMOOTH_RATE = 8

const _ownerPos = new THREE.Vector3()
const _desired = new THREE.Vector3()
const _delta = new THREE.Vector3()
const _move = new THREE.Vector3()

export type PetFollowInput = {
  ownerFeet: THREE.Vector3
  /** Visual / network yaw in radians (Three space, same as PlayerSystem.playerYaw). */
  ownerYaw: number
  ownerHorizontalSpeed: number
  category: PetCategory
  /** Rendered XZ half-extent (m) — widens the side slot for big pets. */
  petHalfExtent?: number
  dt: number
  timeSec: number
  /** Force snap (goto / first spawn). */
  snap?: boolean
}

/**
 * Pets up to this half-extent keep the classic slot exactly; bigger ones get
 * pushed out so their EDGE keeps the classic clearance instead of their
 * center — an elephant (~1.2m half-extent) walks ~1.55m out rather than
 * overlapping the owner.
 */
const SMALL_PET_ALLOWANCE_M = 0.35

function sideSlotM(base: number, petHalfExtent: number | undefined): number {
  return base + Math.max(0, (petHalfExtent ?? 0) - SMALL_PET_ALLOWANCE_M)
}

/**
 * Local leash AI. Floor reference = owner CCT feet (no second PhysX capsule).
 *
 * - Walking: beside owner (right hip).
 * - Flying: owner XZ + right-shoulder offset, hover Y (bird on the shoulder).
 */
export class PetFollow {
  readonly position = new THREE.Vector3()
  yaw = 0
  horizontalSpeed = 0
  /** Last frame bob (m) — strip from networked Y so remotes bob smoothly locally. */
  lastBob = 0
  private initialized = false

  reset(): void {
    this.initialized = false
    this.horizontalSpeed = 0
    this.lastBob = 0
  }

  tick(input: PetFollowInput): PetPose {
    const cfg = PET_CATEGORY_CONFIG[input.category]
    const dt = Math.max(0, Math.min(0.1, input.dt))
    const flying = input.category === 'flying'
    const comfort = flying ? COMFORT_FLY_M : COMFORT_WALK_M

    _ownerPos.copy(input.ownerFeet)
    // Visual body faces +Z after avatar bind (playerYaw + AVATAR_YAW_OFFSET).
    const faceYaw = input.ownerYaw + AVATAR_YAW_OFFSET
    writeDesiredSlot(_desired, _ownerPos, faceYaw, flying, input.petHalfExtent)

    let bob = 0
    if (cfg.bobAmplitude > 0 && cfg.bobHz > 0) {
      bob = Math.sin(input.timeSec * cfg.bobHz * Math.PI * 2) * cfg.bobAmplitude
    }
    this.lastBob = bob
    const targetY = _ownerPos.y + cfg.yOffset + bob

    if (!this.initialized || input.snap) {
      this.position.set(_desired.x, targetY, _desired.z)
      this.yaw = input.ownerYaw
      this.horizontalSpeed = 0
      this.initialized = true
      return this.toPose(input.category, input.ownerHorizontalSpeed)
    }

    _delta.set(_desired.x - this.position.x, 0, _desired.z - this.position.z)
    const dist = Math.hypot(_delta.x, _delta.z)

    if (dist > TELEPORT_M) {
      this.position.set(_desired.x, targetY, _desired.z)
      this.yaw = input.ownerYaw
      this.horizontalSpeed = 0
      return this.toPose(input.category, input.ownerHorizontalSpeed)
    }

    // Both categories stick close to their side slot.
    let maxSpeed = 0
    if (dist > comfort) {
      maxSpeed = dist > comfort * 4 ? RUN_SPEED : flying ? WALK_SPEED * 1.35 : WALK_SPEED
    }

    if (maxSpeed > 0 && dist > 1e-4) {
      const step = Math.min(dist, maxSpeed * dt)
      _move.copy(_delta).multiplyScalar(step / dist)
      this.position.x += _move.x
      this.position.z += _move.z
      // Owner exclusion zone: catch-up steering aims at the slot point, and
      // the shortest path can pass straight through the player (a buck's head
      // in your chest). Push the pet radially out of the keep-clear circle.
      const clear = Math.max(0.5, (input.petHalfExtent ?? 0) + 0.35)
      const ex = this.position.x - _ownerPos.x
      const ez = this.position.z - _ownerPos.z
      const eDist = Math.hypot(ex, ez)
      if (eDist > 1e-4 && eDist < clear) {
        const push = clear / eDist
        this.position.x = _ownerPos.x + ex * push
        this.position.z = _ownerPos.z + ez * push
      }
      this.horizontalSpeed = damp(this.horizontalSpeed, step / Math.max(dt, 1e-4), SPEED_SMOOTH_RATE, dt)
      // Travel yaw in playerYaw space so Face 180° stays correct while moving.
      const travelYaw = Math.atan2(_move.x, _move.z)
      const moveYaw = travelYaw - AVATAR_YAW_OFFSET
      this.yaw = dampAngle(this.yaw, moveYaw, cfg.yawRate, dt)
    } else {
      // Idle / perched: match owner facing (bird looks where you look).
      this.horizontalSpeed = Math.max(0, this.horizontalSpeed - 12 * dt)
      this.yaw = dampAngle(this.yaw, input.ownerYaw, cfg.yawRate * 0.6, dt)
    }

    const yRate = flying ? 5 : 14
    this.position.y = damp(this.position.y, targetY, yRate, dt)

    return this.toPose(input.category, input.ownerHorizontalSpeed)
  }

  private toPose(category: PetCategory, ownerHorizontalSpeed = 0): PetPose {
    // When the pet is already in its side slot, follow speed decays to ~0 even
    // while the owner walks. Blend owner speed so gait (and remote pose.anim)
    // stay on walk/run instead of forever idleing beside a moving player.
    const speed = Math.max(this.horizontalSpeed, ownerHorizontalSpeed)
    return {
      x: this.position.x,
      y: this.position.y,
      z: this.position.z,
      yaw: this.yaw,
      horizontalSpeed: speed,
      anim: resolvePetAnimState(category, speed)
    }
  }
}

/** Desired XZ slot in Three space from owner feet + visual facing. */
function writeDesiredSlot(
  out: THREE.Vector3,
  ownerFeet: THREE.Vector3,
  faceYaw: number,
  flying: boolean,
  petHalfExtent?: number
): void {
  // Right relative to visual facing: (cos, -sin); behind: (-sin, -cos).
  const rightX = Math.cos(faceYaw)
  const rightZ = -Math.sin(faceYaw)
  const backX = -Math.sin(faceYaw)
  const backZ = -Math.cos(faceYaw)

  if (flying) {
    // Right shoulder perch (side-adjusted for big fliers — a shark is no parakeet).
    const side = sideSlotM(FLY_SHOULDER_SIDE_M, petHalfExtent)
    out.set(
      ownerFeet.x + rightX * side + backX * FLY_SHOULDER_BACK_M,
      0,
      ownerFeet.z + rightZ * side + backZ * FLY_SHOULDER_BACK_M
    )
    return
  }
  // Walking: right next to the player (side companion).
  const side = sideSlotM(WALK_SIDE_M, petHalfExtent)
  out.set(
    ownerFeet.x + rightX * side + backX * WALK_BACK_M,
    0,
    ownerFeet.z + rightZ * side + backZ * WALK_BACK_M
  )
}

function damp(current: number, target: number, rate: number, dt: number): number {
  const t = 1 - Math.exp(-rate * dt)
  return current + (target - current) * t
}

function dampAngle(current: number, target: number, rate: number, dt: number): number {
  let diff = target - current
  while (diff > Math.PI) diff -= Math.PI * 2
  while (diff < -Math.PI) diff += Math.PI * 2
  return current + diff * (1 - Math.exp(-rate * dt))
}
