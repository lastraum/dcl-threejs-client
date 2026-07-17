import * as THREE from 'three'
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js'
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js'
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js'

/**
 * Emissive-driven selective bloom with depth occlusion.
 *
 * Extract pass:
 * - Sky / `dclBloomExclude` hidden (no sky bloom)
 * - Lights zeroed (lit albedo does not bloom)
 * - Non-emissive meshes stay **visible** as opaque black (write depth so occluders
 *   block emissives — no x-ray through walls/obelisks)
 * - Emissive PBR: diffuse black, **map left intact** (alpha/cutouts); only emissive
 *   channel contributes with lights off
 *
 * Final: full scene + OutputPass, then additive pure-bloom composite.
 */
export type BloomPipelineOptions = {
  enabled: boolean
  hdr: boolean
  /** Film scale on top of material radiance. */
  strength: number
  radius: number
  threshold: number
}

const DEFAULT_STRENGTH = 0.12
const DEFAULT_RADIUS = 0.28
const DEFAULT_THRESHOLD = 0.05
const MIN_EMISSIVE_RADIANCE = 0.08

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
    this.blackOccluder.dispose()
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
