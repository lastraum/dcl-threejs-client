import * as THREE from 'three'
import type { OutdoorLightingSnapshot } from '../../environment/OutdoorLighting'
import type { IslandShoreLayout } from './islandLandscapeKeys'

/** Island / ring ocean surface Y (DCL metres) — beach heightfield slopes to this level. */
export const ISLAND_WATER_SURFACE_Y = -1.35

/** Genesis Games `TERRAIN_BIOME_COLORS.sand`, brightened for island beach readability. */
export const ISLAND_BEACH_SAND_COLOR = 0xecd898

/** Procedural beach helpers injected into MeshStandard (receives directional sun/moon shadows). */
const SHORE_GLSL_HELPERS = /* glsl */ `
varying vec3 vIslandWorldPos;
varying float vIslandRadialDist;

uniform vec3 uBiomeSand;
uniform float uTerrainWorldMinY;
uniform float uTerrainWorldMaxY;
uniform float uWaterLevelWorld;
uniform float uSandAboveWater;
uniform float uSandBandM;
uniform float uWaterBandMeters;
uniform vec2 uIslandCenterXZ;
uniform float uFlatRadius;
uniform float uOuterRadius;

float islandHash21(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

float islandValueNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = islandHash21(i);
  float b = islandHash21(i + vec2(1.0, 0.0));
  float c = islandHash21(i + vec2(0.0, 1.0));
  float d = islandHash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

float islandFbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 3; i++) {
    v += a * islandValueNoise(p);
    p *= 2.03;
    a *= 0.5;
  }
  return v;
}

vec3 islandBeachAlbedo(vec3 worldPos, vec3 worldNorm) {
  float height = worldPos.y;
  vec3 up = vec3(0.0, 1.0, 0.0);
  float slope = 1.0 - clamp(dot(normalize(worldNorm), up), 0.0, 1.0);

  float grain = islandFbm(worldPos.xz * 0.14) * 0.1 + islandFbm(worldPos.xz * 0.42 + 2.1) * 0.05;
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

  float beachT = smoothstep(uFlatRadius, uOuterRadius, vIslandRadialDist);
  sand = mix(sand, sand * 0.88 + vec3(0.05, 0.04, 0.02), beachT * 0.35);

  float shore = uOuterRadius - vIslandRadialDist;
  float foamStreak = smoothstep(0.0, 2.5, shore) * smoothstep(5.0, 0.5, shore);
  foamStreak *= 0.35 + 0.65 * islandFbm(worldPos.xz * 0.35 + vec2(4.1, 1.7));
  sand = mix(sand, vec3(0.93, 0.94, 0.9), foamStreak * 0.45);

  return sand;
}
`

function hexToColor(hex: number): THREE.Color {
  return new THREE.Color(hex)
}

/**
 * Circular island beach — MeshStandard so sun/moon soft shadows land on the sand
 * (custom ShaderMaterial previously set receiveShadow but never sampled the shadow map).
 */
export class IslandShoreMaterial {
  readonly material: THREE.MeshStandardMaterial
  private readonly uniforms: Record<string, THREE.IUniform>

  constructor() {
    const sand = hexToColor(ISLAND_BEACH_SAND_COLOR)
    this.uniforms = {
      uBiomeSand: { value: new THREE.Vector3(sand.r, sand.g, sand.b) },
      uTerrainWorldMinY: { value: -0.5 },
      uTerrainWorldMaxY: { value: 0.5 },
      uWaterLevelWorld: { value: ISLAND_WATER_SURFACE_Y },
      uSandAboveWater: { value: 0.8 },
      uSandBandM: { value: 1.5 },
      uWaterBandMeters: { value: 1.25 },
      uIslandCenterXZ: { value: new THREE.Vector2() },
      uFlatRadius: { value: 16 },
      uOuterRadius: { value: 48 }
    }

    this.material = new THREE.MeshStandardMaterial({
      color: sand,
      roughness: 0.94,
      metalness: 0.02,
      envMapIntensity: 0.35
    })
    this.material.customProgramCacheKey = () => 'island-shore-std-shadow-v1'
    this.material.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.uniforms)

      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          /* glsl */ `#include <common>
varying vec3 vIslandWorldPos;
varying float vIslandRadialDist;
uniform vec2 uIslandCenterXZ;
`
        )
        .replace(
          '#include <worldpos_vertex>',
          /* glsl */ `#include <worldpos_vertex>
vIslandWorldPos = (modelMatrix * vec4( transformed, 1.0 )).xyz;
vIslandRadialDist = length( vIslandWorldPos.xz - uIslandCenterXZ );
`
        )

      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\n${SHORE_GLSL_HELPERS}`)
        .replace(
          '#include <normal_fragment_maps>',
          /* glsl */ `#include <normal_fragment_maps>
if ( vIslandRadialDist > uOuterRadius + 0.25 ) discard;
{
  // View-space normal → world for beach slope/grain (after normal maps).
  vec3 nWorld = inverseTransformDirection( normal, viewMatrix );
  diffuseColor.rgb = islandBeachAlbedo( vIslandWorldPos, nWorld );
}
`
        )
    }
  }

  /** @param centerThree Island centre in Three.js world space (matches shore mesh vertices). */
  applyLayout(layout: IslandShoreLayout, centerThree: { x: number; z: number }): void {
    this.uniforms.uIslandCenterXZ!.value.set(centerThree.x, centerThree.z)
    this.uniforms.uFlatRadius!.value = layout.flatRadiusM
    this.uniforms.uOuterRadius!.value = layout.outerRadiusM
    this.material.needsUpdate = true
  }

  updateHeightRange(minY: number, maxY: number): void {
    this.uniforms.uTerrainWorldMinY!.value = minY
    this.uniforms.uTerrainWorldMaxY!.value = Math.max(minY + 1e-3, maxY)
  }

  setWaterLevel(y: number): void {
    this.uniforms.uWaterLevelWorld!.value = y
  }

  /**
   * Scene DirectionalLight + hemi already light MeshStandard shore.
   * Keep hook for World sync; slight emissive tracks ambient so night/off stays coherent.
   */
  applyOutdoorLighting(lighting: OutdoorLightingSnapshot): void {
    const key = Math.max(lighting.sunLight.length() / 2.0, lighting.moonLight.length() / 0.45)
    const amb = THREE.MathUtils.clamp(key, 0, 1)
    // Tiny fill so sand doesn’t go pure black under hard shadow at dusk
    this.material.emissive.setRGB(
      lighting.ambient.x * 0.08 * amb,
      lighting.ambient.y * 0.08 * amb,
      lighting.ambient.z * 0.08 * amb
    )
    this.material.emissiveIntensity = 1
  }
}
