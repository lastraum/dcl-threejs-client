import * as THREE from 'three'

const _target = new THREE.Vector3()
const _sunDir = new THREE.Vector3()
const _moonDir = new THREE.Vector3()

/** Shared sun/moon + sky snapshot for outdoor shaders (water, island beach, etc.). */
export type OutdoorLightingSnapshot = {
  sunDir: THREE.Vector3
  moonDir: THREE.Vector3
  /** Directional color × intensity (linear RGB). */
  sunLight: THREE.Vector3
  moonLight: THREE.Vector3
  /** Primary fill for single-light water shaders. */
  primaryDir: THREE.Vector3
  primaryColor: THREE.Color
  ambient: THREE.Vector3
  skyHorizon: THREE.Color
  skyZenith: THREE.Color
  isDay: boolean
}

export function createOutdoorLightingSnapshot(): OutdoorLightingSnapshot {
  return {
    sunDir: new THREE.Vector3(0.35, 0.85, 0.25),
    moonDir: new THREE.Vector3(-0.35, 0.45, -0.25),
    sunLight: new THREE.Vector3(0.9, 0.88, 0.82),
    moonLight: new THREE.Vector3(0.12, 0.11, 0.2),
    primaryDir: new THREE.Vector3(0.35, 0.85, 0.25),
    primaryColor: new THREE.Color(1, 1, 1),
    ambient: new THREE.Vector3(0.48, 0.5, 0.52),
    skyHorizon: new THREE.Color('#7ec8e3'),
    skyZenith: new THREE.Color('#1a4a6e'),
    isDay: true
  }
}

function lightDirection(light: THREE.DirectionalLight, out: THREE.Vector3): THREE.Vector3 {
  light.target.getWorldPosition(_target)
  return out.copy(light.position).sub(_target).normalize()
}

export function syncOutdoorLightingFromLights(
  out: OutdoorLightingSnapshot,
  sun: THREE.DirectionalLight,
  moon: THREE.DirectionalLight,
  hemi: THREE.HemisphereLight,
  sky: { horizon: THREE.Color; zenit: THREE.Color },
  isDay: boolean
): void {
  lightDirection(sun, _sunDir)
  lightDirection(moon, _moonDir)
  out.sunDir.copy(_sunDir)
  out.moonDir.copy(_moonDir)

  out.sunLight.set(sun.color.r, sun.color.g, sun.color.b).multiplyScalar(sun.intensity)
  out.moonLight.set(moon.color.r, moon.color.g, moon.color.b).multiplyScalar(moon.intensity)

  const skyAmbR = hemi.color.r * hemi.intensity
  const skyAmbG = hemi.color.g * hemi.intensity
  const skyAmbB = hemi.color.b * hemi.intensity
  const gndAmbR = hemi.groundColor.r * hemi.intensity
  const gndAmbG = hemi.groundColor.g * hemi.intensity
  const gndAmbB = hemi.groundColor.b * hemi.intensity
  out.ambient.set(
    skyAmbR * 0.62 + gndAmbR * 0.38,
    skyAmbG * 0.62 + gndAmbG * 0.38,
    skyAmbB * 0.62 + gndAmbB * 0.38
  )

  out.skyHorizon.copy(sky.horizon)
  out.skyZenith.copy(sky.zenit)
  out.isDay = isDay

  if (isDay && sun.intensity > 0.02) {
    out.primaryDir.copy(_sunDir)
    out.primaryColor.copy(sun.color)
  } else if (moon.intensity > 0.02) {
    out.primaryDir.copy(_moonDir)
    out.primaryColor.copy(moon.color)
  } else {
    out.primaryDir.copy(_sunDir)
    out.primaryColor.setRGB(0, 0, 0)
  }
}