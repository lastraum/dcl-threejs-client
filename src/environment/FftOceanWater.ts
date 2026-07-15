import * as THREE from 'three'
import { dclToThreePos } from '../bridge/dclTransform'
import { parseParcelKey } from '../dcl/content/parseParcel'
import {
  islandCenterDcl,
  islandCenterThree,
  islandShoreLayout
} from '../dcl/landscape/islandLandscapeKeys'
import { ISLAND_BEACH_HEIGHT_CONSTANTS } from '../dcl/landscape/islandBeachHeight'
import { ISLAND_WATER_SURFACE_Y } from '../dcl/landscape/IslandShoreMaterial'
import { ClipmapGeometry } from './fftOcean/ClipmapGeometry'
import { OceanGPGPU } from './fftOcean/OceanGPGPU'
import { readFftOceanOverride, type FftOceanSettings } from './fftOcean/readFftOceanOverride'
import type { OutdoorLightingSnapshot } from './OutdoorLighting'
import { OCEAN_FRAG, OCEAN_VERT } from './fftOcean/shaders'

const FOAM_TEXTURE_URL = '/textures/foam/foam.webp'
/** Default sim rate when settings omit simulationHz (matches FFTOCEAN-tuned client cost). */
const DEFAULT_GPGPU_HZ = 15

export type FftOceanPerfSnapshot = {
  backend: 'fft-ocean'
  variant: 'open' | 'island'
  meshResolution: number
  fftResolution: number
  gpgpuPasses: number
  gpgpuHz: number
}

export type FftOceanCreateOptions = {
  mode?: 'open' | 'island'
  shoreWidthParcels?: number
  settings?: FftOceanSettings
}

let foamPromise: Promise<THREE.Texture> | null = null

function loadFoamTexture(): Promise<THREE.Texture> {
  if (!foamPromise) {
    foamPromise = new THREE.TextureLoader().loadAsync(FOAM_TEXTURE_URL).then((tex) => {
      tex.wrapS = THREE.RepeatWrapping
      tex.wrapT = THREE.RepeatWrapping
      tex.minFilter = THREE.LinearMipmapLinearFilter
      tex.needsUpdate = true
      return tex
    })
  }
  return foamPromise
}

/**
 * GPGPU FFT ocean — port of https://github.com/gioeledallapozza/FFTOCEAN
 * (clipmap + Phillips spectrum GPGPU). Tuned for DCL island/open biomes.
 * `?fftOcean=0` or `environment.water.fft: false` falls back to Water.js.
 */
export class FftOceanWater {
  readonly group = new THREE.Group()
  readonly perf: FftOceanPerfSnapshot

  private readonly mesh: THREE.Mesh
  private readonly material: THREE.ShaderMaterial
  private readonly gpgpu: OceanGPGPU
  private readonly renderer: THREE.WebGLRenderer
  private elapsed = 0
  private gpgpuTimer = 0
  private readonly gpgpuInterval: number
  private readonly baseSpecularIntensity: number
  private readonly baseVertexSpacing: number
  private readonly islandMask: boolean

  private constructor(
    mesh: THREE.Mesh,
    material: THREE.ShaderMaterial,
    gpgpu: OceanGPGPU,
    renderer: THREE.WebGLRenderer,
    settings: FftOceanSettings,
    mode: 'open' | 'island',
    baseVertexSpacing: number
  ) {
    this.group.name = mode === 'island' ? 'island-water' : 'open-ocean-water'
    this.baseVertexSpacing = baseVertexSpacing
    this.islandMask = mode === 'island'
    this.mesh = mesh
    this.material = material
    this.gpgpu = gpgpu
    this.renderer = renderer
    const simHz = settings.simulationHz > 0 ? settings.simulationHz : DEFAULT_GPGPU_HZ
    this.gpgpuInterval = 1 / simHz
    this.baseSpecularIntensity = settings.specularIntensity
    this.perf = {
      backend: 'fft-ocean',
      variant: mode,
      meshResolution: settings.meshResolution,
      fftResolution: settings.fftResolution,
      gpgpuPasses: gpgpu.passesPerUpdate(),
      gpgpuHz: simHz
    }
    this.group.add(mesh)
  }

