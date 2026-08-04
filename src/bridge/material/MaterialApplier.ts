import * as THREE from 'three'
import type { ResolvedScene } from '../../dcl/content/types'
import type { AssetCache } from '../../rendering/AssetCache'
import { isSharedAssetResource } from '../../rendering/sharedAsset'
import { renderQuality } from '../../rendering/RenderQualitySettings'
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
  if ('tex' in u && u.tex) {
    // Creator Hub composites can emit texture slots with an empty src — treat as absent.
    if (u.tex.$case === 'texture' && !u.tex.texture.src?.trim()) return undefined
    return u as TextureUnion
  }
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

/**
 * SDK7 `Material.castShadows` → Three `mesh.castShadow` (not a Three material flag).
 * Proto default is true; authors set false to force off. MeshRenderer has no cast field.
 * Quality gate: only high/ultra cast (Genesis MeshRenderer flood); false always wins.
 */
export function applyMaterialCastShadows(
  mesh: THREE.Mesh,
  castShadows: boolean | undefined
): void {
  const q = renderQuality.getShadowQuality()
  const tierCasts = q === 'high' || q === 'ultra'
  mesh.castShadow = tierCasts && castShadows !== false
  mesh.receiveShadow = true
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

  const mainUnion = coerceTextureUnion(inner.texture)
  const alphaUnion = coerceTextureUnion(inner.alphaTexture)
  if (mainUnion && !m.map) return false
  // Same-src alphaTexture intentionally skips alphaMap (uses map alpha + alphaTest).
  if (alphaUnion && !m.alphaMap && !textureUnionSameSrc(alphaUnion, mainUnion)) return false
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

    let texturesOk = true
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
      // Only glow once maps exist — black+no maps = invisible fire planes.
      configureEmissiveRendering(
        m,
        pbr.emissiveIntensity,
        !!m.emissiveMap,
        pbr.transparencyMode
      )
    } else {
      const diffuse = (inner as UnlitMaterial).diffuseColor
      if (diffuse) {
        m.color.setRGB(diffuse.r ?? 1, diffuse.g ?? 1, diffuse.b ?? 1)
      }
    }

    const alpha =
      (isPbr ? (inner as PbrMaterial).albedoColor?.a : (inner as UnlitMaterial).diffuseColor?.a) ?? 1
    // Dedicated alphaMap only — do not treat albedo map as AUTO cutout (Unity parity).
    const hasAlphaMap =
      !!(m as THREE.MeshPhysicalMaterial).alphaMap || !!(m as THREE.MeshBasicMaterial).alphaMap
    applyTransparency(
      m,
      alpha,
      inner.alphaTest,
      isPbr ? (inner as PbrMaterial).transparencyMode : MTM_AUTO,
      hasAlphaMap
    )
    // Scalar-only path is terminal for color materials — honor castShadows here too.
    applyMaterialCastShadows(mesh, inner.castShadows)
    m.needsUpdate = true
  }

  async applyToMesh(
    mesh: THREE.Mesh,
    pb: PbMaterial,
    options?: { gltfNodeModifier?: boolean }
  ): Promise<boolean> {
    const materialCase = pb.material?.$case
    const isPbr = materialCase === 'pbr'
    const inner = materialInner(pb)
    if (!inner) return true

    this.applyScalarsToMesh(mesh, pb)
    const m = mesh.material as THREE.MeshBasicMaterial | THREE.MeshPhysicalMaterial
    // MeshRenderer planes: flipY on (TextureLoader). Marquee re-basis planes keep flipY off
    // so TextureMove Y + atlas row order match Explorer.
    const geo = mesh.geometry as THREE.BufferGeometry | undefined
    const marqueeAtlas = !!geo?.userData?.dclTextAlongYBasis
    const flipY = mesh.userData.primitiveMeshKey != null && !marqueeAtlas
    // Plaza event cards: thumbnail GLB UVs are LH-mirrored; bottom (JUMP IN) UVs are normal.
    // Parent Transform.scale.x = −1 is common. Flip map U when UV-mirror XOR scale-mirror.
    // MeshRenderer planes with scale.x < 0 also need the flip (no UV-mirror bit).
    const worldMirror = objectWorldMirrorX(mesh)
    const uvMirror = meshUvMapsUMirroredOnX(mesh)
    const flipMapU = !marqueeAtlas && (
      options?.gltfNodeModifier
        ? uvMirror !== worldMirror
        : mesh.userData.primitiveMeshKey != null && worldMirror
    )

    let texturesOk = true
    let alphaTex: THREE.Texture | null = null
    /** Scene set alphaTexture (including same-src as albedo). Drives AUTO cutout. */
    let hasAlphaTextureSlot = false
    const mainUnion = coerceTextureUnion(inner.texture)
    if (mainUnion) {
      const prev = m.map
      const mainTex = await this.loadUnionTexture(mainUnion, { flipY })
      m.map = mainTex
      if (!mainTex) texturesOk = false
      else {
        this.applyUvTransform(mainTex, getTextureDef(mainUnion), prev, mesh)
        if (flipMapU && mainUnion.tex?.$case === 'texture') flipTextureU(mainTex)
      }
    }
    const alphaUnion = coerceTextureUnion(inner.alphaTexture)
    if (alphaUnion) {
      hasAlphaTextureSlot = true
      // Three.js alphaMap samples the *green* channel, not PNG alpha. Scenes often set
      // texture + alphaTexture to the same PNG (backButton/nextButton purple pills).
      // Using that as alphaMap makes purple (low G) disappear and leaves only white glyphs.
      // When src matches albedo, skip alphaMap and cut out via map alpha + alphaTest.
      if (textureUnionSameSrc(alphaUnion, mainUnion) && m.map) {
        m.alphaMap = null
        alphaTex = null
      } else {
        const prev = m.alphaMap
        alphaTex = await this.loadUnionTexture(alphaUnion, { flipY })
        // Dedicated alpha masks (plaza press_e_alpha, soft cutouts) may store the mask in
        // the PNG alpha channel with black RGB — green would be 0 → fully invisible plane.
        // Bake max(R,G,B,A) into green so both grayscale RGB and alpha-only masks work.
        if (alphaTex) bakeAlphaMapGreenChannel(alphaTex)
        m.alphaMap = alphaTex
        if (!alphaTex) texturesOk = false
        else {
          this.applyUvTransform(alphaTex, getTextureDef(alphaUnion), prev, mesh)
          if (flipMapU && alphaUnion.tex?.$case === 'texture') flipTextureU(alphaTex)
        }
      }
    }

    if (m instanceof THREE.MeshPhysicalMaterial && isPbr) {
      const pbr = inner as PbrMaterial
      const emissiveUnion = coerceTextureUnion(pbr.emissiveTexture)
      if (emissiveUnion) {
        const prev = m.emissiveMap
        // Same-src as albedo (Genesis firepit): share map so UV frames + alpha stay in lockstep.
        if (m.map && textureUnionSameSrc(emissiveUnion, mainUnion)) {
          m.emissiveMap = m.map
        } else {
          let emissiveTex = await this.loadUnionTexture(emissiveUnion, { flipY })
          if (!emissiveTex && m.map && textureUnionSameSrc(emissiveUnion, mainUnion)) {
            emissiveTex = m.map
          }
          m.emissiveMap = emissiveTex
          if (!emissiveTex) texturesOk = false
          else if (emissiveTex !== m.map) {
            this.applyUvTransform(emissiveTex, getTextureDef(emissiveUnion), prev, mesh)
            if (flipMapU && emissiveUnion.tex?.$case === 'texture') flipTextureU(emissiveTex)
          }
        }
      }
      const bumpUnion = coerceTextureUnion(pbr.bumpTexture)
      if (bumpUnion) {
        const prev = m.normalMap
        const bumpTex = await this.loadUnionTexture(bumpUnion, { normalMap: true, flipY })
        m.normalMap = bumpTex
        if (!bumpTex) texturesOk = false
        else {
          bumpTex.colorSpace = THREE.LinearSRGBColorSpace
          this.applyUvTransform(bumpTex, getTextureDef(bumpUnion), prev, mesh)
          if (flipMapU && bumpUnion.tex?.$case === 'texture') flipTextureU(bumpTex)
        }
      }
      // Re-apply after maps land — emissiveIntensity drives flame brightness when albedoColor is absent.
      applyPbrColors(m, pbr)
      applyPbrScalars(m, pbr)
      configureEmissiveRendering(
        m,
        pbr.emissiveIntensity,
        !!m.emissiveMap,
        pbr.transparencyMode
      )
    }

    const transparencyMode = isPbr ? (inner as PbrMaterial).transparencyMode : MTM_AUTO
    const alpha =
      (isPbr ? (inner as PbrMaterial).albedoColor?.a : (inner as UnlitMaterial).diffuseColor?.a) ?? 1
    // AUTO cutout when scene provided alphaTexture (dedicated map, or same-src PNG alpha).
    // Bare albedo PNG without alphaTexture stays opaque (Explorer parity).
    applyTransparency(
      m,
      alpha,
      inner.alphaTest,
      transparencyMode,
      hasAlphaTextureSlot || !!alphaTex || !!m.alphaMap
    )
    if (transparencyMode === MTM_ALPHA_BLEND || transparencyMode === MTM_ALPHA_TEST_AND_ALPHA_BLEND) {
      m.depthWrite = false
    }

    // Material.castShadows → mesh.castShadow (see applyMaterialCastShadows).
    applyMaterialCastShadows(mesh, inner.castShadows)
    // Marquees face inward (FrontSide). Dual-face DCL plane geometry already has both
    // normals — FrontSide shows both. DoubleSide only when author marks primitiveDoubleSided.
    // Glow sprites: alpha-blend cards with high emissive only (firepit / LED sheets).
    // Opaque floors that share albedo as emissiveMap must stay tone-mapped + depth-write.
    const glowSprite =
      m instanceof THREE.MeshPhysicalMaterial &&
      (transparencyMode === MTM_ALPHA_BLEND || transparencyMode === MTM_ALPHA_TEST_AND_ALPHA_BLEND) &&
      (m.emissiveIntensity ?? 1) >= 1.5 &&
      !!m.emissiveMap &&
      !(m.map && m.emissiveMap === m.map && !m.transparent)
    if (glowSprite) {
      m.transparent = true
      m.depthWrite = false
      m.blending = THREE.NormalBlending
      m.toneMapped = false
    }
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

  /**
   * Clone material maps so wrap/offset/tiling (and Tween textureMove) never mutate the
   * shared AssetCache / video / avatar entry. Shared mutation was scrambling marquees
   * and blanking panels that reuse the same content URL.
   */
  private materialTextureInstance(
    base: THREE.Texture,
    opts: {
      wrapMode?: number
      filterMode?: number
      normalMap?: boolean
      /** undefined = leave clone's flipY from the loader/cache. */
      flipY?: boolean
    }
  ): THREE.Texture {
    // Clone so wrap/offset/tiling/tween UV never mutate the AssetCache entry.
    const tex = base.clone()
    tex.wrapS = wrapMode(opts.wrapMode)
    tex.wrapT = wrapMode(opts.wrapMode)
    tex.minFilter =
      opts.filterMode === TFM_POINT
        ? THREE.NearestFilter
        : opts.filterMode === TFM_TRILINEAR
          ? THREE.LinearMipmapLinearFilter
          : THREE.LinearFilter
    tex.magFilter = opts.filterMode === TFM_POINT ? THREE.NearestFilter : THREE.LinearFilter
    tex.colorSpace = opts.normalMap ? THREE.LinearSRGBColorSpace : THREE.SRGBColorSpace
    if (opts.flipY !== undefined && tex.flipY !== opts.flipY) {
      tex.flipY = opts.flipY
    }
    tex.needsUpdate = true
    return tex
  }

  private async loadUnionTexture(
    union?: TextureUnion,
    options?: { normalMap?: boolean; flipY?: boolean }
  ): Promise<THREE.Texture | null> {
    union = coerceTextureUnion(union)
    if (union?.tex?.$case === 'avatarTexture') {
      const def = union.tex.avatarTexture
      const userId = def.userId?.trim()
      if (!userId || !this.getAvatarTexture) return null
      let base = this.resolvedAvatarTextures.get(userId)
      if (base === undefined) {
        base = await this.getAvatarTexture(userId)
        this.resolvedAvatarTextures.set(userId, base)
      }
      if (!base) return null
      return this.materialTextureInstance(base, {
        wrapMode: def.wrapMode,
        filterMode: def.filterMode,
        normalMap: options?.normalMap,
        flipY: options?.flipY
      })
    }
    if (union?.tex?.$case === 'videoTexture') {
      const def = union.tex.videoTexture
      // Do not clone VideoTexture — frame uploads bind to the live instance in the render loop.
      const tex = this.getVideoTexture?.(def.videoPlayerEntity) ?? null
      if (!tex) return null
      tex.wrapS = wrapMode(def.wrapMode)
      tex.wrapT = wrapMode(def.wrapMode)
      tex.generateMipmaps = false
      tex.minFilter = def.filterMode === TFM_POINT ? THREE.NearestFilter : THREE.LinearFilter
      tex.magFilter = def.filterMode === TFM_POINT ? THREE.NearestFilter : THREE.LinearFilter
      tex.colorSpace = options?.normalMap ? THREE.LinearSRGBColorSpace : THREE.SRGBColorSpace
      // MeshRenderer planes pass flipY=true; glTF / GltfNodeModifiers leave default false.
      configureSceneVideoTexture(tex, options?.flipY ?? false)
      return tex
    }
    if (union?.tex?.$case !== 'texture') return null
    const def = union.tex.texture
    const url = resolveSceneTextureUrl(def.src, this.scene)
    if (!url) return null
    let base: THREE.Texture
    try {
      base = await this.cache.loadTexture(url)
    } catch {
      return null
    }
    return this.materialTextureInstance(base, {
      wrapMode: def.wrapMode,
      filterMode: def.filterMode,
      normalMap: options?.normalMap,
      // Default false for Material→mesh (GLTF UV space). Callers pass true for MeshRenderer planes.
      flipY: options?.flipY ?? false
    })
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

  /**
   * Apply TextureMove ST first (persisted on mesh userData), else authored, else previous map.
   * Clones start at (0,0) — authored offset must not wipe live TextureMove offset mid-scroll.
   */
  private applyUvTransform(
    tex: THREE.Texture,
    def?: TextureDef,
    previous?: THREE.Texture | null,
    mesh?: THREE.Mesh
  ): void {
    const held = mesh?.userData?.dclTextureMoveST as
      | { tiling?: boolean; x: number; y: number }
      | undefined

    if (held?.tiling) {
      tex.repeat.set(held.x, held.y)
    } else if (def?.tiling) {
      tex.repeat.set(def.tiling.x ?? 1, def.tiling.y ?? 1)
    } else if (previous && previous !== tex) {
      tex.repeat.copy(previous.repeat)
    }

    if (held && !held.tiling) {
      tex.offset.set(held.x, held.y)
    } else if (def?.offset) {
      tex.offset.set(def.offset.x ?? 0, def.offset.y ?? 0)
    } else if (previous && previous !== tex) {
      tex.offset.copy(previous.offset)
    }
  }
}

function getTextureDef(union?: TextureUnion): TextureDef | undefined {
  const coerced = coerceTextureUnion(union)
  return coerced?.tex?.$case === 'texture' ? coerced.tex.texture : undefined
}

/**
 * True when mesh UVs map spatial −X → higher U than +X (L–R mirrored vs reading order).
 * Plaza `event_card_thumbnail.glb` is authored this way for Unity LH; Three RH needs a map U flip
 * unless parent scale.x is already negative (then they cancel).
 */
function meshUvMapsUMirroredOnX(mesh: THREE.Mesh): boolean {
  const pos = mesh.geometry?.getAttribute('position')
  const uv = mesh.geometry?.getAttribute('uv')
  if (!pos || !uv || pos.count < 2 || uv.count < 2) return false
  let minX = Infinity
  let maxX = -Infinity
  let uAtMin = 0
  let uAtMax = 0
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i)
    if (x < minX) {
      minX = x
      uAtMin = uv.getX(i)
    }
    if (x > maxX) {
      maxX = x
      uAtMax = uv.getX(i)
    }
  }
  if (!(maxX - minX > 1e-5)) return false
  return uAtMin > uAtMax + 1e-5
}

