import * as THREE from 'three'
import { loadCrossCubemap } from './crossCubemap'
import { sampleSkyGradients } from './skyGradients'
import { normalizedTimeOfDay, SUN_BRIGHTNESS } from './skyboxTime'
import { isSunPeriod } from './sunCycleSampler'
import {
  FIXED_SUN_DISC_CORE_GAIN,
  FIXED_SUN_DISC_CUTOFF,
  FIXED_SUN_DISC_GLOW_GAIN
} from '../rendering/SunEnvironmentSettings'

const SKY_VERTEX = /* glsl */ `
varying vec3 vWorldPosition;
void main() {
  vec4 worldPos = modelMatrix * vec4(position, 1.0);
  vWorldPosition = worldPos.xyz;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
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

varying vec3 vWorldPosition;

vec3 sampleGradient(vec3 dir, vec3 zenit, vec3 horizon, vec3 nadir) {
  float y = clamp(dir.y, -1.0, 1.0);
  float t = y * 0.5 + 0.5;
  vec3 upBlend = mix(horizon, zenit, pow(t, 0.65));
  vec3 downBlend = mix(horizon, nadir, pow(1.0 - t, 0.55));
  return y >= 0.0 ? upBlend : downBlend;
}

vec3 celestialDisc(vec3 dir, vec3 lightDir, sampler2D map, float mask, float size, vec3 tint, float glow) {
  if (mask <= 0.001) return vec3(0.0);
  float d = dot(normalize(dir), normalize(lightDir));
  float core = smoothstep(1.0 - size * 0.015, 1.0 - size * 0.002, d);
  float halo = pow(max(d, 0.0), 24.0) * glow;
  vec2 uv = vec2(atan(dir.z, dir.x) / 6.2831853 + 0.5, dir.y * 0.5 + 0.5);
  vec4 tex = texture2D(map, uv * 2.0);
  return tint * (core * 2.5 + halo * 0.8) * tex.a * mask;
}

vec3 sunDisc(vec3 dir, vec3 sunDir, vec3 sunColor, float radiance) {
  vec3 sDir = normalize(sunDir);
  float d = dot(normalize(dir), sDir);
  float glowReach = uSunDiscCutoff - mix(0.0, 0.028, uSunDiscGlowGain);
  if (d < glowReach) return vec3(0.0);

  float ang = acos(clamp(d, -1.0, 1.0));
  float coreEdge = acos(clamp(uSunDiscCutoff, -1.0, 1.0));
  float core = 1.0 - smoothstep(0.0, max(coreEdge * 0.9, 0.0008), ang);
  core = pow(max(core, 0.0), 1.35);

  float glowAmt = uSunDiscGlowGain;
  float innerSpread = mix(0.006, 0.055, glowAmt);
  float outerSpread = max(innerSpread * 4.0, 0.01);
  float corona = exp(-ang / innerSpread) * glowAmt * (1.4 + radiance * 1.1);
  float bloom = exp(-ang / outerSpread) * glowAmt * (0.55 + radiance * 0.45);

  vec3 warm = sunColor * vec3(1.15, 1.02, 0.88);
  float rad = 0.4 + radiance * 0.75;
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
  vec3 dir = normalize(vWorldPosition);
  vec3 sky = sampleGradient(dir, uZenitColor, uHorizonColor, uNadirColor);

  float night = 1.0 - smoothstep(-0.08, 0.12, uSunDirection.y);
  sky += starField(dir, uStarsMap, night);
  sky += sunDisc(dir, uSunDirection, uSunColor, uSunRadiance);
  sky += celestialDisc(dir, uMoonDirection, uMoonMap, uMoonMask, 0.16, vec3(1.2), 1.4);

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

  async loadTextures(baseUrl = '/environment/'): Promise<void> {
    const loader = new THREE.TextureLoader()
    const [moon, stars, farClouds, nearClouds, horizonClouds, topClouds] = await Promise.all([
      loader.loadAsync(`${baseUrl}SkyboxMoon.png`),
      loader.loadAsync(`${baseUrl}SkyboxStars.png`),
      loadCrossCubemap(`${baseUrl}SkyboxFarClouds.png`),
      loadCrossCubemap(`${baseUrl}SkyboxNearClouds.png`),
      loadCrossCubemap(`${baseUrl}horizon_clouds2.png`),
      loadCrossCubemap(`${baseUrl}top_clouds.png`)
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
    this.uniforms.uMoonDirection.value.copy(day ? _zeroSun : celestialDir)
    this.uniforms.uMoonMask.value = day ? 0 : g.moonMask
    this.uniforms.uSunRadiance.value = day ? g.sunRadiance * SUN_BRIGHTNESS : 0
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
