import * as THREE from 'three'

/** Unity gradient key (t in 0–1, linear RGB). Ported from SkyboxRenderController.prefab. */
type GradientStop = { t: number; color: THREE.Color }

/**
 * Unity SkyboxRenderController keys are authored in sRGB. Feed Three as sRGB so
 * linear working space + output encoding keep sky blues saturated (raw 0–1 as
 * linear looked chalky/washed under ACES).
 */
function stops(entries: Array<[number, number, number, number]>): GradientStop[] {
  return entries.map(([t, r, g, b]) => {
    const color = new THREE.Color()
    color.setRGB(r, g, b, THREE.SRGBColorSpace)
    return { t, color }
  })
}

function evaluate(stops: GradientStop[], t: number, out = new THREE.Color()): THREE.Color {
  const x = THREE.MathUtils.clamp(t, 0, 1)
  if (stops.length === 0) return out.set(0, 0, 0)
  if (x <= stops[0]!.t) return out.copy(stops[0]!.color)
  if (x >= stops[stops.length - 1]!.t) return out.copy(stops[stops.length - 1]!.color)
  for (let i = 0; i < stops.length - 1; i++) {
    const a = stops[i]!
    const b = stops[i + 1]!
    if (x >= a.t && x <= b.t) {
      const f = (x - a.t) / (b.t - a.t)
      return out.copy(a.color).lerp(b.color, f)
    }
  }
  return out.copy(stops[stops.length - 1]!.color)
}

import { normalizedTimeOfDay } from './skyboxTime'

export { normalizedTimeOfDay }

/** DCL SkyboxRenderController gradient ramps (unity-explorer). */
export const SKY_GRADIENTS = {
  // Midday zenith: slightly deeper blue than raw prefab (0.187,0.601,0.933) so
  // look-up reads Explorer-like rather than pale wash after tonemap/clouds.
  zenit: stops([
    [0.05, 0.259, 0.197, 0.507],
    [0.2, 0.32, 0.42, 0.82],
    [0.3, 0.22, 0.48, 0.9],
    [0.5, 0.11, 0.42, 0.88],
    [0.75, 0.28, 0.36, 0.82],
    [1, 0.261, 0.199, 0.51]
  ]),
  horizon: stops([
    [0.05, 0.293, 0, 0.44],
    [0.19, 0.414, 0.372, 0.589],
    [0.3, 1, 0.561, 0.524],
    [0.38, 0.573, 0.792, 0.772],
    [0.5, 0.676, 0.828, 0.962],
    [0.75, 0.953, 0.499, 0.563],
    [0.84, 0.256, 0.165, 0.457],
    [1, 0.291, 0, 0.44]
  ]),
  nadir: stops([
    [0.047, 0, 0, 0],
    [0.253, 0.859, 0.442, 0.433],
    [0.5, 0.267, 0.795, 0.851],
    [0.7, 0.887, 0.345, 0.953],
    [1, 0, 0, 0]
  ]),
  sun: stops([
    [0.072, 2.142, 1.365, 2.996],
    [0.18, 0.345, 0.395, 0.749],
    [0.3, 23.969, 2.772, 0],
    [0.519, 12.437, 23.969, 13.217],
    [0.75, 4.978, 1.981, 0.667],
    [0.86, 1.125, 1.145, 2.996],
    [1, 2.142, 1.365, 2.996]
  ]),
  rim: stops([
    [0.05, 0.457, 0.758, 0.61],
    [0.5, 0.962, 0.954, 0.539],
    [1, 0.457, 0.758, 0.61]
  ]),
  clouds: stops([
    [0.05, 0.339, 0.194, 1.059],
    [0.14, 0.298, 0.416, 1.153],
    [0.3, 0.72, 0.33, 0.024],
    [0.519, 1.423, 1.798, 2],
    [0.75, 1.498, 0.847, 0.664],
    [0.86, 0.759, 0.769, 1.554],
    [1, 0.336, 0.197, 1.061]
  ]),
  directional: stops([
    [0, 0.514, 0.388, 1],
    [0.185, 1, 0.602, 0.632],
    [0.333, 0.985, 0.864, 0.645],
    [0.519, 1, 0.931, 0.692],
    [0.684, 0.984, 0.863, 0.643],
    [0.801, 1, 0.6, 0.631],
    [1, 0.515, 0.386, 1]
  ]),
  // Trilight ambient — keys from unity-explorer SkyboxRenderController.prefab
  // (indirectSkyRamp / indirectEquatorRamp / groundEquatorRamp). Cool cyan equator +
  // green-grey ground washed midday yellow key to “studio white”; Explorer uses
  // lavender equator + dark red ground bounce for the softer yellow outdoor feel.
  indirectSky: stops([
    [0, 0.3536, 0, 1],
    [0.25, 1, 0.5968, 0.5264],
    [0.5, 0.5187, 0.6788, 0.738],
    [0.7, 1, 0.4998, 0.4585],
    [1, 0.3529, 0, 1]
  ]),
  /** Ambient equator band (our AmbientLight) — noon lavender, not cool cyan. */
  indirectEquator: stops([
    [0, 0.6172, 0.6205, 0.766],
    [0.3, 0.9019, 0.5242, 0.4748],
    [0.5, 0.7318, 0.6489, 0.787],
    [0.7, 0.7373, 0.5176, 0.6171],
    [1, 0.6157, 0.6196, 0.7647]
  ]),
  /** Ambient ground (hemi.groundColor) — noon dark red bounce, not green-grey. */
  indirectGround: stops([
    [0, 0.425, 0.1843, 0.203],
    [0.135, 0.5472, 0.1833, 0.1833],
    [0.3, 0.566, 0.1019, 0.0828],
    [0.5, 0.5849, 0.1018, 0.091],
    [0.7, 0.5283, 0.0922, 0.1054],
    [1, 0.5608, 0.2431, 0.2608]
  ]),
  fog: stops([
    [0, 0.29, 0, 0.44],
    [0.25, 0.55, 0.45, 0.65],
    [0.5, 0.72, 0.85, 0.95],
    [0.75, 0.85, 0.55, 0.6],
    [1, 0.29, 0, 0.44]
  ])
} as const