/** Product of local scale.x up the parent chain (DCL boards often use scale.x = −1). */
function objectWorldMirrorX(obj: THREE.Object3D): boolean {
  obj.updateWorldMatrix(true, false)
  let sx = 1
  let o: THREE.Object3D | null = obj
  for (let i = 0; i < 48 && o; i++) {
    sx *= o.scale.x
    o = o.parent
  }
  // Odd negative scales (reflection) — det < 0 also catches multi-axis flips.
  if (sx < 0) return true
  try {
    return obj.matrixWorld.determinant() < 0
  } catch {
    return false
  }
}

/** Flip texture U after authored offset/tiling: sample' = 1 − sample. Fresh clones only. */
function flipTextureU(tex: THREE.Texture): void {
  if (tex.userData.dclMapUFlipped) return
  const rep = tex.repeat.x
  const off = tex.offset.x
  tex.repeat.x = -rep
  tex.offset.x = 1 - off
  tex.userData.dclMapUFlipped = true
  tex.needsUpdate = true
}

function textureUnionSameSrc(a?: TextureUnion, b?: TextureUnion): boolean {
  const aSrc = getTextureDef(coerceTextureUnion(a))?.src?.trim()
  const bSrc = getTextureDef(coerceTextureUnion(b))?.src?.trim()
  return !!aSrc && aSrc === bSrc
}

