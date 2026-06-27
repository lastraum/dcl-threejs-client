import * as THREE from 'three'
import type { OutdoorLightingSnapshot } from '../../environment/OutdoorLighting'
import type { IslandShoreLayout } from './islandLandscapeKeys'

/** Island / ring ocean surface Y (DCL metres) — beach heightfield slopes to this level. */
export const ISLAND_WATER_SURFACE_Y = -1.35

/** Original procedural beach fill — kept at midday so sand stays warm, not blown out. */
const ISLAND_SHORE_BASE_AMBIENT = new THREE.Vector3(0.48, 0.5, 0.52)

/** Genesis Games `TERRAIN_BIOME_COLORS.sand`, brightened for island beach readability. */
export const ISLAND_BEACH_SAND_COLOR = 0xecd898

const VERT = /* glsl */ `
varying vec3 vWorldPos;
varying vec3 vWorldNormal;
varying float vRadialDist;

uniform vec2 uIslandCenterXZ;
uniform float uFlatRadius;
uniform float uOuterRadius;

void main() {
  vec4 worldPos = modelMatrix * vec4(position, 1.0);
  vWorldPos = worldPos.xyz;
  vWorldNormal = normalize(mat3(modelMatrix) * normal);
  vec2 delta = vWorldPos.xz - uIslandCenterXZ;
  vRadialDist = length(delta);
  gl_Position = projectionMatrix * viewMatrix * worldPos;
}
`

const FRAG = /* glsl */ `
precision mediump float;

varying vec3 vWorldPos;
varying vec3 vWorldNormal;
varying float vRadialDist;

uniform vec3 uBiomeSand;
uniform vec3 uSunDir;
uniform vec3 uMoonDir;
uniform float uSunWeight;
uniform float uMoonWeight;
uniform vec3 uAmbient;
uniform float uTerrainWorldMinY;
uniform float uTerrainWorldMaxY;
uniform float uWaterLevelWorld;
uniform float uSandAboveWater;
uniform float uSandBandM;
uniform float uWaterTintMix;
uniform float uWaterBandMeters;
uniform vec3 uWaterTint;
uniform vec2 uIslandCenterXZ;
uniform float uFlatRadius;
uniform float uOuterRadius;

float hash21(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

float valueNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 3; i++) {
    v += a * valueNoise(p);
    p *= 2.03;
    a *= 0.5;
  }
  return v;
}

vec3 islandBeachAlbedo(vec3 worldPos, vec3 worldNorm) {
  float height = worldPos.y;
  vec3 up = vec3(0.0, 1.0, 0.0);
  float slope = 1.0 - clamp(dot(normalize(worldNorm), up), 0.0, 1.0);

  float grain = fbm(worldPos.xz * 0.14) * 0.1 + fbm(worldPos.xz * 0.42 + 2.1) * 0.05;
  vec3 sand = mix(uBiomeSand * 0.96, uBiomeSand * 1.14, grain);

  float span = max(1e-2, uTerrainWorldMaxY - uTerrainWorldMinY);
  float heightShade = 0.9 + 0.14 * clamp((height - uTerrainWorldMinY) / span, 0.0, 1.0);
  sand *= heightShade;

  float sandCeiling = uWaterLevelWorld + uSandAboveWater;
  float sandLo = sandCeiling - uSandBandM;
  float sandHi = sandCeiling + 0.35;
  float drySand = 1.0 - smoothstep(sandLo, sandHi, height);
  sand = mix(sand, sand * 1.14 + vec3(0.04, 0.03, 0.01), drySand * (1.0 - slope * 0.2));

  float band = max(0.25, uWaterBandMeters);
  float shoreWet = 1.0 - smoothstep(0.0, band, max(0.0, height - uWaterLevelWorld));
  vec3 wetSand = sand * 0.82 + vec3(0.06, 0.05, 0.03);
  sand = mix(sand, wetSand, shoreWet * 0.35);

  float beachT = smoothstep(uFlatRadius, uOuterRadius, vRadialDist);
  sand = mix(sand, sand * 0.88 + vec3(0.05, 0.04, 0.02), beachT * 0.35);

  return sand;
}

void main() {
  if (vRadialDist > uOuterRadius + 0.25) discard;

  vec3 n = normalize(vWorldNormal);
  vec3 albedo = islandBeachAlbedo(vWorldPos, n);

  float shore = uOuterRadius - vRadialDist;
  float foamStreak = smoothstep(0.0, 2.5, shore) * smoothstep(5.0, 0.5, shore);
  foamStreak *= 0.35 + 0.65 * fbm(vWorldPos.xz * 0.35 + vec2(4.1, 1.7));
  albedo = mix(albedo, vec3(0.93, 0.94, 0.9), foamStreak * 0.45);

  float sunNdl = clamp(dot(n, normalize(uSunDir)), 0.0, 1.0);
  float moonNdl = clamp(dot(n, normalize(uMoonDir)), 0.0, 1.0);
  float direct = sunNdl * uSunWeight + moonNdl * uMoonWeight;
  vec3 lit = albedo * (uAmbient + vec3(0.55) * direct);
  gl_FragColor = vec4(lit, 1.0);
}
`

