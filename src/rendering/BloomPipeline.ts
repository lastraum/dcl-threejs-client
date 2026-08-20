import * as THREE from 'three'
import { UniformsUtils } from 'three'
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js'
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js'
import { FXAAShader } from 'three/examples/jsm/shaders/FXAAShader.js'

/**
 * Bevy-shaped present: **one** geometry pass into an HDR beauty buffer,
 * then bloom is a fullscreen filter on that texture (no second scene walk).
 *
 * `fast` = half-res Unreal extract. `selective` = full-res extract (heavier neon).
 * FXAA runs on the canvas blit because MSAA cannot ride the Unreal path.
 */
export type BloomMode = 'fast' | 'selective'

export type BloomPipelineOptions = {
  enabled: boolean
  hdr: boolean
  mode: BloomMode
  strength: number
  radius: number
  threshold: number
}

const DEFAULT_STRENGTH = 0.08
const DEFAULT_RADIUS = 0.22
const DEFAULT_THRESHOLD = 0.12
/** Linear HDR beauty is untonemapped — albedo-white signs sit near 1. Only HDR emissives bloom. */
const FAST_THRESHOLD = 1.6
const EXTRACT_SCALE = 0.5

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

export function cacheMaterialBloomRadiance(mat: THREE.Material): void {
  const ud = mat.userData as Record<string, unknown>
  delete ud.dclBloomRadiance
  ud.dclBloomRadiance = materialEmissiveRadiance(mat)
}