/**
 * Three.js `alphaMap` reads the **green** channel only. DCL dedicated alphaTextures are often
 * (1) grayscale RGB masks or (2) white/black with the silhouette only in PNG alpha.
 * Without baking, case (2) is fully transparent (press_e over fishing bobber).
 */
function bakeAlphaMapGreenChannel(tex: THREE.Texture): void {
  if (tex.userData.dclAlphaMapGreenBaked) return
  const image = tex.image as CanvasImageSource | undefined
  if (!image) return
  const w =
    'naturalWidth' in image && (image as HTMLImageElement).naturalWidth
      ? (image as HTMLImageElement).naturalWidth
      : (image as { width?: number }).width ?? 0
  const h =
    'naturalHeight' in image && (image as HTMLImageElement).naturalHeight
      ? (image as HTMLImageElement).naturalHeight
      : (image as { height?: number }).height ?? 0
  if (!w || !h) return

  try {
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) return
    ctx.drawImage(image, 0, 0, w, h)
    const data = ctx.getImageData(0, 0, w, h)
    const px = data.data
    for (let i = 0; i < px.length; i += 4) {
      const r = px[i] ?? 0
      const g = px[i + 1] ?? 0
      const b = px[i + 2] ?? 0
      const a = px[i + 3] ?? 0
      const green = Math.max(r, g, b, a)
      px[i] = green
      px[i + 1] = green
      px[i + 2] = green
      px[i + 3] = 255
    }
    ctx.putImageData(data, 0, 0)
    tex.image = canvas
    // Alpha masks must not go through sRGB transfer (would darken mid-grays vs alphaTest).
    tex.colorSpace = THREE.NoColorSpace
    tex.userData.dclAlphaMapGreenBaked = true
    tex.needsUpdate = true
  } catch {
    // Cross-origin / tainted canvas — leave texture as-is.
  }
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

  // AUTO — cutout only with a dedicated alpha map (Unity Explorer parity).
  // Albedo-only PNG alpha is ignored; transparent texels draw as their RGB (often black).
  if (hasAlphaMap) {
    m.alphaTest = alphaTest ?? 0.5
    return
  }
  if (alpha < 0.999) {
    m.transparent = true
    m.opacity = alpha
  }
}
