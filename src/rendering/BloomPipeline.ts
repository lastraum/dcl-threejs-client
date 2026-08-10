import * as THREE from 'three'
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js'
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js'
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js'

/**
 * Bloom post-process — two modes:
 *
 * **fast** (1× geometry): beauty RenderPass → UnrealBloomPass → OutputPass.
 *   Classic three.js path. Bright pixels (emissives + lit highlights) glow.
 *   No material swap, no second full-scene draw.
 *
 * **selective** (2× geometry): emissive-only extract (half-res) + beauty + additive
 *   composite. Extract blacks non-emissives for depth occlusion so neon does not
 *   x-ray through walls. More correct for muzzle/LED, much more expensive.
 *
 * Extract resolution is half of the beauty buffer (pixel area ÷4) — blur does not
 * need full-res and this is the main selective-path GPU win.
 */
export type BloomMode = 'fast' | 'selective'

export type BloomPipelineOptions = {
  enabled: boolean
  hdr: boolean
  mode: BloomMode
  /** Film scale on top of material radiance. */
  strength: number
  radius: number
  threshold: number
}

const DEFAULT_STRENGTH = 0.12
const DEFAULT_RADIUS = 0.28
/** Selective extract — only true emissive isolation; keep low. */
const DEFAULT_THRESHOLD = 0.12
/**
 * Fast mode (luminance bloom on full beauty buffer): outdoor sun + ACES midtones often
 * sit above 0.5–0.7 HDR. Threshold must stay high or the whole scene blooms chalk-white
 * (Explorer: bloom is emissive/highlight only, not sunlit albedo).
 */
const FAST_THRESHOLD = 0.92
const MIN_EMISSIVE_RADIANCE = 0.08
/** Selective extract / bloom mips at this fraction of beauty resolution. */
const EXTRACT_SCALE = 0.5

const _black = new THREE.Color(0x000000)
const _hidden: THREE.Object3D[] = []

type LightSave = { light: THREE.Light; intensity: number }
type StandardSave = {
  mat: THREE.MeshStandardMaterial | THREE.MeshPhysicalMaterial
  color: THREE.Color
  metalness: number
  roughness: number
  envMapIntensity: number
}
type MeshMaterialSave = {
  mesh: THREE.Mesh
  material: THREE.Material | THREE.Material[]
}

type BloomPassInternal = UnrealBloomPass & {
  renderTargetsHorizontal: THREE.WebGLRenderTarget[]
}

function isPbrMaterial(
  mat: THREE.Material
): mat is THREE.MeshStandardMaterial | THREE.MeshPhysicalMaterial {
  return (
    (mat as THREE.MeshStandardMaterial).isMeshStandardMaterial === true ||
    (mat as THREE.MeshPhysicalMaterial).isMeshPhysicalMaterial === true
  )
}

/** Authored emissive radiance from glTF / ECS materials (0 = do not bloom). */
export function materialEmissiveRadiance(mat: THREE.Material): number {
  const ud = mat.userData as Record<string, unknown>
  if (ud.dclBloomExclude === true) return 0

  // Cached at material load / apply — avoids re-scanning maps every extract frame.
  if (typeof ud.dclBloomRadiance === 'number') {
    return ud.dclBloomRadiance as number
  }

  if (isPbrMaterial(mat)) {
    const luma = mat.emissive.r + mat.emissive.g + mat.emissive.b
    const intensity = mat.emissiveIntensity ?? 1
    if (mat.emissiveMap && intensity > 0) {
      return Math.max(luma * intensity, intensity * 0.35)
    }
    return luma * intensity
  }

  if ((mat as THREE.MeshBasicMaterial).isMeshBasicMaterial) {
    const basic = mat as THREE.MeshBasicMaterial
    if (ud.dclUntexturedGlowBlend === true || ud.dclSceneNeonTuned === true) {
      return basic.color.r + basic.color.g + basic.color.b
    }
    if (!basic.map && basic.toneMapped === false) {
      const c = basic.color.r + basic.color.g + basic.color.b
      if (c > 0.4) return c
    }
    return 0
  }

  return 0
}

