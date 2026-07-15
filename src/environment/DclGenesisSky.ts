import * as THREE from 'three'
import { ENVIRONMENT_TEXTURES } from './environmentAssets'
import { loadCrossCubemap } from './crossCubemap'
import { sampleSkyGradients } from './skyGradients'
import { normalizedTimeOfDay } from './skyboxTime'
import { isSunPeriod } from './sunCycleSampler'
import {
  FIXED_SUN_DISC_CORE_GAIN,
  FIXED_SUN_DISC_CUTOFF,
  FIXED_SUN_DISC_GLOW_GAIN
} from '../rendering/SunEnvironmentSettings'

const SKY_VERTEX = /* glsl */ `
// Model-space ray — dome is centered on the camera each frame (see EnvironmentSystem).
varying vec3 vDirection;
void main() {
  vDirection = position;
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  vec4 clipPos = projectionMatrix * mvPosition;
  // Infinite sky — push to far plane after projection (Three.js Sky / envmap pattern).
  gl_Position = vec4(clipPos.x, clipPos.y, clipPos.w, clipPos.w);
}
`

const SKY_FRAGMENT = /* glsl */ `
uniform vec3 uZenitColor;
uniform vec3 uHorizonColor;
uniform vec3 uNadirColor;
uniform vec3 uSunColor;
uniform vec3 uRimColor;
uniform vec3 uCloudsColor;
uniform vec3 uSunDirection;
uniform vec3 uMoonDirection;
uniform float uMoonMask;
uniform float uSunSize;
uniform float uSunRadiance;
uniform float uSunDiscCutoff;
uniform float uSunDiscCoreGain;
uniform float uSunDiscGlowGain;
uniform float uCloudHighlights;
uniform float uCloudDensity;
uniform float uCloudOpacity;
uniform float uCloudsRotationSpeed;
uniform float uTime;
uniform sampler2D uMoonMap;
uniform sampler2D uStarsMap;
uniform samplerCube uFarCloudsCube;
uniform samplerCube uNearCloudsCube;
uniform samplerCube uHorizonCloudsCube;
uniform samplerCube uTopCloudsCube;

varying vec3 vDirection;

vec3 sampleGradient(vec3 dir, vec3 zenit, vec3 horizon, vec3 nadir) {
  float y = clamp(dir.y, -1.0, 1.0);
  float t = y * 0.5 + 0.5;
  vec3 upBlend = mix(horizon, zenit, pow(t, 0.65));
  vec3 downBlend = mix(horizon, nadir, pow(1.0 - t, 0.55));
  return y >= 0.0 ? upBlend : downBlend;
}

/**
 * Night moon — Unity GenesisSky style:
 * bright disc with offset bite (crescent), small companion, soft glow.
 * _Moon_Mask_Size ~0.16 night; mask offset (~0.01,-0.01) carves the C.
 */
vec3 moonDisc(vec3 dir, vec3 moonDir, sampler2D map, float mask) {
  if (mask < 0.001) return vec3(0.0);
  vec3 m = normalize(moonDir);
  if (m.y < -0.08) return vec3(0.0);
  vec3 v = normalize(dir);
  float moonDot = dot(v, m);

  // Visual only — keep smaller than sun-style blobs (Explorer crescent is modest on screen).
  float moonSize = 0.018;
  float disc = step(cos(moonSize), moonDot);

  // Tangent frame for bite offset + companion (Unity moon_mask_offset).
  vec3 up = abs(m.y) < 0.99 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
  vec3 tang = normalize(cross(up, m));
  vec3 bitang = cross(m, tang);
  // Offset sphere that subtracts from the disc → crescent.
  vec3 biteDir = normalize(m + (tang * 0.42 + bitang * (-0.18)) * moonSize * 12.0);
  float bite = step(cos(moonSize * 0.92), dot(v, biteDir));
  float crescent = disc * (1.0 - bite);

  // Small secondary companion (Unity second_sun / flare twin near the moon).
  vec3 companionDir = normalize(m + tang * 0.032 + bitang * 0.028);
  float companion = step(cos(moonSize * 0.18), dot(v, companionDir));

  // Tight glow so we don't inflate the apparent size with a huge bloom.
  float softCore = pow(max(moonDot, 0.0), 220.0) * 0.35;
  float softHalo = pow(max(moonDot, 0.0), 90.0) * 0.12;

  // Optional texture detail inside the crescent (does not force a full circle).
  vec2 uv = vec2(dot(v, tang), dot(v, bitang)) / max(sin(moonSize * 1.4), 1e-4) * 0.5 + 0.5;
  vec4 tex = texture2D(map, uv);
  float inUv = step(0.0, uv.x) * step(uv.x, 1.0) * step(0.0, uv.y) * step(uv.y, 1.0);
  vec3 surface = mix(vec3(1.9, 1.95, 2.15), tex.rgb * 1.6, clamp(tex.a * inUv * 0.35, 0.0, 1.0));

  float opacity = clamp(mask * 6.25, 0.0, 1.0);
  return surface * (crescent * 2.4 + companion * 1.6 + softCore + softHalo) * opacity;
}

// Small warm disc + light soft halo. Visual only — scene lighting uses DirectionalLight.
vec3 sunDisc(vec3 dir, vec3 sunDir, vec3 sunColor, float radiance) {
  vec3 sDir = normalize(sunDir);
  float d = dot(normalize(dir), sDir);
  float glowAmt = max(uSunDiscGlowGain, 0.0);
  // Halo only slightly larger than the core (avoid screen-filling white blob).
  float glowReach = uSunDiscCutoff - mix(0.004, 0.022, glowAmt);
  if (d < glowReach) return vec3(0.0);

  float ang = acos(clamp(d, -1.0, 1.0));
  float coreEdge = acos(clamp(uSunDiscCutoff, -1.0, 1.0));
  float core = 1.0 - smoothstep(0.0, max(coreEdge * 0.95, 0.0008), ang);
  core = pow(max(core, 0.0), 1.3);

  float rPos = max(radiance, 0.0);
  float innerSpread = mix(0.005, 0.028, glowAmt);
  float outerSpread = max(innerSpread * 3.2, 0.012);
  float corona = exp(-ang / innerSpread) * glowAmt * (1.1 + rPos * 0.6);
  float bloom = exp(-ang / outerSpread) * glowAmt * (0.4 + rPos * 0.25);

  // Warm white disc (not cool cyan); keep gains modest so core stays a small circle.
  vec3 warm = sunColor * vec3(1.28, 1.08, 0.86);
  float rad = 0.5 + rPos * 0.55;
  return warm * rad * (core * uSunDiscCoreGain + corona + bloom);
}

vec3 starField(vec3 dir, sampler2D map, float night) {
  if (night <= 0.01) return vec3(0.0);
  vec2 uv = vec2(atan(dir.z, dir.x) / 6.2831853 + 0.5, dir.y * 0.5 + 0.5);
  vec3 stars = texture2D(map, uv * 3.0).rgb;
  float aboveHorizon = smoothstep(-0.05, 0.15, dir.y);
  return stars * night * aboveHorizon * 2.5;
}

vec3 rotateY(vec3 dir, float angle) {
  float c = cos(angle);
  float s = sin(angle);
  return vec3(c * dir.x + s * dir.z, dir.y, -s * dir.x + c * dir.z);
}

// DCL clouds gradient is HDR (keys >1 at midday). Keep hue, put brightness in intensity.
vec3 cloudTintColor(vec3 hdr, float highlights, vec3 dir, vec3 sunDir) {
  float peak = max(max(hdr.r, hdr.g), hdr.b);
  vec3 hue = hdr / max(peak, 1e-4);
  float intensity = peak * (0.82 + highlights * 0.55);
  float sunSide = sunDir.y > 0.05
    ? smoothstep(-0.05, 0.45, dot(normalize(dir), normalize(sunDir)))
    : 0.0;
  intensity *= mix(0.88, 1.28, sunSide * highlights);
  return hue * intensity;
}

float cloudLayerMask(
  vec3 dir,
  samplerCube map,
  float angle,
  float opacity,
  float yMin,
  float yMax
) {
  if (dir.y < yMin) return 0.0;
  vec3 sampleDir = rotateY(normalize(dir), angle);
  float n = textureCube(map, sampleDir, -1.0).r;
  float density = 1.0 - uCloudDensity;
  float falloff = 0.62;
  float mask = smoothstep(density, density + falloff, n);
  mask *= smoothstep(yMin, yMin + 0.15, dir.y);
  mask *= 1.0 - smoothstep(yMax - 0.1, yMax, dir.y);
  return mask * opacity * uCloudOpacity;
}

vec3 blendCloudLayer(
  vec3 sky,
  vec3 dir,
  samplerCube map,
  float angle,
  float opacity,
  float yMin,
  float yMax
) {
  float mask = cloudLayerMask(dir, map, angle, opacity, yMin, yMax);
  if (mask <= 0.001) return sky;
  vec3 cloud = cloudTintColor(uCloudsColor, uCloudHighlights, dir, uSunDirection);
  // Screen-style brighten — lerp toward gray tint; DCL puffs read white over blue sky
  vec3 layer = min(cloud, vec3(2.5));
  vec3 screen = vec3(1.0) - (vec3(1.0) - sky) * (vec3(1.0) - min(layer, vec3(1.0)));
  return mix(sky, max(screen, layer), mask);
}

void main() {
  vec3 dir = normalize(vDirection);
  vec3 sky = sampleGradient(dir, uZenitColor, uHorizonColor, uNadirColor);

  float night = 1.0 - smoothstep(-0.08, 0.12, uSunDirection.y);
  sky += starField(dir, uStarsMap, night);
  sky += sunDisc(dir, uSunDirection, uSunColor, uSunRadiance);
  sky += moonDisc(dir, uMoonDirection, uMoonMap, uMoonMask);

  float cloudAngle = uTime * uCloudsRotationSpeed;
  sky = blendCloudLayer(sky, dir, uHorizonCloudsCube, cloudAngle * 0.5, 0.85, 0.02, 0.42);
  sky = blendCloudLayer(sky, dir, uFarCloudsCube, cloudAngle, 0.55, 0.05, 0.95);
  sky = blendCloudLayer(sky, dir, uNearCloudsCube, cloudAngle * 2.0, 0.75, 0.08, 1.0);
  sky = blendCloudLayer(sky, dir, uTopCloudsCube, cloudAngle * 1.5, 0.45, 0.35, 1.0);

  float rim = pow(max(1.0 - abs(dir.y), 0.0), 3.0) * 0.25;
  sky += uRimColor * rim;

  gl_FragColor = vec4(sky, 1.0);
}
`

