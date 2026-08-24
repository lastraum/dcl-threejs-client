import * as THREE from 'three'
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js'
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js'

/**
 * Bevy-shaped present: **one** geometry pass into an HDR beauty buffer,
 * then bloom is a fullscreen filter on that texture (no second scene walk).
 *
 * `mode` is kept for HUD/prefs compatibility — both paths are the same post now.
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
  private blitMaterial: THREE.MeshBasicMaterial | null = null
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
    return 'fast'
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
      mode: 'fast',
      strength: options.strength ?? this.opts.strength,
      radius: options.radius ?? this.opts.radius,
      threshold: options.threshold ?? this.opts.threshold
    }

    const w = Math.max(1, Math.floor(widthPx * pixelRatio))
    const h = Math.max(1, Math.floor(heightPx * pixelRatio))
    const sizeChanged = this.resolution.x !== w || this.resolution.y !== h
    this.resolution.set(w, h)
    this.opts = next

    if (!next.enabled) {
      this.disposeTargets()
      return
    }

    if (!this.beauty || sizeChanged || !this.bloomPass) {
      this.disposeTargets()
      this.build(w, h, next.hdr)
    }

    if (this.bloomPass) {
      const bw = Math.max(1, Math.floor(w * EXTRACT_SCALE))
      const bh = Math.max(1, Math.floor(h * EXTRACT_SCALE))
      this.bloomPass.strength = next.strength
      this.bloomPass.radius = next.radius
      this.bloomPass.threshold = Math.max(next.threshold, FAST_THRESHOLD)
      this.bloomPass.resolution.set(bw, bh)
      this.bloomPass.setSize(bw, bh)
    }
  }

  /**
   * One scene draw → HDR beauty. Bloom is Unreal mips on that texture.
   * ACES + sRGB happen on the fullscreen blit to the canvas.
   */
  render(): { extractMs: number; beautyMs: number; compositeMs: number; mode: BloomMode } {
    if (!this.opts.enabled || !this.beauty || !this.bloomPass || !this.blitQuad || !this.blitMaterial) {
      return { extractMs: 0, beautyMs: 0, compositeMs: 0, mode: 'fast' }
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
    this.blitMaterial.map = this.beauty.texture
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

    return { extractMs, beautyMs, compositeMs, mode: 'fast' }
  }

  dispose(): void {
    this.disposeTargets()
  }

  private build(w: number, h: number, hdr: boolean): void {
    const type = hdr ? THREE.HalfFloatType : THREE.UnsignedByteType
    this.beauty = new THREE.WebGLRenderTarget(w, h, {
      type,
      format: THREE.RGBAFormat,
      colorSpace: THREE.LinearSRGBColorSpace,
      depthBuffer: true,
      stencilBuffer: false
    })
    this.beauty.texture.name = 'beauty-hdr'

    this.bloomPass = new UnrealBloomPass(
      new THREE.Vector2(
        Math.max(1, Math.floor(w * EXTRACT_SCALE)),
        Math.max(1, Math.floor(h * EXTRACT_SCALE))
      ),
      this.opts.strength,
      this.opts.radius,
      Math.max(this.opts.threshold, FAST_THRESHOLD)
    )
    this.bloomPass.renderToScreen = false

    this.blitMaterial = new THREE.MeshBasicMaterial({
      map: this.beauty.texture,
      depthTest: false,
      depthWrite: false,
      toneMapped: true
    })
    this.blitQuad = new FullScreenQuad(this.blitMaterial)
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
