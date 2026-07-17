import * as THREE from 'three'
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js'
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js'

/**
 * Full-screen Unreal-style bloom for Explorer emissive / muzzle parity.
 * Uses HalfFloat when HDR is on so bright untextured VFX aren't clipped before bloom.
 *
 * Tone mapping / color space: leave renderer.toneMapping set; OutputPass reads them.
 * SceneHost should not blit MSAA when this pipeline is active.
 */
export type BloomPipelineOptions = {
  enabled: boolean
  /** Prefer HalfFloat color buffer (wider range for bloom). */
  hdr: boolean
  strength: number
  radius: number
  threshold: number
}

const DEFAULT_STRENGTH = 0.55
const DEFAULT_RADIUS = 0.42
const DEFAULT_THRESHOLD = 0.72

export class BloomPipeline {
  private composer: EffectComposer | null = null
  private bloomPass: UnrealBloomPass | null = null
  private readonly resolution = new THREE.Vector2(1, 1)
  private opts: BloomPipelineOptions = {
    enabled: false,
    hdr: true,
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
    return this.opts.enabled && this.composer != null
  }

  getOptions(): BloomPipelineOptions {
    return { ...this.opts }
  }

  /**
   * Rebuild or update passes from quality prefs + viewport size (CSS px × pixel ratio).
   */
  configure(
    options: Partial<BloomPipelineOptions>,
    widthPx: number,
    heightPx: number,
    pixelRatio: number
  ): void {
    const next: BloomPipelineOptions = {
      enabled: options.enabled ?? this.opts.enabled,
      hdr: options.hdr ?? this.opts.hdr,
      strength: options.strength ?? this.opts.strength,
      radius: options.radius ?? this.opts.radius,
      threshold: options.threshold ?? this.opts.threshold
    }

    const w = Math.max(1, Math.floor(widthPx * pixelRatio))
    const h = Math.max(1, Math.floor(heightPx * pixelRatio))
    this.resolution.set(w, h)

    const needRebuild =
      !this.composer ||
      next.enabled !== this.opts.enabled ||
      next.hdr !== this.opts.hdr ||
      this.composer.writeBuffer.width !== w ||
      this.composer.writeBuffer.height !== h

    this.opts = next

    if (!next.enabled) {
      this.disposeComposer()
      return
    }

    if (needRebuild) {
      this.disposeComposer()
      this.buildComposer(w, h, next.hdr)
    }

    if (this.bloomPass) {
      this.bloomPass.strength = next.strength
      this.bloomPass.radius = next.radius
      this.bloomPass.threshold = next.threshold
      this.bloomPass.resolution.set(w, h)
    }
    this.composer?.setSize(w, h)
    this.composer?.setPixelRatio(1) // sizes already include pixel ratio
  }

  render(): void {
    if (!this.composer || !this.opts.enabled) return
    this.composer.render()
  }

  dispose(): void {
    this.disposeComposer()
  }

  private buildComposer(w: number, h: number, hdr: boolean): void {
    const rt = new THREE.WebGLRenderTarget(w, h, {
      type: hdr ? THREE.HalfFloatType : THREE.UnsignedByteType,
      format: THREE.RGBAFormat,
      colorSpace: THREE.LinearSRGBColorSpace,
      depthBuffer: true,
      stencilBuffer: false
    })
    rt.texture.name = 'bloom-composer'

    const composer = new EffectComposer(this.renderer, rt)
    composer.setSize(w, h)
    composer.setPixelRatio(1)

    const renderPass = new RenderPass(this.scene, this.camera)
    const bloomPass = new UnrealBloomPass(
      new THREE.Vector2(w, h),
      this.opts.strength,
      this.opts.radius,
      this.opts.threshold
    )
    const outputPass = new OutputPass()

    composer.addPass(renderPass)
    composer.addPass(bloomPass)
    composer.addPass(outputPass)

    this.composer = composer
    this.bloomPass = bloomPass
  }

  private disposeComposer(): void {
    if (this.composer) {
      // EffectComposer dispose frees internal read/write targets.
      this.composer.dispose()
    }
    this.composer = null
    this.bloomPass = null
  }
}

export const BLOOM_DEFAULTS = {
  strength: DEFAULT_STRENGTH,
  radius: DEFAULT_RADIUS,
  threshold: DEFAULT_THRESHOLD
} as const