export type GenesisSkyUniforms = {
  uZenitColor: THREE.IUniform<THREE.Color>
  uHorizonColor: THREE.IUniform<THREE.Color>
  uNadirColor: THREE.IUniform<THREE.Color>
  uSunColor: THREE.IUniform<THREE.Color>
  uRimColor: THREE.IUniform<THREE.Color>
  uCloudsColor: THREE.IUniform<THREE.Color>
  uSunDirection: THREE.IUniform<THREE.Vector3>
  uMoonDirection: THREE.IUniform<THREE.Vector3>
  uMoonMask: THREE.IUniform<number>
  uSunSize: THREE.IUniform<number>
  uSunRadiance: THREE.IUniform<number>
  uSunDiscCutoff: THREE.IUniform<number>
  uSunDiscCoreGain: THREE.IUniform<number>
  uSunDiscGlowGain: THREE.IUniform<number>
  uCloudHighlights: THREE.IUniform<number>
  uCloudDensity: THREE.IUniform<number>
  uCloudOpacity: THREE.IUniform<number>
  uCloudsRotationSpeed: THREE.IUniform<number>
  uTime: THREE.IUniform<number>
  uMoonMap: THREE.IUniform<THREE.Texture | null>
  uStarsMap: THREE.IUniform<THREE.Texture | null>
  uFarCloudsCube: THREE.IUniform<THREE.CubeTexture | null>
  uNearCloudsCube: THREE.IUniform<THREE.CubeTexture | null>
  uHorizonCloudsCube: THREE.IUniform<THREE.CubeTexture | null>
  uTopCloudsCube: THREE.IUniform<THREE.CubeTexture | null>
}