  static async create(
    sceneParcels: string[],
    baseParcel: string,
    renderer: THREE.WebGLRenderer,
    options: FftOceanCreateOptions = {}
  ): Promise<FftOceanWater> {
    const mode = options.mode ?? 'open'
    const settings = options.settings ?? readFftOceanOverride()
    const base = parseParcelKey(baseParcel)
    const centerDcl = islandCenterDcl(sceneParcels, base)
    const centerThree = islandCenterThree(sceneParcels, base)
    const layout =
      mode === 'island'
        ? islandShoreLayout(sceneParcels, options.shoreWidthParcels ?? 1, base)
        : null
    const foam = await loadFoamTexture()

    const patchSize = 250
    const baseVertexSpacing = patchSize / settings.meshResolution

    const gpgpu = new OceanGPGPU({
      resolution: settings.fftResolution,
      patchSize,
      amplitude: settings.amplitude,
      windSpeed: settings.windSpeed,
      windDirection: settings.windDirection.clone()
    })
    gpgpu.bakeInitialSpectrum(renderer)

    const geometry = new ClipmapGeometry(
      settings.meshResolution,
      settings.clipLevels,
      baseVertexSpacing
    )
    const material = new THREE.ShaderMaterial({
      vertexShader: OCEAN_VERT,
      fragmentShader: OCEAN_FRAG,
      uniforms: {
        uTime: { value: 0 },
        uDisplacementY: { value: null },
        uDisplacementX: { value: null },
        uDisplacementZ: { value: null },
        uPatchSize: { value: patchSize },
        uViewerPos: { value: new THREE.Vector2() },
        uResolution: { value: settings.meshResolution },
        uBaseVertexSpacing: { value: baseVertexSpacing },
        uScale: { value: settings.displacementScale },
        uChoppyScale: { value: settings.choppyScale },
        uNormalScale: { value: 1.0 },
        uWaterDeep: { value: new THREE.Color(settings.waterDeep) },
        uWaterShallow: { value: new THREE.Color(settings.waterShallow) },
        uColorMinHeight: { value: -4.5 },
        uColorMaxHeight: { value: 1.5 },
        uSunPosition: { value: new THREE.Vector3(-200, 150, -500) },
        uSunColor: { value: new THREE.Color('#ffdf70') },
        /** Hemisphere/ambient fill from OutdoorLighting (linear RGB). */
        uAmbient: { value: new THREE.Vector3(0.48, 0.5, 0.52) },
        /** 0 = lights off / night-black, ~1 = full day — scales body + reflection. */
        uLightLevel: { value: 1.0 },
        uSpecularPower: { value: 250 },
        uSpecularMin: { value: 0.9 },
        uSpecularMax: { value: 0.99 },
        uSpecularIntensity: { value: settings.specularIntensity },
        uFresnelSmoothness: { value: 0.5 },
        uUseEnvMap: { value: false },
        uEnvMap: { value: null },
        uSkyHorizon: { value: new THREE.Color('#7ec8e3') },
        uSkyZenith: { value: new THREE.Color('#1a4a6e') },
        uWaterSSS: { value: new THREE.Color('#5393e6') },
        uSssPower: { value: 3.4 },
        uSssScale: { value: 2.0 },
        uSssMinHeight: { value: -0.2 },
        uSssMaxHeight: { value: 1.0 },
        uSssWrap: { value: 0.38 },
        uFoamColor: { value: new THREE.Color('#ffffff') },
        uFoamTexture: { value: foam },
        uFoamThreshold: { value: settings.foamThreshold },
        uFoamScale: { value: settings.foamScale },
        uFoamSpeed: { value: new THREE.Vector2(0.2, 0.2) },
        uFoamDistortion: { value: 1.4 },
        uFoamEdgeSoftness: { value: 0.8 },
        uFoamPower: { value: settings.foamPower },
        uIslandMask: { value: mode === 'island' },
        uIslandCenterXZ: { value: new THREE.Vector2(centerThree.x, centerThree.z) },
        uFlatRadiusM: { value: layout?.flatRadiusM ?? 0 },
        uOuterRadiusM: { value: layout?.outerRadiusM ?? 0 },
        uSnapXZ: { value: new THREE.Vector2() },
        uGroupWorldXZ: { value: new THREE.Vector2() },
        uWaterWorldY: { value: ISLAND_WATER_SURFACE_Y },
        uShoreDampWidthM: { value: ISLAND_BEACH_HEIGHT_CONSTANTS.shoreDampWidthM }
      },
      glslVersion: THREE.GLSL3,
      /**
       * Island used to be transparent + depthWrite:false for soft shore alpha.
       * That put the whole ocean in the transparent pass and let it overdraw
       * opaque/alpha-cutout scene planes in front of the water (#19).
       * Keep water in the opaque queue with depth write; shore fades via discard
       * in the fragment shader (cutout-style edge).
       */
      transparent: false,
      depthTest: true,
      depthWrite: true
    })

    const mesh = new THREE.Mesh(geometry, material)
    mesh.name = mode === 'island' ? 'island-water:fft-ocean' : 'open-ocean:fft-ocean'
    mesh.frustumCulled = false
    // After terrain/opaques (order 0) so water loses the depth test to nearer cutouts.
    mesh.renderOrder = 1

    const instance = new FftOceanWater(
      mesh,
      material,
      gpgpu,
      renderer,
      settings,
      mode,
      baseVertexSpacing
    )
    dclToThreePos(centerDcl.x, ISLAND_WATER_SURFACE_Y, centerDcl.z, instance.group.position)
    instance.syncWorldUniforms()
    if (layout) {
      instance.group.userData.outerRadiusM = layout.outerRadiusM
    }

    const initial = gpgpu.update(renderer, 0)
    material.uniforms.uDisplacementY.value = initial.displacementY
    material.uniforms.uDisplacementX.value = initial.displacementX
    material.uniforms.uDisplacementZ.value = initial.displacementZ

    console.info(
      `[ocean] FFTOCEAN active (${mode}) — mesh=${settings.meshResolution} fft=${settings.fftResolution} choppy=${settings.choppyScale} gpgpuPasses=${gpgpu.passesPerUpdate()}/frame @${instance.perf.gpgpuHz}Hz`
    )

    return instance
  }