function hexToVec3(hex: number): THREE.Vector3 {
  const c = new THREE.Color(hex)
  return new THREE.Vector3(c.r, c.g, c.b)
}

export class IslandShoreMaterial {
  readonly material: THREE.ShaderMaterial
  private readonly uniforms: Record<string, THREE.IUniform>

  constructor() {
    this.uniforms = {
      uBiomeSand: { value: hexToVec3(ISLAND_BEACH_SAND_COLOR) },
      uSunDir: { value: new THREE.Vector3(0.35, 0.85, 0.25).normalize() },
      uMoonDir: { value: new THREE.Vector3(-0.35, 0.45, -0.25).normalize() },
      uSunWeight: { value: 1.0 },
      uMoonWeight: { value: 0.0 },
      uAmbient: { value: ISLAND_SHORE_BASE_AMBIENT.clone() },
      uTerrainWorldMinY: { value: -0.5 },
      uTerrainWorldMaxY: { value: 0.5 },
      uWaterLevelWorld: { value: ISLAND_WATER_SURFACE_Y },
      uSandAboveWater: { value: 0.8 },
      uSandBandM: { value: 1.5 },
      uWaterTintMix: { value: 0.2 },
      uWaterBandMeters: { value: 1.25 },
      uWaterTint: { value: new THREE.Vector3(0.45, 0.4, 0.32) },
      uIslandCenterXZ: { value: new THREE.Vector2() },
      uFlatRadius: { value: 16 },
      uOuterRadius: { value: 48 }
    }

    this.material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: false,
      depthWrite: true,
      side: THREE.FrontSide
    })
    this.material.customProgramCacheKey = () => 'island-shore-proc-v4'
  }

  /** @param centerThree Island centre in Three.js world space (matches shore mesh vertices). */
  applyLayout(layout: IslandShoreLayout, centerThree: { x: number; z: number }): void {
    this.uniforms.uIslandCenterXZ!.value.set(centerThree.x, centerThree.z)
    this.uniforms.uFlatRadius!.value = layout.flatRadiusM
    this.uniforms.uOuterRadius!.value = layout.outerRadiusM
  }

  updateHeightRange(minY: number, maxY: number): void {
    this.uniforms.uTerrainWorldMinY!.value = minY
    this.uniforms.uTerrainWorldMaxY!.value = Math.max(minY + 1e-3, maxY)
  }

  setWaterLevel(y: number): void {
    this.uniforms.uWaterLevelWorld!.value = y
  }

  applyOutdoorLighting(lighting: OutdoorLightingSnapshot): void {
    ;(this.uniforms.uSunDir!.value as THREE.Vector3).copy(lighting.sunDir)
    ;(this.uniforms.uMoonDir!.value as THREE.Vector3).copy(lighting.moonDir)

    const sunStr = THREE.MathUtils.clamp(lighting.sunLight.length() / 2.0, 0, 1)
    const moonStr = THREE.MathUtils.clamp(lighting.moonLight.length() / 0.5, 0, 1)
    this.uniforms.uSunWeight!.value = 0.55 * sunStr
    this.uniforms.uMoonWeight!.value = 0.38 * moonStr

    const ambient = this.uniforms.uAmbient!.value as THREE.Vector3
    ambient.copy(ISLAND_SHORE_BASE_AMBIENT).lerp(lighting.ambient, (1 - sunStr) * 0.7)
  }
}