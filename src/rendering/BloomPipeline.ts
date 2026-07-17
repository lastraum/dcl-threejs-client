import * as THREE from 'three'
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js'
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js'
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js'

/**
 * Emissive-driven selective bloom.
 *
 * Bloom extract renders **only authored emissive energy**:
 * - Sky / `dclBloomExclude` hidden
 * - Scene lights zeroed (so lit albedo does not bloom)
 * - Non-emissive MeshBasic darkened
 * - PBR materials keep `emissive × emissiveIntensity` (+ emissiveMap); diffuse forced black
 *
 * UnrealBloomPass strength/threshold are mild film scales — how much each surface
 * glows is determined by the GLB emissiveFactor / material intensity, not hard-coded
 * per-scene brightness.
 */
export type BloomPipelineOptions = {
  enabled: boolean
  /** Prefer HalfFloat color buffer (wider range for bloom). */
  hdr: boolean
  /**
   * Film scale on top of material radiance (not a creative “how bright is bloom”).
   * Final bloom ∝ material emissive × intensity × this scale.
   */
  strength: number
  radius: number
  /**
   * High-pass floor in extract space. With lights off, only emissives are bright;
   * keep this low so weak authored emissives still contribute.
   */
  threshold: number
}

/**
 * Mild film scales — radiance comes from materials.
 * strength multiplies UnrealBloom composite; keep small so emissiveIntensity 1–12 maps reasonably.
 */
const DEFAULT_STRENGTH = 0.12
const DEFAULT_RADIUS = 0.28
/** Low: extract is emissive-only; let material intensity decide contribution. */
const DEFAULT_THRESHOLD = 0.05

/** Min emissive radiance (luma × intensity) to keep in the extract buffer. */
const MIN_EMISSIVE_RADIANCE = 0.08

const _black = new THREE.Color(0x000000)
const _hidden: THREE.Object3D[] = []

type LightSave = { light: THREE.Light; intensity: number }
type StandardSave = {
  mat: THREE.MeshStandardMaterial | THREE.MeshPhysicalMaterial
  color: THREE.Color
  map: THREE.Texture | null
  metalness: number
  roughness: number
  envMapIntensity: number
}
type MeshMaterialSave = {
  mesh: THREE.Mesh
  material: THREE.Material | THREE.Material[]
}

/** UnrealBloomPass keeps pure bloom composite in horizontal mip 0 before additive scene blend. */
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

  if (isPbrMaterial(mat)) {
    const luma = mat.emissive.r + mat.emissive.g + mat.emissive.b
    const intensity = mat.emissiveIntensity ?? 1
    if (mat.emissiveMap && intensity > 0) {
      // Map-driven emissive (LED strips / flames) — intensity is the DCL scalar.
      return Math.max(luma * intensity, intensity * 0.35)
    }
    return luma * intensity
  }

  if ((mat as THREE.MeshBasicMaterial).isMeshBasicMaterial) {
    const basic = mat as THREE.MeshBasicMaterial
    // Additive VFX / neon Basic from sceneGltfEmissives (GunVFX, etc.)
    if (ud.dclUntexturedGlowBlend === true || ud.dclSceneNeonTuned === true) {
      return basic.color.r + basic.color.g + basic.color.b
    }
    // Unlit pure-color glow (no map, not tone-mapped) — rare VFX path
    if (!basic.map && basic.toneMapped === false) {
      const c = basic.color.r + basic.color.g + basic.color.b
      if (c > 0.4) return c
    }
    return 0
  }

  return 0
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
  private readonly lightSaves: LightSave[] = []
  private readonly standardSaves: StandardSave[] = []
  private readonly meshMaterialSaves: MeshMaterialSave[] = []
  private readonly blackBasic = new THREE.MeshBasicMaterial({
    color: 0x000000,
    toneMapped: false,
    depthWrite: true
  })

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

    this.beginBloomExtract()
    try {
      this.bloomComposer.render()
    } finally {
      this.endBloomExtract()
    }

    this.finalComposer.render()
    this.blitPureBloomAdditive()
  }

  dispose(): void {
    this.disposeComposers()
    this.blackBasic.dispose()
  }

  /**
   * Isolate authored emissive energy in the extract buffer:
   * lights off + non-emissives black + PBR diffuse black (emissive channel only).
   */
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
      if ((obj.userData as Record<string, unknown>).dclBloomExclude === true) {
        obj.visible = false
        _hidden.push(obj)
        return
      }

      if (!(obj as THREE.Mesh).isMesh) return
      const mesh = obj as THREE.Mesh
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
      let anyEmissive = false
      let needsMaterialSwap = false
      const nextMats: THREE.Material[] = []

      for (const mat of mats) {
        if (!mat) {
          nextMats.push(this.blackBasic)
          needsMaterialSwap = true
          continue
        }
        const rad = materialEmissiveRadiance(mat)
        if (rad < MIN_EMISSIVE_RADIANCE) {
          nextMats.push(this.blackBasic)
          needsMaterialSwap = true
          continue
        }
        anyEmissive = true
        if (isPbrMaterial(mat)) {
          this.standardSaves.push({
            mat,
            color: mat.color.clone(),
            map: mat.map,
            metalness: mat.metalness,
            roughness: mat.roughness,
            envMapIntensity: mat.envMapIntensity
          })
          // Diffuse off — only emissiveFactor × intensity (+ emissiveMap) reaches the buffer.
          mat.color.setRGB(0, 0, 0)
          mat.map = null
          mat.metalness = 0
          mat.roughness = 1
          mat.envMapIntensity = 0
          mat.needsUpdate = true
          nextMats.push(mat)
        } else if ((mat as THREE.MeshBasicMaterial).isMeshBasicMaterial) {
          // Glow Basic already encodes radiance in color — leave as authored.
          nextMats.push(mat)
        } else {
          nextMats.push(this.blackBasic)
          needsMaterialSwap = true
        }
      }

      if (!anyEmissive) {
        mesh.visible = false
        _hidden.push(mesh)
        return
      }

      if (needsMaterialSwap) {
        this.meshMaterialSaves.push({ mesh, material: mesh.material })
        mesh.material = Array.isArray(mesh.material) ? nextMats : (nextMats[0] ?? this.blackBasic)
      }
    })
  }

  private endBloomExtract(): void {
    for (const { light, intensity } of this.lightSaves) {
      light.intensity = intensity
    }
    this.lightSaves.length = 0

    // Restore material slots before property restores (same mat instances).
    for (const s of this.meshMaterialSaves) {
      s.mesh.material = s.material
    }
    this.meshMaterialSaves.length = 0

    for (const s of this.standardSaves) {
      s.mat.color.copy(s.color)
      s.mat.map = s.map
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