export function sampleSkyGradientsAtSeconds(seconds: number) {
  return sampleSkyGradients(normalizedTimeOfDay(seconds))
}

export function sampleSkyGradients(t: number): {
  zenit: THREE.Color
  horizon: THREE.Color
  nadir: THREE.Color
  sun: THREE.Color
  rim: THREE.Color
  clouds: THREE.Color
  directional: THREE.Color
  indirectSky: THREE.Color
  indirectEquator: THREE.Color
  indirectGround: THREE.Color
  fog: THREE.Color
  moonMask: number
  cloudHighlights: number
  sunRadiance: number
} {
  // Unity _Moon_Mask_Size — ~0.16 overnight, 0 midday (SkyboxRenderController + GenesisSky mat).
  // Wider night window so the disc is on for the full isSunPeriod=false arc.
  const moonMask =
    t < 0.27 || t > 0.79
      ? 0.16
      : t < 0.32
        ? THREE.MathUtils.lerp(0.16, 0, (t - 0.27) / 0.05)
        : t > 0.74
          ? THREE.MathUtils.lerp(0, 0.16, (t - 0.74) / 0.05)
          : 0

  const cloudHighlights =
    t < 0.3 ? 0.45 : t < 0.5 ? THREE.MathUtils.lerp(0.45, 1.0, (t - 0.3) / 0.2) : t < 0.75 ? 1.0 : 0.55

  const sunRadiance =
    t < 0.5 ? THREE.MathUtils.lerp(-0.38, 0.12, t / 0.5) : THREE.MathUtils.lerp(0.12, -0.38, (t - 0.5) / 0.5)

  return {
    zenit: evaluate(SKY_GRADIENTS.zenit, t),
    horizon: evaluate(SKY_GRADIENTS.horizon, t),
    nadir: evaluate(SKY_GRADIENTS.nadir, t),
    sun: evaluate(SKY_GRADIENTS.sun, t),
    rim: evaluate(SKY_GRADIENTS.rim, t),
    clouds: evaluate(SKY_GRADIENTS.clouds, t),
    directional: evaluate(SKY_GRADIENTS.directional, t),
    indirectSky: evaluate(SKY_GRADIENTS.indirectSky, t),
    indirectEquator: evaluate(SKY_GRADIENTS.indirectEquator, t),
    indirectGround: evaluate(SKY_GRADIENTS.indirectGround, t),
    fog: evaluate(SKY_GRADIENTS.fog, t),
    moonMask,
    cloudHighlights,
    sunRadiance
  }
}

/** Approximate DCL directional light intensity from sun elevation. */
export function directionalLightIntensity(sunDir: THREE.Vector3): number {
  const elevation = sunDir.y
  if (elevation > 0.15) return THREE.MathUtils.lerp(0.85, 1.15, (elevation - 0.15) / 0.6)
  if (elevation > -0.05) return THREE.MathUtils.lerp(0.55, 0.85, (elevation + 0.05) / 0.2)
  return THREE.MathUtils.lerp(0.35, 0.55, (elevation + 0.35) / 0.3)
}
