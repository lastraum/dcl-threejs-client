import * as THREE from 'three'

/**
 * Explorer Unity `Pond.mat` (unity-explorer, Stylized Water shader
 * guid d7b0192b9bf19c949900035fa781fdc4) — keywords `_CAUSTICS _NORMALMAP
 * _REFRACTION _TRANSLUCENCY`. Scene `water_surface.glb` has no maps; sibling
 * `water.png` is the caustics sheet. This material is the renderer path.
 *
 * Numbers from Pond.mat: WaterColor, WaterShallowColor, CausticsSpeed/Tiling/
 * Brightness, NormalSpeed/SubSpeed, Smoothness, SunReflectionStrength.
 */

const WATER_COLOR = new THREE.Color(0.21176466, 0.6745098, 1)
const SHALLOW_COLOR = new THREE.Color(0, 0.9394503, 1)
const HORIZON_COLOR = new THREE.Color(0, 1, 0.96341467)

const CAUSTICS_SPEED = 0.06
const CAUSTICS_TILING = 0.14
const CAUSTICS_BRIGHTNESS = 0.29
const NORMAL_SPEED = 0.2
const NORMAL_SUB_SPEED = -0.5

const live = new Set<{
  material: THREE.MeshPhysicalMaterial
  uTime: { value: number }
}>()

const WATER_GLSL = /* glsl */ `
vec3 pondWaterAlbedo(vec3 lit, vec2 uv, vec3 worldN, vec3 viewDir) {
  float t = uPondTime * uPondCausticsSpeed;
  vec2 uvA = uv * uPondCausticsTiling + vec2(t * 0.58, t * 0.37);
  vec2 uvB = uv * uPondCausticsTiling * 0.73 + vec2(t * -0.30, t * 0.51);
  vec3 cA = texture2D(map, uvA).rgb;
  vec3 cB = texture2D(map, uvB).rgb;
  vec3 caustics = mix(cA, cB, 0.5);
  caustics = mix(vec3(1.0), caustics, 0.72);

  float facing = clamp(dot(normalize(worldN), normalize(viewDir)), 0.0, 1.0);
  float fres = pow(1.0 - facing, 4.0);
  vec3 body = mix(uPondShallowColor, uPondWaterColor, 0.42 + 0.2 * facing);
  vec3 rgb = body * caustics;
  rgb += caustics * uPondCausticsBrightness;
  rgb += uPondHorizonColor * fres * 0.45;
  rgb += lit * 0.12;
  return rgb;
}
`

export function createExplorerPondWaterMaterial(caustics: THREE.Texture): THREE.MeshPhysicalMaterial {
  caustics.wrapS = THREE.RepeatWrapping
  caustics.wrapT = THREE.RepeatWrapping
  caustics.colorSpace = THREE.SRGBColorSpace
  caustics.flipY = false
  caustics.needsUpdate = true

  const uTime = { value: 0 }
  // No MeshPhysicalMaterial.transmission — that forces Three's
  // renderTransmissionPass every frame and texSubImage2D-uploads the whole
  // scene (Overload resolution failed on a closed ImageBitmap = hitch).
  // Explorer Pond.mat refraction is the albedo/caustics shader below.
  const material = new THREE.MeshPhysicalMaterial({
    map: caustics,
    color: WATER_COLOR,
    roughness: 0.18,
    metalness: 0.04,
    transmission: 0,
    transparent: true,
    opacity: 0.92,
    depthWrite: false,
    side: THREE.DoubleSide,
    envMapIntensity: 1.35,
    specularIntensity: 1,
    specularColor: new THREE.Color(0.85, 0.95, 1)
  })
  material.name = 'dclExplorerPondWater'
  material.customProgramCacheKey = () => 'dcl-explorer-pond-water-v2'
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uPondTime = uTime
    shader.uniforms.uPondWaterColor = { value: WATER_COLOR }
    shader.uniforms.uPondShallowColor = { value: SHALLOW_COLOR }
    shader.uniforms.uPondHorizonColor = { value: HORIZON_COLOR }
    shader.uniforms.uPondCausticsSpeed = { value: CAUSTICS_SPEED }
    shader.uniforms.uPondCausticsTiling = { value: CAUSTICS_TILING }
    shader.uniforms.uPondCausticsBrightness = { value: CAUSTICS_BRIGHTNESS }

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        /* glsl */ `#include <common>
uniform float uPondTime;
uniform vec3 uPondWaterColor;
uniform vec3 uPondShallowColor;
uniform vec3 uPondHorizonColor;
uniform float uPondCausticsSpeed;
uniform float uPondCausticsTiling;
uniform float uPondCausticsBrightness;
${WATER_GLSL}
`
      )
      .replace(
        '#include <map_fragment>',
        /* glsl */ `#include <map_fragment>
{
  vec3 viewDir = normalize( -vViewPosition );
  vec3 nWorld = inverseTransformDirection( normal, viewMatrix );
  vec2 baseUv = vMapUv;
  diffuseColor.rgb = pondWaterAlbedo( diffuseColor.rgb, baseUv, nWorld, viewDir );
  float facing = clamp(dot(normalize(nWorld), viewDir), 0.0, 1.0);
  diffuseColor.a = mix(0.72, 0.94, facing);
}
`
      )
  }

  live.add({ material, uTime })
  return material
}

let pondClockOriginMs = 0

export function tickExplorerPondWater(_dt: number): void {
  if (live.size === 0) return
  // Wall clock — pumpMotionBridges can run 0–3× per rAF with hitchy scene dt.
  // Incremental steps made caustics stutter or 2×-speed on the plaza pond.
  if (!pondClockOriginMs) pondClockOriginMs = performance.now()
  const t = (performance.now() - pondClockOriginMs) / 1000
  for (const entry of live) {
    entry.uTime.value = t
  }
}

/** Dual-layer scroll rates from Pond.mat `_NormalSpeed` / `_NormalSubSpeed` (seconds). */
export const EXPLORER_POND_NORMAL_SPEEDS = {
  primary: NORMAL_SPEED,
  secondary: NORMAL_SUB_SPEED
} as const
