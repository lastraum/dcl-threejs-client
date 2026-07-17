import * as THREE from 'three'
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js'
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js'
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js'

/**
 * Selective Unreal bloom — emissives / VFX glow without nuking sky + clouds.
 *
 * 1. Hide `userData.dclBloomExclude` (Genesis sky dome) + black background
 * 2. RenderPass → UnrealBloomPass (extract pure bloom mips, not scene+bloom)
 * 3. Restore sky
 * 4. Full scene + OutputPass (ACES) to screen
 * 5. Additive composite pure bloom texture only
 *
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

/** Mild — only near-white / HDR emissives should cross the threshold. */
const DEFAULT_STRENGTH = 0.22
const DEFAULT_RADIUS = 0.3
const DEFAULT_THRESHOLD = 0.9

const _black = new THREE.Color(0x000000)
const _hidden: THREE.Object3D[] = []

/** UnrealBloomPass keeps pure bloom composite in horizontal mip 0 before additive scene blend. */
type BloomPassInternal = UnrealBloomPass & {
  renderTargetsHorizontal: THREE.WebGLRenderTarget[]
}

export class BloomPipeline {
  private bloomComposer: EffectComposer | null = null
  private finalComposer: EffectComposer | null = null
  private bloomPass: BloomPassInternal | null = null
  private compositeQuad: FullScreenQuad | null = null
  private compositeMaterial: THREE.MeshBasicMaterial | null = null
  private readonly resolution = new THREE.Vector2(1, 1)
  private opts: BloomPipelineOptions = {
    enabled: false,
    hdr: true,
    strength: DEFAULT_STRENGTH,
    radius: DEFAULT_RADIUS,
    threshold: DEFAULT_THRESHOLD
  }
  private savedBackground: THREE.Scene['background'] = null

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    private readonly scene: THREE.Scene,
    private readonly camera: THREE.Camera
  ) {}

  isActive(): boolean {
    return this.opts.enabled && this.bloomComposer != null && this.finalComposer != null
  }

  getOptions(): BloomPipelineOptions {
    return { ...this.opts }
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
      strength: options.strength ?? this.opts.strength,
      radius: options.radius ?? this.opts.radius,
      threshold: options.threshold ?? this.opts.threshold
    }

    const w = Math.max(1, Math.floor(widthPx * pixelRatio))
    const h = Math.max(1, Math.floor(heightPx * pixelRatio))
    this.resolution.set(w, h)

    const needRebuild =
      !this.bloomComposer ||
      !this.finalComposer ||
      next.enabled !== this.opts.enabled ||
      next.hdr !== this.opts.hdr ||
      this.bloomComposer.writeBuffer.width !== w ||
      this.bloomComposer.writeBuffer.height !== h

    this.opts = next

    if (!next.enabled) {
      this.disposeComposers()
      return
    }

    if (needRebuild) {
      this.disposeComposers()
      this.buildComposers(w, h, next.hdr)
    }

    if (this.bloomPass) {
      this.bloomPass.strength = next.strength
      this.bloomPass.radius = next.radius
      this.bloomPass.threshold = next.threshold
      this.bloomPass.resolution.set(w, h)
    }
    this.bloomComposer?.setSize(w, h)
    this.finalComposer?.setSize(w, h)
    this.bloomComposer?.setPixelRatio(1)
    this.finalComposer?.setPixelRatio(1)
  }

  render(): void {
    if (!this.bloomComposer || !this.finalComposer || !this.opts.enabled) return

    // Extract bloom from world only (no sky / no clear-color glow)
    this.beginBloomExtract()
    this.bloomComposer.render()
    this.endBloomExtract()

    // Full scene with tone mapping → canvas
    this.finalComposer.render()

    // Pure bloom halo only (not the dim scene buffer)
    this.blitPureBloomAdditive()
  }

  dispose(): void {
    this.disposeComposers()
  }

  private beginBloomExtract(): void {
    this.savedBackground = this.scene.background
    this.scene.background = _black
    _hidden.length = 0
    this.scene.traverse((obj) => {
      if (!obj.visible) return
      if ((obj.userData as Record<string, unknown>).dclBloomExclude === true) {
        obj.visible = false
        _hidden.push(obj)
      }
    })
  }

  private endBloomExtract(): void {
    for (let i = 0; i < _hidden.length; i++) {
      _hidden[i]!.visible = true
    }
    _hidden.length = 0
    this.scene.background = this.savedBackground
    this.savedBackground = null
  }

  private blitPureBloomAdditive(): void {
    if (!this.bloomPass || !this.compositeQuad || !this.compositeMaterial) return

    // Pure bloom composite (before UnrealBloomPass additive-blends onto the scene buffer).
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

  private buildComposers(w: number, h: number, hdr: boolean): void {
    const type = hdr ? THREE.HalfFloatType : THREE.UnsignedByteType

    const bloomRt = new THREE.WebGLRenderTarget(w, h, {
      type,
      format: THREE.RGBAFormat,
      colorSpace: THREE.LinearSRGBColorSpace,
      depthBuffer: true,
      stencilBuffer: false
    })
    bloomRt.texture.name = 'bloom-extract'

    const bloomComposer = new EffectComposer(this.renderer, bloomRt)
    bloomComposer.renderToScreen = false
    bloomComposer.setSize(w, h)
    bloomComposer.setPixelRatio(1)

    bloomComposer.addPass(new RenderPass(this.scene, this.camera))
    const bloomPass = new UnrealBloomPass(
      new THREE.Vector2(w, h),
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
    this.compositeMaterial?.dispose()
    this.compositeQuad?.dispose()
    this.bloomComposer = null
    this.finalComposer = null
    this.bloomPass = null
    this.compositeMaterial = null
    this.compositeQuad = null
  }
}

export const BLOOM_DEFAULTS = {
  strength: DEFAULT_STRENGTH,
  radius: DEFAULT_RADIUS,
  threshold: DEFAULT_THRESHOLD
} as const
