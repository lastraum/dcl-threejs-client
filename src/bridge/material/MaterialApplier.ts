import * as THREE from 'three'
import type { ResolvedScene } from '../../dcl/content/types'
import type { AssetCache } from '../../rendering/AssetCache'
import { isSharedAssetResource } from '../../rendering/sharedAsset'
import { resolveSceneTextureUrl } from './resolveTexture'

/** Matches `@dcl/ecs` MaterialTransparencyMode. */
const MTM_OPAQUE = 0
const MTM_ALPHA_TEST = 1
const MTM_ALPHA_BLEND = 2
const MTM_AUTO = 4

const TWM_REPEAT = 0
const TWM_MIRROR = 2

const TFM_POINT = 0
const TFM_TRILINEAR = 2

type Color4 = { r?: number; g?: number; b?: number; a?: number }
type Color3 = { r?: number; g?: number; b?: number }

type TextureDef = {
  src: string
  wrapMode?: number
  filterMode?: number
  offset?: { x?: number; y?: number }
  tiling?: { x?: number; y?: number }
}

type TextureUnion = {
  tex?:
    | { $case: 'texture'; texture: TextureDef }
    | { $case: 'avatarTexture' }
    | { $case: 'videoTexture'; videoTexture: { videoPlayerEntity: number; wrapMode?: number; filterMode?: number } }
    | undefined
}

type PbrMaterial = {
  texture?: TextureUnion
  alphaTexture?: TextureUnion
  emissiveTexture?: TextureUnion
  bumpTexture?: TextureUnion
  albedoColor?: Color4
  emissiveColor?: Color3
  alphaTest?: number
  castShadows?: boolean
  transparencyMode?: number
  metallic?: number
  roughness?: number
  emissiveIntensity?: number
}

type UnlitMaterial = {
  texture?: TextureUnion
  alphaTexture?: TextureUnion
  diffuseColor?: Color4
  alphaTest?: number
  castShadows?: boolean
}

export type PbMaterial = {
  material?:
    | { $case: 'pbr'; pbr: PbrMaterial }
    | { $case: 'unlit'; unlit: UnlitMaterial }
    | undefined
}

function wrapMode(mode?: number): THREE.Wrapping {
  if (mode === TWM_REPEAT) return THREE.RepeatWrapping
  if (mode === TWM_MIRROR) return THREE.MirroredRepeatWrapping
  return THREE.ClampToEdgeWrapping
}

function materialFingerprint(pb: PbMaterial): string {
  return JSON.stringify(pb)
}

/** Apply SDK7 Material → Three.js materials (P0 parity). */
export class MaterialApplier {
  private readonly applied = new Map<number, string>()
  private getVideoTexture: ((videoPlayerEntity: number) => THREE.Texture | null) | null = null

  constructor(
    private readonly scene: ResolvedScene,
    private readonly cache: AssetCache
  ) {}

  setVideoTextureResolver(resolver: (videoPlayerEntity: number) => THREE.Texture | null): void {
    this.getVideoTexture = resolver
  }

  async applyToObject3D(root: THREE.Object3D, entity: number, pb: PbMaterial): Promise<void> {
    const fp = materialFingerprint(pb)
    const pendingVideo = this.hasUnresolvedVideo(pb)
    if (this.applied.get(entity) === fp && !pendingVideo) return

    const meshes: THREE.Mesh[] = []
    root.traverse((child) => {
      if ((child as THREE.Mesh).isMesh) meshes.push(child as THREE.Mesh)
    })

    for (const mesh of meshes) {
      await this.applyToMesh(mesh, pb)
    }

    if (!pendingVideo) this.applied.set(entity, fp)
    else this.applied.delete(entity)
  }

  async applyToMesh(mesh: THREE.Mesh, pb: PbMaterial): Promise<void> {
    const materialCase = pb.material?.$case
    const isPbr = materialCase === 'pbr'
    const inner =
      materialCase === 'pbr'
        ? pb.material!.pbr
        : materialCase === 'unlit'
          ? pb.material!.unlit
          : undefined
    if (!inner) return

    const needsUnlit = !isPbr
    const current = mesh.material
    const reuse =
      (needsUnlit && current instanceof THREE.MeshBasicMaterial) ||
      (!needsUnlit && current instanceof THREE.MeshStandardMaterial)

    const m = reuse
      ? current
      : needsUnlit
        ? new THREE.MeshBasicMaterial({ color: 0xffffff })
        : new THREE.MeshStandardMaterial({ color: 0xffffff })

    if (!reuse) {
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
      for (const mat of materials) {
        if (mat && !isSharedAssetResource(mat)) mat.dispose()
      }
      mesh.material = m
    }

    const base = isPbr ? (inner as PbrMaterial).albedoColor : (inner as UnlitMaterial).diffuseColor
    const color = base ?? { r: 1, g: 1, b: 1, a: 1 }
    m.color.setRGB(color.r ?? 1, color.g ?? 1, color.b ?? 1)

    if (m instanceof THREE.MeshStandardMaterial) {
      const pbr = inner as PbrMaterial
      m.metalness = pbr.metallic ?? 0.5
      m.roughness = pbr.roughness ?? 0.5
      if (pbr.emissiveColor) {
        m.emissive.setRGB(pbr.emissiveColor.r ?? 0, pbr.emissiveColor.g ?? 0, pbr.emissiveColor.b ?? 0)
      } else {
        m.emissive.setRGB(0, 0, 0)
      }
      m.emissiveIntensity = pbr.emissiveIntensity ?? 1
    }

    m.map = null
    m.alphaMap = null
    if (m instanceof THREE.MeshStandardMaterial) {
      m.emissiveMap = null
      m.normalMap = null
    }

    const mainTex = await this.loadUnionTexture(inner.texture)
    if (mainTex) {
      m.map = mainTex
      this.applyUvTransform(mainTex, getTextureDef(inner.texture))
    }

    const alphaTex = await this.loadUnionTexture(inner.alphaTexture)
    if (alphaTex) {
      m.alphaMap = alphaTex
      this.applyUvTransform(alphaTex, getTextureDef(inner.alphaTexture))
    }

    if (m instanceof THREE.MeshStandardMaterial && isPbr) {
      const pbr = inner as PbrMaterial
      const emissiveTex = await this.loadUnionTexture(pbr.emissiveTexture)
      if (emissiveTex) {
        m.emissiveMap = emissiveTex
        this.applyUvTransform(emissiveTex, getTextureDef(pbr.emissiveTexture))
      }
      const bumpTex = await this.loadUnionTexture(pbr.bumpTexture)
      if (bumpTex) {
        m.normalMap = bumpTex
        this.applyUvTransform(bumpTex, getTextureDef(pbr.bumpTexture))
      }
    }

    applyTransparency(
      m,
      color.a ?? 1,
      inner.alphaTest,
      isPbr ? (inner as PbrMaterial).transparencyMode : MTM_AUTO,
      !!alphaTex
    )

    mesh.castShadow = inner.castShadows === true
    mesh.receiveShadow = true
    m.side = mesh.userData.primitiveDoubleSided === true ? THREE.DoubleSide : THREE.FrontSide
    m.needsUpdate = true
  }

