import * as THREE from 'three'
import type { PBParticleSystem } from '@dcl/ecs/dist/components/generated/pb/decentraland/sdk/components/particle_system.gen'

export type ParticleSpec = Readonly<PBParticleSystem>

export type LiveParticle = {
  position: THREE.Vector3
  velocity: THREE.Vector3
  age: number
  lifetime: number
  /**
   * World diameter at t=0 / t=1 after baking Explorer startSize × sizeOverLifetime multipliers.
   * PlaneGeometry(1,1) × size → diameter in meters (matches Unity startSize).
   */
  startSize: number
  endSize: number
  /** Baked startColor × colorOverLifetime gradient endpoints. */
  startColor: THREE.Color
  endColor: THREE.Color
  startAlpha: number
  endAlpha: number
  /** Integrated euler rotation (radians). */
  rotation: THREE.Euler
  /** Per-second euler spin (radians/s). */
  angularVelocity: THREE.Vector3
}

export type BurstRuntime = {
  time: number
  count: number
  cycles: number
  interval: number
  probability: number
  firedCycles: number
  nextFireTime: number
}

export type ParticleBuffers = {
  positions: Float32Array
  colors: Float32Array
  sizes: Float32Array
  /** Euler XYZ rotation per particle (radians). */
  rotations: Float32Array
  frames: Float32Array
  velocities: Float32Array
  capacity: number
}