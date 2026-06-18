import * as THREE from 'three'
import { normalizeDaySeconds, normalizedTimeOfDay, SECONDS_PER_DAY, SUNRISE, SUNSET } from './skyboxTime'
import { SUN_CYCLE_CLIP_LENGTH, SUN_CYCLE_LIGHT_INTENSITY, SUN_CYCLE_QUATERNIONS } from './sunCycle24h'

const _dir = new THREE.Vector3()
const _sun = new THREE.Vector3()
const _moon = new THREE.Vector3()

type Quat = readonly [number, number, number, number, number]

function sampleCurve(keys: ReadonlyArray<readonly [number, number]>, animTime: number): number {
  if (!keys.length) return 1
  if (animTime <= keys[0]![0]) return keys[0]![1]
  if (animTime >= keys[keys.length - 1]![0]) return keys[keys.length - 1]![1]
  for (let i = 0; i < keys.length - 1; i++) {
    const a = keys[i]!
    const b = keys[i + 1]!
    if (animTime <= b[0]) {
      const f = (animTime - a[0]) / (b[0] - a[0])
      return a[1] + (b[1] - a[1]) * f
    }
  }
  return keys[keys.length - 1]![1]
}

function slerpQuat(a: Quat, b: Quat, t: number): [number, number, number, number] {
  let ax = a[1], ay = a[2], az = a[3], aw = a[4]
  let bx = b[1], by = b[2], bz = b[3], bw = b[4]
  let dot = ax * bx + ay * by + az * bz + aw * bw
  if (dot < 0) {
    bx = -bx; by = -by; bz = -bz; bw = -bw
    dot = -dot
  }
  if (dot > 0.9995) {
    const x = ax + t * (bx - ax)
    const y = ay + t * (by - ay)
    const z = az + t * (bz - az)
    const w = aw + t * (bw - aw)
    const len = Math.hypot(x, y, z, w) || 1
    return [x / len, y / len, z / len, w / len]
  }
  const theta0 = Math.acos(dot)
  const sin0 = Math.sin(theta0)
  const theta = theta0 * t
  const s0 = Math.sin(theta0 - theta) / sin0
  const s1 = Math.sin(theta) / sin0
  return [s0 * ax + s1 * bx, s0 * ay + s1 * by, s0 * az + s1 * bz, s0 * aw + s1 * bw]
}

/** Sample SunCycle24h.anim at normalized day time (0–1). Returns quaternion xyzw. */
export function sampleSunCycleQuaternion(normalizedT: number): [number, number, number, number] {
  const animTime = (normalizedT % 1) * SUN_CYCLE_CLIP_LENGTH
  const keys = SUN_CYCLE_QUATERNIONS
  if (animTime <= keys[0]![0]) return [keys[0]![1], keys[0]![2], keys[0]![3], keys[0]![4]]
  for (let i = 0; i < keys.length - 1; i++) {
    const a = keys[i]!
    const b = keys[i + 1]!
    if (animTime <= b[0]) {
      const f = (animTime - a[0]) / (b[0] - a[0])
      return slerpQuat(a, b, f)
    }
  }
  const last = keys[keys.length - 1]!
  return [last[1], last[2], last[3], last[4]]
}

/** Unity directional light forward: rotate local (0,0,-1) by quaternion, then convert to Three.js (+Z flip). */
export function unityQuatToThreeDirection(q: [number, number, number, number], out = _dir): THREE.Vector3 {
  const [x, y, z, w] = q
  const vx = 0, vy = 0, vz = -1
  const ix = w * vx + y * vz - z * vy
  const iy = w * vy + z * vx - x * vz
  const iz = w * vz + x * vy - y * vx
  const iw = -x * vx - y * vy - z * vz
  const ox = iw * -x + ix * w + iy * -z - iz * -y
  const oy = iw * -y + iy * w + iz * -x - ix * -z
  const oz = iw * -z + iz * w + ix * -y - iy * -x
  return out.set(ox, oy, -oz).normalize()
}

/** Celestial body direction in sky (where sun/moon disc is drawn). */
export function celestialDirection(seconds: number, out = _dir): THREE.Vector3 {
  return unityQuatToThreeDirection(sampleSunCycleQuaternion(normalizedTimeOfDay(seconds)), out)
}

/** Sun visible when animation quaternion w > 0 (day arc of SunCycle24h). */
export function isSunPeriod(seconds: number): boolean {
  const t = normalizedTimeOfDay(seconds)
  // Clip loops at t≈0: quaternion reads as sunrise though wall-clock is midnight.
  if (t < 0.04 || t > 0.96) return false
  return sampleSunCycleQuaternion(t)[3] > 0
}

export function sunDirection(seconds: number, out = _sun): THREE.Vector3 {
  return celestialDirection(seconds, out)
}

export function moonDirection(seconds: number, out = _moon): THREE.Vector3 {
  return celestialDirection(seconds, out)
}

/** Light intensity from SunCycle24h.anim m_Intensity curve — sun arc only (drops to 0 before moon half). */
export function animatedLightIntensity(seconds: number): number {
  if (!isSunPeriod(seconds)) return 0
  const animTime = normalizedTimeOfDay(seconds) * SUN_CYCLE_CLIP_LENGTH
  const raw = sampleCurve(SUN_CYCLE_LIGHT_INTENSITY, animTime)
  // Unity SunCycle24h peaks ~2.72 — prior 1.45 cap under-lit scenes vs Explorer.
  return THREE.MathUtils.clamp(raw * 1.15, 0.05, 3.2)
}

/**
 * Moon directional fill — Unity uses `directionalLightLayer.intensity` (Generic_Skybox ~0.2 at dusk,
 * ~0.5 at midnight), NOT the sun anim intensity curve (which hits 0 for the moon quaternion half).
 */
export function moonLightIntensity(seconds: number): number {
  if (isSunPeriod(seconds)) return 0
  const t = normalizedTimeOfDay(seconds)
  const hours = t * 24

  // Generic_Skybox Moon satellite visible ~21:00–02:00; keep fill through twilight shoulders.
  if (hours >= 21 || hours <= 2) {
    const distFromMidnight = hours >= 12 ? 24 - hours : hours
    if (distFromMidnight <= 5) {
      return THREE.MathUtils.lerp(0.58, 0.36, distFromMidnight / 5)
    }
    return THREE.MathUtils.lerp(0.36, 0.26, (distFromMidnight - 5) / 2)
  }

  if (hours < SUNRISE / 3600) {
    return THREE.MathUtils.lerp(0.26, 0.38, hours / (SUNRISE / 3600))
  }
  if (hours > SUNSET / 3600) {
    return THREE.MathUtils.lerp(0.38, 0.26, (hours - SUNSET / 3600) / (21 - SUNSET / 3600))
  }

  return 0.22
}

export { normalizeDaySeconds, normalizedTimeOfDay, SECONDS_PER_DAY }
