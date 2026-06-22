import * as THREE from 'three'
import type { ResolvedScene } from '../../dcl/content/types'
import type { AssetCache } from '../../rendering/AssetCache'
import { isSharedAssetResource } from '../../rendering/sharedAsset'
import { resolveSceneTextureUrl } from './resolveTexture'
import { applyPbrColors, applyPbrScalars, configureEmissiveRendering } from './pbrApply'
import { configureSceneVideoTexture } from '../../media/videoTextureOrientation'

/** Matches `@dcl/ecs` MaterialTransparencyMode. */
const MTM_OPAQUE = 0
const MTM_ALPHA_TEST = 1
const MTM_ALPHA_BLEND = 2
const MTM_ALPHA_TEST_AND_ALPHA_BLEND = 3
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

type AvatarTextureDef = {
  userId: string
  wrapMode?: number
  filterMode?: number
}

type TextureUnion = {
  tex?:
    | { $case: 'texture'; texture: TextureDef }
    | { $case: 'avatarTexture'; avatarTexture: AvatarTextureDef }
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
  reflectivityColor?: Color3
  specularIntensity?: number
  directIntensity?: number
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

function round4(n: number | undefined): number | undefined {
  if (n === undefined) return undefined
  return Math.round(n * 10000) / 10000
}

function normalizeColor4(c?: Color4): Color4 | undefined {
  if (!c) return undefined
  return { r: round4(c.r), g: round4(c.g), b: round4(c.b), a: round4(c.a) }
}

function normalizeColor3(c?: Color3): Color3 | undefined {
  if (!c) return undefined
  return { r: round4(c.r), g: round4(c.g), b: round4(c.b) }
}

/** Accept SDK TextureUnion and legacy `{ src }` shapes from composite JSON. */
function coerceTextureUnion(u?: TextureUnion | { src?: string; wrapMode?: number; filterMode?: number }): TextureUnion | undefined {
  if (!u) return undefined
  if ('tex' in u && u.tex) return u as TextureUnion
  const flat = u as { src?: string; wrapMode?: number; filterMode?: number }
  if (flat.src?.trim()) {
    return { tex: { $case: 'texture', texture: { src: flat.src, wrapMode: flat.wrapMode, filterMode: flat.filterMode } } }
  }
  return undefined
}

function normalizeTextureUnion(u?: TextureUnion): unknown {
  const coerced = coerceTextureUnion(u)
  const tex = coerced?.tex
  if (!tex) return undefined
  if (tex.$case === 'texture') {
    const t = tex.texture
    return {
      case: 'texture',
      src: t.src,
      wrapMode: t.wrapMode,
      filterMode: t.filterMode,
      offset: t.offset,
      tiling: t.tiling
    }
  }
  if (tex.$case === 'videoTexture') {
    const v = tex.videoTexture
    return {
      case: 'video',
      videoPlayerEntity: v.videoPlayerEntity,
      wrapMode: v.wrapMode,
      filterMode: v.filterMode
    }
  }
  if (tex.$case === 'avatarTexture') {
    const a = tex.avatarTexture
    return { case: 'avatar', userId: a.userId, wrapMode: a.wrapMode, filterMode: a.filterMode }
  }
  return undefined
}

/** Stable hash of ECS material fields — avoids protobuf/JSON key-order drift across projection reads. */
function materialFingerprint(pb: PbMaterial): string {
  const materialCase = pb.material?.$case
  if (!materialCase) return ''
  const inner =
    materialCase === 'pbr'
      ? pb.material!.pbr
      : materialCase === 'unlit'
        ? pb.material!.unlit
        : undefined
  if (!inner) return materialCase

  if (materialCase === 'pbr') {
    const pbr = inner as PbrMaterial
    return JSON.stringify({
      case: 'pbr',
      albedoColor: normalizeColor4(pbr.albedoColor),
      emissiveColor: normalizeColor3(pbr.emissiveColor),
      alphaTest: round4(pbr.alphaTest),
      castShadows: pbr.castShadows,
      transparencyMode: pbr.transparencyMode,
      metallic: round4(pbr.metallic),
      roughness: round4(pbr.roughness),
      emissiveIntensity: round4(pbr.emissiveIntensity),
      reflectivityColor: normalizeColor3(pbr.reflectivityColor),
      specularIntensity: round4(pbr.specularIntensity),
      directIntensity: round4(pbr.directIntensity),
      texture: normalizeTextureUnion(pbr.texture),
      alphaTexture: normalizeTextureUnion(pbr.alphaTexture),
      emissiveTexture: normalizeTextureUnion(pbr.emissiveTexture),
      bumpTexture: normalizeTextureUnion(pbr.bumpTexture)
    })
  }

  const unlit = inner as UnlitMaterial
  return JSON.stringify({
    case: 'unlit',
    diffuseColor: normalizeColor4(unlit.diffuseColor),
    alphaTest: round4(unlit.alphaTest),
    castShadows: unlit.castShadows,
    texture: normalizeTextureUnion(unlit.texture),
    alphaTexture: normalizeTextureUnion(unlit.alphaTexture)
  })
}

function materialInner(pb: PbMaterial): PbrMaterial | UnlitMaterial | undefined {
  const materialCase = pb.material?.$case
  if (materialCase === 'pbr') return pb.material!.pbr
  if (materialCase === 'unlit') return pb.material!.unlit
  return undefined
}

function materialTextureSlots(pb: PbMaterial): TextureUnion[] {
  const materialCase = pb.material?.$case
  const inner = materialInner(pb)
  if (!inner) return []
  const slots: TextureUnion[] = []
  const main = coerceTextureUnion(inner.texture)
  const alpha = coerceTextureUnion(inner.alphaTexture)
  if (main) slots.push(main)
  if (alpha) slots.push(alpha)
  if (materialCase === 'pbr') {
    const pbr = inner as PbrMaterial
    const emissive = coerceTextureUnion(pbr.emissiveTexture)
    const bump = coerceTextureUnion(pbr.bumpTexture)
    if (emissive) slots.push(emissive)
    if (bump) slots.push(bump)
  }
  return slots
}

function materialHasTextureSlots(pb: PbMaterial): boolean {
  return materialTextureSlots(pb).length > 0
}

function meshHasTextureMaps(mesh: THREE.Mesh, pb: PbMaterial): boolean {
  if (!materialHasTextureSlots(pb)) return true
  const m = mesh.material as THREE.MeshBasicMaterial | THREE.MeshPhysicalMaterial
  const materialCase = pb.material?.$case
  const inner = materialInner(pb)
  if (!inner) return true

  if (coerceTextureUnion(inner.texture) && !m.map) return false
  if (coerceTextureUnion(inner.alphaTexture) && !m.alphaMap) return false
  if (materialCase === 'pbr' && m instanceof THREE.MeshPhysicalMaterial) {
    const pbr = inner as PbrMaterial
    if (coerceTextureUnion(pbr.emissiveTexture) && !m.emissiveMap) return false
    if (coerceTextureUnion(pbr.bumpTexture) && !m.normalMap) return false
  }
  return true
}

/** Apply SDK7 Material → Three.js materials (P0 parity). */
export class MaterialApplier {
  private readonly applied = new Map<number, string>()
  private getVideoTexture: ((videoPlayerEntity: number) => THREE.Texture | null) | null = null
  private getAvatarTexture: ((userId: string) => Promise<THREE.Texture | null>) | null = null
  /** userId → resolved face texture (null = fetch failed). */
  private readonly resolvedAvatarTextures = new Map<string, THREE.Texture | null>()

  constructor(
    private readonly scene: ResolvedScene,
    private readonly cache: AssetCache
  ) {}

  setVideoTextureResolver(resolver: (videoPlayerEntity: number) => THREE.Texture | null): void {
    this.getVideoTexture = resolver
  }

  setAvatarTextureResolver(resolver: (userId: string) => Promise<THREE.Texture | null>): void {
    this.getAvatarTexture = resolver
  }

  /** Texture/video/avatar slots still loading — cheap check for material-queue ordering. */
  texturesPending(pb: PbMaterial, root?: THREE.Object3D): boolean {
    if (this.hasUnresolvedVideo(pb)) return true
    if (this.hasUnresolvedAvatar(pb)) return true
    if (this.hasUnresolvedStaticTexture(pb)) return true
    if (root && materialHasTextureSlots(pb) && !this.objectTexturesSatisfied(root, pb)) return true
    return false
  }

  needsReapply(entity: number, pb: PbMaterial, root?: THREE.Object3D): boolean {
    if (this.texturesPending(pb, root)) return true
    const fp = materialFingerprint(pb)
    if (this.applied.get(entity) === fp) return false
    // Scalar-only materials are fully applied once color/transparency is set.
    if (!materialHasTextureSlots(pb) && this.applied.get(entity) === `scalar:${fp}`) return false
    return true
  }

  objectTexturesSatisfied(root: THREE.Object3D, pb: PbMaterial): boolean {
    if (!materialHasTextureSlots(pb)) return true
    let ok = true
    root.traverse((child) => {
      if (!ok || !(child as THREE.Mesh).isMesh) return
      if (!meshHasTextureMaps(child as THREE.Mesh, pb)) ok = false
    })
    return ok
  }

  /** Sync color / PBR scalars only — safe during hydration before textures are ready. */
  applyScalarsToObject3D(root: THREE.Object3D, entity: number, pb: PbMaterial): void {
    root.traverse((child) => {
      if ((child as THREE.Mesh).isMesh) this.applyScalarsToMesh(child as THREE.Mesh, pb)
    })
    if (
      !materialHasTextureSlots(pb) &&
      !this.hasUnresolvedVideo(pb) &&
      !this.hasUnresolvedAvatar(pb)
    ) {
      this.applied.set(entity, `scalar:${materialFingerprint(pb)}`)
    }
  }

  private isMaterialApplied(entity: number, pb: PbMaterial): boolean {
    const fp = materialFingerprint(pb)
    const stored = this.applied.get(entity)
    if (stored === fp) return true
    if (!materialHasTextureSlots(pb) && stored === `scalar:${fp}`) return true
    return false
  }

  async applyToObject3D(root: THREE.Object3D, entity: number, pb: PbMaterial): Promise<void> {
    const fp = materialFingerprint(pb)
    const pendingVideo = this.hasUnresolvedVideo(pb)
    const pendingAvatar = this.hasUnresolvedAvatar(pb)
    const pendingTexture = this.hasUnresolvedStaticTexture(pb)
    if (
      this.isMaterialApplied(entity, pb) &&
      !pendingVideo &&
      !pendingAvatar &&
      !pendingTexture &&
      this.objectTexturesSatisfied(root, pb)
    ) {
      return
    }

    const meshes: THREE.Mesh[] = []
    root.traverse((child) => {
      if ((child as THREE.Mesh).isMesh) meshes.push(child as THREE.Mesh)
    })

    let texturesOk = !materialHasTextureSlots(pb)
    for (const mesh of meshes) {
      const ok = await this.applyToMesh(mesh, pb)
      if (!ok) texturesOk = false
    }

    if (!pendingVideo && !pendingAvatar && texturesOk && this.objectTexturesSatisfied(root, pb)) {
      this.applied.set(entity, fp)
    } else {
      this.applied.delete(entity)
    }
  }

  applyScalarsToMesh(mesh: THREE.Mesh, pb: PbMaterial): void {
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
      (!needsUnlit && current instanceof THREE.MeshPhysicalMaterial)

    const m = reuse
      ? current
      : needsUnlit
        ? new THREE.MeshBasicMaterial({ color: 0xffffff })
        : new THREE.MeshPhysicalMaterial({ color: 0xffffff })

    if (!reuse) {
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
      for (const mat of materials) {
        if (mat && !isSharedAssetResource(mat)) mat.dispose()
      }
      mesh.material = m
    }

    if (m instanceof THREE.MeshPhysicalMaterial) {
      const pbr = inner as PbrMaterial
      applyPbrColors(m, pbr)
      applyPbrScalars(m, pbr)
      const emissiveUnion = coerceTextureUnion(pbr.emissiveTexture)
      const mainUnion = coerceTextureUnion(inner.texture)
      if (emissiveUnion && m.map && textureUnionSameSrc(emissiveUnion, mainUnion)) {
        m.emissiveMap = m.map
      }
      configureEmissiveRendering(m, pbr.emissiveIntensity, !!m.emissiveMap)
    } else {
      const diffuse = (inner as UnlitMaterial).diffuseColor
      if (diffuse) {
        m.color.setRGB(diffuse.r ?? 1, diffuse.g ?? 1, diffuse.b ?? 1)
      }
    }

    const alpha =
      (isPbr ? (inner as PbrMaterial).albedoColor?.a : (inner as UnlitMaterial).diffuseColor?.a) ?? 1
    applyTransparency(
      m,
      alpha,
      inner.alphaTest,
      isPbr ? (inner as PbrMaterial).transparencyMode : MTM_AUTO,
      false
    )
    m.needsUpdate = true
  }

  async applyToMesh(mesh: THREE.Mesh, pb: PbMaterial): Promise<boolean> {
    const materialCase = pb.material?.$case
    const isPbr = materialCase === 'pbr'
    const inner = materialInner(pb)
    if (!inner) return true

    this.applyScalarsToMesh(mesh, pb)
    const m = mesh.material as THREE.MeshBasicMaterial | THREE.MeshPhysicalMaterial

    let texturesOk = true
    let alphaTex: THREE.Texture | null = null
    const mainUnion = coerceTextureUnion(inner.texture)
    if (mainUnion) {
      const mainTex = await this.loadUnionTexture(mainUnion)
      m.map = mainTex
      if (!mainTex) texturesOk = false
      else this.applyUvTransform(mainTex, getTextureDef(mainUnion))
    }
    const alphaUnion = coerceTextureUnion(inner.alphaTexture)
    if (alphaUnion) {
      alphaTex = await this.loadUnionTexture(alphaUnion)
      m.alphaMap = alphaTex
      if (!alphaTex) texturesOk = false
      else this.applyUvTransform(alphaTex, getTextureDef(alphaUnion))
    }

    if (m instanceof THREE.MeshPhysicalMaterial && isPbr) {
      const pbr = inner as PbrMaterial
      const emissiveUnion = coerceTextureUnion(pbr.emissiveTexture)
      if (emissiveUnion) {
        let emissiveTex = await this.loadUnionTexture(emissiveUnion)
        if (!emissiveTex && m.map && textureUnionSameSrc(emissiveUnion, mainUnion)) {
          emissiveTex = m.map
        }
        m.emissiveMap = emissiveTex
        if (!emissiveTex) texturesOk = false
        else this.applyUvTransform(emissiveTex, getTextureDef(emissiveUnion))
      }
      const bumpUnion = coerceTextureUnion(pbr.bumpTexture)
      if (bumpUnion) {
        const bumpTex = await this.loadUnionTexture(bumpUnion, { normalMap: true })
        m.normalMap = bumpTex
        if (!bumpTex) texturesOk = false
        else {
          bumpTex.colorSpace = THREE.LinearSRGBColorSpace
          this.applyUvTransform(bumpTex, getTextureDef(bumpUnion))
        }
      }
      // Re-apply after maps land — emissiveIntensity drives flame brightness when albedoColor is absent.
      applyPbrColors(m, pbr)
      applyPbrScalars(m, pbr)
      configureEmissiveRendering(m, pbr.emissiveIntensity, !!m.emissiveMap)
    }

    const transparencyMode = isPbr ? (inner as PbrMaterial).transparencyMode : MTM_AUTO
    const alpha =
      (isPbr ? (inner as PbrMaterial).albedoColor?.a : (inner as UnlitMaterial).diffuseColor?.a) ?? 1
    applyTransparency(
      m,
      alpha,
      inner.alphaTest,
      transparencyMode,
      !!alphaTex || !!m.alphaMap
    )
    if (transparencyMode === MTM_ALPHA_BLEND || transparencyMode === MTM_ALPHA_TEST_AND_ALPHA_BLEND) {
      m.depthWrite = false
    }

    mesh.castShadow = inner.castShadows === true
    mesh.receiveShadow = true
    m.side = mesh.userData.primitiveDoubleSided === true ? THREE.DoubleSide : THREE.FrontSide
    m.needsUpdate = true
    return texturesOk && meshHasTextureMaps(mesh, pb)
  }

  clearEntity(entity: number): void {
    this.applied.delete(entity)
  }

  private hasUnresolvedStaticTexture(pb: PbMaterial): boolean {
    for (const slot of materialTextureSlots(pb)) {
      const tex = slot.tex
      if (!tex || tex.$case === 'videoTexture' || tex.$case === 'avatarTexture') continue
      if (tex.$case === 'texture') {
        const src = tex.texture.src?.trim()
        if (!src) continue
        if (!resolveSceneTextureUrl(src, this.scene)) return true
      }
    }
    return false
  }

  private async loadUnionTexture(
    union?: TextureUnion,
    options?: { normalMap?: boolean }
  ): Promise<THREE.Texture | null> {
    union = coerceTextureUnion(union)
    if (union?.tex?.$case === 'avatarTexture') {
      const def = union.tex.avatarTexture
      const userId = def.userId?.trim()
      if (!userId || !this.getAvatarTexture) return null
      let tex = this.resolvedAvatarTextures.get(userId)
      if (tex === undefined) {
        tex = await this.getAvatarTexture(userId)
        this.resolvedAvatarTextures.set(userId, tex)
      }
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
      tex.colorSpace = options?.normalMap ? THREE.LinearSRGBColorSpace : THREE.SRGBColorSpace
      return tex
    }
    if (union?.tex?.$case === 'videoTexture') {
      const def = union.tex.videoTexture
      const tex = this.getVideoTexture?.(def.videoPlayerEntity) ?? null
      if (!tex) return null
      tex.wrapS = wrapMode(def.wrapMode)
      tex.wrapT = wrapMode(def.wrapMode)
      // VideoTexture has no mipmaps — mipmap min filters render blank/corrupt.
      tex.generateMipmaps = false
      tex.minFilter = def.filterMode === TFM_POINT ? THREE.NearestFilter : THREE.LinearFilter
      tex.magFilter = def.filterMode === TFM_POINT ? THREE.NearestFilter : THREE.LinearFilter
      tex.colorSpace = options?.normalMap ? THREE.LinearSRGBColorSpace : THREE.SRGBColorSpace
      configureSceneVideoTexture(tex)
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
    tex.colorSpace = options?.normalMap ? THREE.LinearSRGBColorSpace : THREE.SRGBColorSpace
    return tex
  }

  private hasUnresolvedAvatar(pb: PbMaterial): boolean {
    const materialCase = pb.material?.$case
    const inner =
      materialCase === 'pbr'
        ? pb.material!.pbr
        : materialCase === 'unlit'
          ? pb.material!.unlit
          : undefined
    if (!inner || !this.getAvatarTexture) return false

    const slots: Array<TextureUnion | undefined> = [inner.texture, inner.alphaTexture]
    if (materialCase === 'pbr') {
      const pbr = inner as PbrMaterial
      slots.push(pbr.emissiveTexture, pbr.bumpTexture)
    }

    for (const slot of slots) {
      if (slot?.tex?.$case !== 'avatarTexture') continue
      const userId = slot.tex.avatarTexture.userId?.trim()
      if (!userId) continue
      if (!this.resolvedAvatarTextures.has(userId)) return true
    }
    return false
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
  const coerced = coerceTextureUnion(union)
  return coerced?.tex?.$case === 'texture' ? coerced.tex.texture : undefined
}

function textureUnionSameSrc(a?: TextureUnion, b?: TextureUnion): boolean {
  const aSrc = getTextureDef(coerceTextureUnion(a))?.src?.trim()
  const bSrc = getTextureDef(coerceTextureUnion(b))?.src?.trim()
  return !!aSrc && aSrc === bSrc
}

function applyTransparency(
  m: THREE.MeshBasicMaterial | THREE.MeshPhysicalMaterial,
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

  if (resolved === MTM_ALPHA_TEST_AND_ALPHA_BLEND) {
    m.transparent = true
    m.opacity = alpha
    m.alphaTest = alphaTest ?? 0.5
    return
  }

  // AUTO — DCL picks alpha-cutout when the albedo texture has alpha; not alpha-blend.
  if (hasAlphaMap) {
    m.alphaTest = alphaTest ?? 0.5
    return
  }
  if (alpha < 0.999) {
    m.transparent = true
    m.opacity = alpha
  }
}