const _zeroSun = new THREE.Vector3(0, -1, 0)

/** DCL GenesisSky-style dome (unity-explorer StylizedSkybox). */
export class DclGenesisSky {
  readonly mesh: THREE.Mesh
  readonly material: THREE.ShaderMaterial
  readonly uniforms: GenesisSkyUniforms
  private elapsed = 0
  private cubeTextures: THREE.CubeTexture[] = []

  constructor() {
    this.uniforms = {
      uZenitColor: { value: new THREE.Color() },
      uHorizonColor: { value: new THREE.Color() },
      uNadirColor: { value: new THREE.Color() },
      uSunColor: { value: new THREE.Color() },
      uRimColor: { value: new THREE.Color() },
      uCloudsColor: { value: new THREE.Color() },
      uSunDirection: { value: new THREE.Vector3(0, 1, 0) },
      uMoonDirection: { value: new THREE.Vector3(0, -1, 0) },
      uMoonMask: { value: 0 },
      uSunSize: { value: 0.1 },
      uSunRadiance: { value: 0 },
      uSunDiscCutoff: { value: FIXED_SUN_DISC_CUTOFF },
      uSunDiscCoreGain: { value: FIXED_SUN_DISC_CORE_GAIN },
      uSunDiscGlowGain: { value: FIXED_SUN_DISC_GLOW_GAIN },
      uCloudHighlights: { value: 0.8 },
      uCloudDensity: { value: 0.52 },
      uCloudOpacity: { value: 1 },
      uCloudsRotationSpeed: { value: 0.01 },
      uTime: { value: 0 },
      uMoonMap: { value: null },
      uStarsMap: { value: null },
      uFarCloudsCube: { value: null },
      uNearCloudsCube: { value: null },
      uHorizonCloudsCube: { value: null },
      uTopCloudsCube: { value: null }
    }

    this.material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: SKY_VERTEX,
      fragmentShader: SKY_FRAGMENT,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      toneMapped: false
    })

    const geometry = new THREE.SphereGeometry(400, 64, 32)
    this.mesh = new THREE.Mesh(geometry, this.material)
    this.mesh.frustumCulled = false
    this.mesh.renderOrder = -1000

  }

  async loadTextures(): Promise<void> {
    const loader = new THREE.TextureLoader()
    const [moon, stars, farClouds, nearClouds, horizonClouds, topClouds] = await Promise.all([
      loader.loadAsync(ENVIRONMENT_TEXTURES.moon),
      loader.loadAsync(ENVIRONMENT_TEXTURES.stars),
      loadCrossCubemap(ENVIRONMENT_TEXTURES.farClouds),
      loadCrossCubemap(ENVIRONMENT_TEXTURES.nearClouds),
      loadCrossCubemap(ENVIRONMENT_TEXTURES.horizonClouds),
      loadCrossCubemap(ENVIRONMENT_TEXTURES.topClouds)
    ])

    for (const tex of [moon, stars]) {
      tex.colorSpace = THREE.SRGBColorSpace
      tex.wrapS = THREE.RepeatWrapping
      tex.wrapT = THREE.ClampToEdgeWrapping
    }

    const maxAniso = 8
    for (const cube of [farClouds, nearClouds, horizonClouds, topClouds]) {
      cube.anisotropy = maxAniso
    }

    this.cubeTextures = [farClouds, nearClouds, horizonClouds, topClouds]
    this.uniforms.uMoonMap.value = moon
    this.uniforms.uStarsMap.value = stars
    this.uniforms.uFarCloudsCube.value = farClouds
    this.uniforms.uNearCloudsCube.value = nearClouds
    this.uniforms.uHorizonCloudsCube.value = horizonClouds
    this.uniforms.uTopCloudsCube.value = topClouds
  }

  update(
    seconds: number,
    celestialDir: THREE.Vector3,
    delta: number,
    freezeClouds = false
  ): void {
    this.elapsed += delta
    const t = normalizedTimeOfDay(seconds)
    const g = sampleSkyGradients(t)
    const day = isSunPeriod(seconds)

    this.uniforms.uZenitColor.value.copy(g.zenit)
    this.uniforms.uHorizonColor.value.copy(g.horizon)
    this.uniforms.uNadirColor.value.copy(g.nadir)
    this.uniforms.uSunColor.value.copy(g.sun)
    this.uniforms.uRimColor.value.copy(g.rim)
    this.uniforms.uCloudsColor.value.copy(g.clouds)
    this.uniforms.uSunDirection.value.copy(day ? celestialDir : _zeroSun)
    // Night: moon follows celestial arc (same SunCycle half that is not the sun).
    this.uniforms.uMoonDirection.value.copy(day ? _zeroSun : celestialDir)
    // Unity _Moon_Mask_Size ~0.16 overnight; 0 by day. Always enable disc when night
    // (gradient moonMask was 0 for most of 06:00–20:00 including some dark hours).
    this.uniforms.uMoonMask.value = day ? 0 : Math.max(g.moonMask, 0.16)
    // Disc visual only — do not scale with scene SUN_BRIGHTNESS.
    this.uniforms.uSunRadiance.value = day ? Math.max(0.15, g.sunRadiance + 0.25) : 0
    this.uniforms.uCloudHighlights.value = g.cloudHighlights
    this.uniforms.uTime.value = freezeClouds ? 0 : this.elapsed
  }

  dispose(): void {
    this.mesh.geometry.dispose()
    this.material.dispose()
    this.uniforms.uMoonMap.value?.dispose()
    this.uniforms.uStarsMap.value?.dispose()
    for (const cube of this.cubeTextures) cube.dispose()
    this.cubeTextures = []
  }
}

export type SkyLightingSample = ReturnType<typeof sampleSkyGradients>

export function sampleSkyGradientsAt(seconds: number): SkyLightingSample {
  return sampleSkyGradients(normalizedTimeOfDay(seconds))
}