export class BloomPipeline {
  /** HDR beauty — the only geometry pass. */
  private beauty: THREE.WebGLRenderTarget | null = null
  private bloomPass: UnrealBloomPass | null = null
  private blitQuad: FullScreenQuad | null = null
  private blitMaterial: THREE.ShaderMaterial | null = null
  private readonly resolution = new THREE.Vector2(1, 1)
  private opts: BloomPipelineOptions = {
    enabled: false,
    hdr: true,
    mode: 'fast',
    strength: DEFAULT_STRENGTH,
    radius: DEFAULT_RADIUS,
    threshold: DEFAULT_THRESHOLD
  }

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    private readonly scene: THREE.Scene,
    private readonly camera: THREE.Camera
  ) {}

  isActive(): boolean {
    return this.opts.enabled && this.beauty != null && this.bloomPass != null
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
    const sizeChanged = this.resolution.x !== w || this.resolution.y !== h
    const modeChanged = next.mode !== this.opts.mode
    this.resolution.set(w, h)
    this.opts = next

    if (!next.enabled) {
      this.disposeTargets()
      return
    }

    if (!this.beauty || sizeChanged || modeChanged || !this.bloomPass) {
      this.disposeTargets()
      this.build(w, h, next)
    }

    if (this.bloomPass) {
      const extract = next.mode === 'selective' ? 1 : EXTRACT_SCALE
      const bw = Math.max(1, Math.floor(w * extract))
      const bh = Math.max(1, Math.floor(h * extract))
      this.bloomPass.strength = next.strength
      this.bloomPass.radius = next.radius
      this.bloomPass.threshold =
        next.mode === 'selective'
          ? Math.max(next.threshold, 1.15)
          : Math.max(next.threshold, FAST_THRESHOLD)
      this.bloomPass.resolution.set(bw, bh)
      this.bloomPass.setSize(bw, bh)
    }
    this.syncFxaaResolution(w, h)
  }

  /**
   * One scene draw → HDR beauty. Bloom is Unreal mips on that texture.
   * ACES + sRGB happen on the fullscreen blit to the canvas.
   */
  render(): { extractMs: number; beautyMs: number; compositeMs: number; mode: BloomMode } {
    if (!this.opts.enabled || !this.beauty || !this.bloomPass || !this.blitQuad || !this.blitMaterial) {
        return { extractMs: 0, beautyMs: 0, compositeMs: 0, mode: this.opts.mode }
    }

    const renderer = this.renderer
    const prevTarget = renderer.getRenderTarget()
    const prevTone = renderer.toneMapping
    const prevCs = renderer.outputColorSpace
    const prevAutoClear = renderer.autoClear

    const t0 = performance.now()
    renderer.toneMapping = THREE.NoToneMapping
    renderer.outputColorSpace = THREE.LinearSRGBColorSpace
    renderer.autoClear = true
    renderer.setRenderTarget(this.beauty)
    renderer.clear(true, true, true)
    renderer.render(this.scene, this.camera)
    const beautyMs = performance.now() - t0

    const t1 = performance.now()
    this.bloomPass.renderToScreen = false
    this.bloomPass.render(renderer, this.beauty, this.beauty, 0, false)
    const extractMs = performance.now() - t1

    const t2 = performance.now()
    if (this.blitMaterial.uniforms.tDiffuse) {
      this.blitMaterial.uniforms.tDiffuse.value = this.beauty.texture
    }
    renderer.setRenderTarget(null)
    renderer.toneMapping = THREE.ACESFilmicToneMapping
    renderer.outputColorSpace = THREE.SRGBColorSpace
    renderer.autoClear = true
    this.blitQuad.render(renderer)
    const compositeMs = performance.now() - t2

    renderer.setRenderTarget(prevTarget)
    renderer.toneMapping = prevTone
    renderer.outputColorSpace = prevCs
    renderer.autoClear = prevAutoClear

    return { extractMs, beautyMs, compositeMs, mode: this.opts.mode }
  }

  dispose(): void {
    this.disposeTargets()
  }

  private build(w: number, h: number, opts: BloomPipelineOptions): void {
    const type = opts.hdr ? THREE.HalfFloatType : THREE.UnsignedByteType
    this.beauty = new THREE.WebGLRenderTarget(w, h, {
      type,
      format: THREE.RGBAFormat,
      colorSpace: THREE.LinearSRGBColorSpace,
      depthBuffer: true,
      stencilBuffer: false
    })
    this.beauty.texture.name = 'beauty-hdr'

    const extract = opts.mode === 'selective' ? 1 : EXTRACT_SCALE
    this.bloomPass = new UnrealBloomPass(
      new THREE.Vector2(
        Math.max(1, Math.floor(w * extract)),
        Math.max(1, Math.floor(h * extract))
      ),
      opts.strength,
      opts.radius,
      opts.mode === 'selective'
        ? Math.max(opts.threshold, 1.15)
        : Math.max(opts.threshold, FAST_THRESHOLD)
    )
    this.bloomPass.renderToScreen = false

    this.blitMaterial = new THREE.ShaderMaterial({
      uniforms: UniformsUtils.clone(FXAAShader.uniforms),
      vertexShader: FXAAShader.vertexShader,
      fragmentShader: FXAAShader.fragmentShader,
      depthTest: false,
      depthWrite: false,
      toneMapped: true
    })
    if (this.blitMaterial.uniforms.tDiffuse) {
      this.blitMaterial.uniforms.tDiffuse.value = this.beauty.texture
    }
    this.syncFxaaResolution(w, h)
    this.blitQuad = new FullScreenQuad(this.blitMaterial)
  }

  private syncFxaaResolution(w: number, h: number): void {
    const res = this.blitMaterial?.uniforms.resolution
    if (!res) return
    res.value.set(1 / Math.max(1, w), 1 / Math.max(1, h))
  }

  private disposeTargets(): void {
    this.beauty?.dispose()
    this.bloomPass?.dispose()
    this.blitMaterial?.dispose()
    this.blitQuad?.dispose()
    this.beauty = null
    this.bloomPass = null
    this.blitMaterial = null
    this.blitQuad = null
  }
}

export const BLOOM_DEFAULTS = {
  strength: DEFAULT_STRENGTH,
  radius: DEFAULT_RADIUS,
  threshold: DEFAULT_THRESHOLD,
  extractScale: EXTRACT_SCALE,
  fastThreshold: FAST_THRESHOLD
} as const