  private syncWorldUniforms(): void {
    const u = this.material.uniforms
    ;(u.uGroupWorldXZ.value as THREE.Vector2).set(
      this.group.position.x,
      this.group.position.z
    )
    u.uWaterWorldY.value = this.group.position.y
  }

  applyOutdoorLighting(lighting: OutdoorLightingSnapshot): void {
    const u = this.material.uniforms
    const sunPos = u.uSunPosition.value as THREE.Vector3
    sunPos.copy(lighting.primaryDir).multiplyScalar(500)

    const active = lighting.isDay ? lighting.sunLight : lighting.moonLight
    const sunColor = u.uSunColor.value as THREE.Color
    sunColor.setRGB(
      THREE.MathUtils.clamp(active.x, 0, 4),
      THREE.MathUtils.clamp(active.y, 0, 4),
      THREE.MathUtils.clamp(active.z, 0, 4)
    )

    const ambient = u.uAmbient.value as THREE.Vector3
    ambient.copy(lighting.ambient)

    // Directional + ambient magnitude — day sunLight ~2–3, night moon ~0.2–0.5, celestials-off ~0.
    const key = Math.max(active.length(), lighting.ambient.length())
    const lightLevel = THREE.MathUtils.clamp(key / 1.35, 0, 1.35)
    u.uLightLevel.value = lightLevel

    // Dim sky reflection with overall light (sky gradient hues alone stay bright at midnight).
    const skyScale = THREE.MathUtils.clamp(lightLevel, 0, 1)
    ;(u.uSkyHorizon.value as THREE.Color).copy(lighting.skyHorizon).multiplyScalar(skyScale)
    ;(u.uSkyZenith.value as THREE.Color).copy(lighting.skyZenith).multiplyScalar(skyScale)

    // Specular tracks light power, scaled from scene/default base intensity.
    const lit = THREE.MathUtils.clamp(active.length() * 2.4, 0, 5.5)
    const base = this.baseSpecularIntensity
    // Map base 4.7 → full lit curve; other bases scale proportionally.
    u.uSpecularIntensity.value = THREE.MathUtils.clamp((lit * base) / 4.7, 0, 8)
  }

  update(delta: number, camera: THREE.Camera): void {
    this.elapsed += delta
    const u = this.material.uniforms
    u.uTime.value = this.elapsed

    const relX = camera.position.x - this.group.position.x
    const relZ = camera.position.z - this.group.position.z
    ;(u.uViewerPos.value as THREE.Vector2).set(relX, relZ)

    this.syncWorldUniforms()

    if (this.islandMask) {
      const snap = this.baseVertexSpacing
      ;(u.uSnapXZ.value as THREE.Vector2).set(
        Math.floor(relX / snap) * snap,
        Math.floor(relZ / snap) * snap
      )
    }

    this.gpgpuTimer += delta
    if (this.gpgpuTimer >= this.gpgpuInterval) {
      const { displacementY, displacementX, displacementZ } = this.gpgpu.update(
        this.renderer,
        this.elapsed
      )
      u.uDisplacementY.value = displacementY
      u.uDisplacementX.value = displacementX
      u.uDisplacementZ.value = displacementZ
      this.gpgpuTimer %= this.gpgpuInterval
    }
  }

  dispose(): void {
    this.mesh.geometry.dispose()
    this.material.dispose()
    this.gpgpu.dispose()
    this.group.removeFromParent()
  }
}