  clearEntity(entity: number): void {
    this.applied.delete(entity)
  }

  private async loadUnionTexture(union?: TextureUnion): Promise<THREE.Texture | null> {
    if (union?.tex?.$case === 'videoTexture') {
      const def = union.tex.videoTexture
      const tex = this.getVideoTexture?.(def.videoPlayerEntity) ?? null
      if (!tex) return null
      tex.wrapS = wrapMode(def.wrapMode)
      tex.wrapT = wrapMode(def.wrapMode)
      tex.minFilter =
        def.filterMode === TFM_POINT
          ? THREE.NearestFilter
          : def.filterMode === TFM_TRILINEAR
            ? THREE.LinearMipmapLinearFilter
            : THREE.LinearFilter
      tex.magFilter = def.filterMode === TFM_POINT ? THREE.NearestFilter : THREE.LinearFilter
      tex.colorSpace = THREE.SRGBColorSpace
      return tex
    }
    if (union?.tex?.$case !== 'texture') return null
    const def = union.tex.texture
    const url = resolveSceneTextureUrl(def.src, this.scene)
    if (!url) return null
    const tex = await this.cache.loadTexture(url)
    tex.wrapS = wrapMode(def.wrapMode)
    tex.wrapT = wrapMode(def.wrapMode)
    tex.minFilter =
      def.filterMode === TFM_POINT
        ? THREE.NearestFilter
        : def.filterMode === TFM_TRILINEAR
          ? THREE.LinearMipmapLinearFilter
          : THREE.LinearFilter
    tex.magFilter = def.filterMode === TFM_POINT ? THREE.NearestFilter : THREE.LinearFilter
    tex.colorSpace = THREE.SRGBColorSpace
    return tex
  }

  private hasUnresolvedVideo(pb: PbMaterial): boolean {
    const materialCase = pb.material?.$case
    const inner =
      materialCase === 'pbr'
        ? pb.material!.pbr
        : materialCase === 'unlit'
          ? pb.material!.unlit
          : undefined
    if (!inner) return false

    const slots: Array<TextureUnion | undefined> = [inner.texture, inner.alphaTexture]
    if (materialCase === 'pbr') {
      const pbr = inner as PbrMaterial
      slots.push(pbr.emissiveTexture, pbr.bumpTexture)
    }

    for (const slot of slots) {
      if (slot?.tex?.$case !== 'videoTexture') continue
      const entity = slot.tex.videoTexture.videoPlayerEntity
      if (!this.getVideoTexture?.(entity)) return true
    }
    return false
  }

  private applyUvTransform(tex: THREE.Texture, def?: TextureDef): void {
    if (!def) return
    const tiling = def.tiling ?? { x: 1, y: 1 }
    const offset = def.offset ?? { x: 0, y: 0 }
    tex.repeat.set(tiling.x ?? 1, tiling.y ?? 1)
    tex.offset.set(offset.x ?? 0, offset.y ?? 0)
  }
}

function getTextureDef(union?: TextureUnion): TextureDef | undefined {
  return union?.tex?.$case === 'texture' ? union.tex.texture : undefined
}

function applyTransparency(
  m: THREE.MeshBasicMaterial | THREE.MeshStandardMaterial,
  alpha: number,
  alphaTest: number | undefined,
  mode: number | undefined,
  hasAlphaMap: boolean
): void {
  const resolved = mode ?? MTM_AUTO

  m.alphaTest = 0
  m.transparent = false
  m.opacity = 1
  m.depthWrite = true

  if (resolved === MTM_OPAQUE) return

  if (resolved === MTM_ALPHA_TEST) {
    m.alphaTest = alphaTest ?? 0.5
    return
  }

  if (resolved === MTM_ALPHA_BLEND) {
    m.transparent = true
    m.opacity = alpha
    return
  }

  if (alpha < 0.999 || hasAlphaMap) {
    m.transparent = true
    m.opacity = alpha
    if (hasAlphaMap && (alphaTest ?? 0) > 0) {
      m.alphaTest = alphaTest ?? 0.5
    }
  }
}