/** Stamp radiance cache after emissive tuning (call from material load paths). */
export function cacheMaterialBloomRadiance(mat: THREE.Material): void {
  const ud = mat.userData as Record<string, unknown>
  // Clear first so materialEmissiveRadiance recomputes from authored channels.
  delete ud.dclBloomRadiance
  ud.dclBloomRadiance = materialEmissiveRadiance(mat)
}

export class BloomPipeline {
  private bloomComposer: EffectComposer | null = null
  private finalComposer: EffectComposer | null = null
  private bloomPass: BloomPassInternal | null = null
  private compositeQuad: FullScreenQuad | null = null
  private compositeMaterial: THREE.MeshBasicMaterial | null = null
  /** Fast path: single composer (beauty + bloom + output). */
  private fastComposer: EffectComposer | null = null
  private fastBloomPass: UnrealBloomPass | null = null
  private readonly resolution = new THREE.Vector2(1, 1)
  private opts: BloomPipelineOptions = {
    enabled: false,
    hdr: true,
    mode: 'fast',
    strength: DEFAULT_STRENGTH,
    radius: DEFAULT_RADIUS,
    threshold: DEFAULT_THRESHOLD
  }
  private savedBackground: THREE.Scene['background'] = null
  private readonly lightSaves: LightSave[] = []
  private readonly standardSaves: StandardSave[] = []
  private readonly meshMaterialSaves: MeshMaterialSave[] = []
  /** Opaque black occluder — writes depth so emissives cannot x-ray through props. */
  private readonly blackOccluder = new THREE.MeshBasicMaterial({
    color: 0x000000,
    toneMapped: false,
    transparent: false,
    depthTest: true,
    depthWrite: true,
    side: THREE.DoubleSide
  })

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    private readonly scene: THREE.Scene,
    private readonly camera: THREE.Camera
  ) {}

  isActive(): boolean {
    if (!this.opts.enabled) return false
    if (this.opts.mode === 'fast') return this.fastComposer != null
    return this.bloomComposer != null && this.finalComposer != null
  }

  getOptions(): BloomPipelineOptions {
    return { ...this.opts }
  }

  getMode(): BloomMode {
    return this.opts.mode
  }

  configure(
    options: Partial<BloomPipelineOptions>,
    widthPx: number,
    heightPx: number,
    pixelRatio: number
  ): void {
    const next: BloomPipelineOptions = {
      enabled: options.enabled ?? this.opts.enabled,
      hdr: options.hdr ?? this.opts.hdr,
      mode: options.mode ?? this.opts.mode,
      strength: options.strength ?? this.opts.strength,
      radius: options.radius ?? this.opts.radius,
      threshold: options.threshold ?? this.opts.threshold
    }

    const w = Math.max(1, Math.floor(widthPx * pixelRatio))
    const h = Math.max(1, Math.floor(heightPx * pixelRatio))
    this.resolution.set(w, h)

    const needRebuild =
      next.enabled !== this.opts.enabled ||
      next.hdr !== this.opts.hdr ||
      next.mode !== this.opts.mode ||
      this.resolutionChanged(w, h, next.mode)

    this.opts = next

    if (!next.enabled) {
      this.disposeComposers()
      return
    }

    if (needRebuild) {
      this.disposeComposers()
      if (next.mode === 'fast') {
        this.buildFastComposer(w, h, next.hdr)
      } else {
        this.buildSelectiveComposers(w, h, next.hdr)
      }
    }

    this.applyPassParams(w, h)
  }

  /**
   * Draw bloom path. Returns sub-timings for MainFrameHud (ms wall).
   * - fast: beauty+bloom+output in one composer → all in `beautyMs`
   * - selective: extract (prep+half-res) / beauty / composite split
   */
  render(): { extractMs: number; beautyMs: number; compositeMs: number; mode: BloomMode } {
    if (!this.opts.enabled) {
      return { extractMs: 0, beautyMs: 0, compositeMs: 0, mode: this.opts.mode }
    }
    if (this.opts.mode === 'fast') {
      const t0 = performance.now()
      this.renderFast()
      return {
        extractMs: 0,
        beautyMs: performance.now() - t0,
        compositeMs: 0,
        mode: 'fast'
      }
    }
    return this.renderSelectiveTimed()
  }

  dispose(): void {
    this.disposeComposers()
    this.blackOccluder.dispose()
  }

  private resolutionChanged(w: number, h: number, mode: BloomMode): boolean {
    if (mode === 'fast') {
      return !this.fastComposer || this.fastComposer.writeBuffer.width !== w || this.fastComposer.writeBuffer.height !== h
    }
    const ew = Math.max(1, Math.floor(w * EXTRACT_SCALE))
    const eh = Math.max(1, Math.floor(h * EXTRACT_SCALE))
    return (
      !this.bloomComposer ||
      !this.finalComposer ||
      this.bloomComposer.writeBuffer.width !== ew ||
      this.bloomComposer.writeBuffer.height !== eh ||
      this.finalComposer.writeBuffer.width !== w ||
      this.finalComposer.writeBuffer.height !== h
    )
  }

  private applyPassParams(w: number, h: number): void {
    if (this.fastBloomPass) {
      this.fastBloomPass.strength = this.opts.strength
      this.fastBloomPass.radius = this.opts.radius
      this.fastBloomPass.threshold = Math.max(this.opts.threshold, FAST_THRESHOLD)
      this.fastBloomPass.resolution.set(w, h)
    }
    this.fastComposer?.setSize(w, h)
    this.fastComposer?.setPixelRatio(1)

    const ew = Math.max(1, Math.floor(w * EXTRACT_SCALE))
    const eh = Math.max(1, Math.floor(h * EXTRACT_SCALE))
    if (this.bloomPass) {
      this.bloomPass.strength = this.opts.strength
      this.bloomPass.radius = this.opts.radius
      this.bloomPass.threshold = this.opts.threshold
      this.bloomPass.resolution.set(ew, eh)
    }
    this.bloomComposer?.setSize(ew, eh)
    this.finalComposer?.setSize(w, h)
    this.bloomComposer?.setPixelRatio(1)
    this.finalComposer?.setPixelRatio(1)
  }

  /** 1× geometry — beauty buffer feeds UnrealBloom luminance extract. */
  private renderFast(): void {
    if (!this.fastComposer) return
    this.fastComposer.render()
  }

  /** 2× geometry — half-res emissive extract + full-res beauty + additive pure bloom. */
  private renderSelectiveTimed(): {
    extractMs: number
    beautyMs: number
    compositeMs: number
    mode: BloomMode
  } {
    if (!this.bloomComposer || !this.finalComposer) {
      return { extractMs: 0, beautyMs: 0, compositeMs: 0, mode: 'selective' }
    }

    const tExtract0 = performance.now()
    this.beginBloomExtract()
    try {
      this.bloomComposer.render()
    } finally {
      this.endBloomExtract()
    }
    const extractMs = performance.now() - tExtract0

    const tBeauty0 = performance.now()
    this.finalComposer.render()
    const beautyMs = performance.now() - tBeauty0

    const tComp0 = performance.now()
    this.blitPureBloomAdditive()
    const compositeMs = performance.now() - tComp0

    return { extractMs, beautyMs, compositeMs, mode: 'selective' }
  }

  private beginBloomExtract(): void {
    this.savedBackground = this.scene.background
    this.scene.background = _black
    _hidden.length = 0
    this.lightSaves.length = 0
    this.standardSaves.length = 0
    this.meshMaterialSaves.length = 0

    this.scene.traverse((obj) => {
      if ((obj as THREE.Light).isLight) {
        const light = obj as THREE.Light
        this.lightSaves.push({ light, intensity: light.intensity })
        light.intensity = 0
        return
      }

      if (!obj.visible) return
      // Sky only — keep world geometry for depth occlusion.
      if ((obj.userData as Record<string, unknown>).dclBloomExclude === true) {
        obj.visible = false
        _hidden.push(obj)
        return
      }

      if (!(obj as THREE.Mesh).isMesh) return
      const mesh = obj as THREE.Mesh
      // Skip GPU instanced markers (no real materials under entity).
      if ((mesh.userData as Record<string, unknown>).dclInstanceMarker) return

      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
      let anyEmissive = false
      const nextMats: THREE.Material[] = []

      for (const mat of mats) {
        if (!mat) {
          nextMats.push(this.blackOccluder)
          continue
        }
        const rad = materialEmissiveRadiance(mat)
        if (rad < MIN_EMISSIVE_RADIANCE) {
          nextMats.push(this.blackOccluder)
          continue
        }
        anyEmissive = true
        if (isPbrMaterial(mat)) {
          // Only once per unique material instance (shared across clones).
          if (!this.standardSaves.some((s) => s.mat === mat)) {
            this.standardSaves.push({
              mat,
              color: mat.color.clone(),
              metalness: mat.metalness,
              roughness: mat.roughness,
              envMapIntensity: mat.envMapIntensity
            })
            // Diffuse contribution off; **keep map** so alpha/cutout still works if needed.
            // With lights at 0, only emissive × intensity reaches the buffer.
            mat.color.setRGB(0, 0, 0)
            mat.metalness = 0
            mat.roughness = 1
            mat.envMapIntensity = 0
            mat.needsUpdate = true
          }
          nextMats.push(mat)
        } else if ((mat as THREE.MeshBasicMaterial).isMeshBasicMaterial) {
          nextMats.push(mat)
        } else {
          nextMats.push(this.blackOccluder)
        }
      }

      // Always swap materials for extract so non-emissive slots are black occluders.
      this.meshMaterialSaves.push({ mesh, material: mesh.material })
      if (!anyEmissive) {
        mesh.material = Array.isArray(mesh.material)
          ? mats.map(() => this.blackOccluder)
          : this.blackOccluder
      } else {
        mesh.material = Array.isArray(mesh.material) ? nextMats : (nextMats[0] ?? this.blackOccluder)
      }
    })
  }

  private endBloomExtract(): void {
    for (const { light, intensity } of this.lightSaves) {
      light.intensity = intensity
    }
    this.lightSaves.length = 0

    // Restore material *slots* first (drop blackOccluder references).
    for (const s of this.meshMaterialSaves) {
      s.mesh.material = s.material
    }
    this.meshMaterialSaves.length = 0

    for (const s of this.standardSaves) {
      s.mat.color.copy(s.color)
      s.mat.metalness = s.metalness
      s.mat.roughness = s.roughness
      s.mat.envMapIntensity = s.envMapIntensity
      s.mat.needsUpdate = true
    }
    this.standardSaves.length = 0

    for (let i = 0; i < _hidden.length; i++) {
      _hidden[i]!.visible = true
    }
    _hidden.length = 0

    this.scene.background = this.savedBackground
    this.savedBackground = null
  }

  private blitPureBloomAdditive(): void {
    if (!this.bloomPass || !this.compositeQuad || !this.compositeMaterial) return

    const pure = this.bloomPass.renderTargetsHorizontal?.[0]
    if (!pure?.texture) return

    this.compositeMaterial.map = pure.texture
    this.compositeMaterial.needsUpdate = true

    const prevAutoClear = this.renderer.autoClear
    const prevTarget = this.renderer.getRenderTarget()
    const prevTone = this.renderer.toneMapping
    this.renderer.autoClear = false
    this.renderer.setRenderTarget(null)
    this.renderer.toneMapping = THREE.NoToneMapping
    this.compositeQuad.render(this.renderer)
    this.renderer.toneMapping = prevTone
    this.renderer.setRenderTarget(prevTarget)
    this.renderer.autoClear = prevAutoClear
  }

  private buildFastComposer(w: number, h: number, hdr: boolean): void {
    const type = hdr ? THREE.HalfFloatType : THREE.UnsignedByteType
    const rt = new THREE.WebGLRenderTarget(w, h, {
      type,
      format: THREE.RGBAFormat,
      colorSpace: THREE.LinearSRGBColorSpace,
      depthBuffer: true,
      stencilBuffer: false
    })
    rt.texture.name = 'bloom-fast'

    const composer = new EffectComposer(this.renderer, rt)
    composer.setSize(w, h)
    composer.setPixelRatio(1)
    composer.addPass(new RenderPass(this.scene, this.camera))

    const bloomPass = new UnrealBloomPass(
      new THREE.Vector2(w, h),
      this.opts.strength,
      this.opts.radius,
      Math.max(this.opts.threshold, FAST_THRESHOLD)
    )
    composer.addPass(bloomPass)
    composer.addPass(new OutputPass())

    this.fastComposer = composer
    this.fastBloomPass = bloomPass
  }

  private buildSelectiveComposers(w: number, h: number, hdr: boolean): void {
    const type = hdr ? THREE.HalfFloatType : THREE.UnsignedByteType
    const ew = Math.max(1, Math.floor(w * EXTRACT_SCALE))
    const eh = Math.max(1, Math.floor(h * EXTRACT_SCALE))

    const bloomRt = new THREE.WebGLRenderTarget(ew, eh, {
      type,
      format: THREE.RGBAFormat,
      colorSpace: THREE.LinearSRGBColorSpace,
      depthBuffer: true,
      stencilBuffer: false
    })
    bloomRt.texture.name = 'bloom-extract-half'

    const bloomComposer = new EffectComposer(this.renderer, bloomRt)
    bloomComposer.renderToScreen = false
    bloomComposer.setSize(ew, eh)
    bloomComposer.setPixelRatio(1)

    bloomComposer.addPass(new RenderPass(this.scene, this.camera))
    const bloomPass = new UnrealBloomPass(
      new THREE.Vector2(ew, eh),
      this.opts.strength,
      this.opts.radius,
      this.opts.threshold
    ) as BloomPassInternal
    bloomComposer.addPass(bloomPass)

    const finalRt = new THREE.WebGLRenderTarget(w, h, {
      type,
      format: THREE.RGBAFormat,
      colorSpace: THREE.LinearSRGBColorSpace,
      depthBuffer: true,
      stencilBuffer: false
    })
    finalRt.texture.name = 'bloom-final'

    const finalComposer = new EffectComposer(this.renderer, finalRt)
    finalComposer.setSize(w, h)
    finalComposer.setPixelRatio(1)
    finalComposer.addPass(new RenderPass(this.scene, this.camera))
    finalComposer.addPass(new OutputPass())

    const compositeMaterial = new THREE.MeshBasicMaterial({
      map: null,
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      toneMapped: false
    })
    const compositeQuad = new FullScreenQuad(compositeMaterial)

    this.bloomComposer = bloomComposer
    this.finalComposer = finalComposer
    this.bloomPass = bloomPass
    this.compositeMaterial = compositeMaterial
    this.compositeQuad = compositeQuad
  }

  private disposeComposers(): void {
    this.bloomComposer?.dispose()
    this.finalComposer?.dispose()
    this.fastComposer?.dispose()
    this.compositeMaterial?.dispose()
    this.compositeQuad?.dispose()
    this.bloomComposer = null
    this.finalComposer = null
    this.fastComposer = null
    this.fastBloomPass = null
    this.bloomPass = null
    this.compositeMaterial = null
    this.compositeQuad = null
  }
}

export const BLOOM_DEFAULTS = {
  strength: DEFAULT_STRENGTH,
  radius: DEFAULT_RADIUS,
  threshold: DEFAULT_THRESHOLD,
  extractScale: EXTRACT_SCALE,
  fastThreshold: FAST_THRESHOLD
} as const
