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

/**
 * Accept SDK TextureUnion and legacy / CRDT-drift shapes.
 * Plaza event posters must not go missing when the wire omits `tex.$case` or nests Texture.
 */
function coerceTextureUnion(
  u?: TextureUnion | { src?: string; wrapMode?: number; filterMode?: number } | Record<string, unknown>
): TextureUnion | undefined {
  if (!u || typeof u !== 'object') return undefined

  // Canonical: { tex: { $case: 'texture', texture: { src } } }
  if ('tex' in u && (u as TextureUnion).tex) {
    const tex = (u as TextureUnion).tex!
    if (tex.$case === 'texture' && !tex.texture.src?.trim()) return undefined
    // Missing $case but has texture payload (some CRDT / JSON paths).
    const anyTex = tex as { $case?: string; texture?: TextureDef; src?: string }
    if (!tex.$case && anyTex.texture?.src?.trim()) {
      return {
        tex: {
          $case: 'texture',
          texture: anyTex.texture
        }
      }
    }
    if (!tex.$case && anyTex.src?.trim()) {
      return {
        tex: {
          $case: 'texture',
          texture: {
            src: anyTex.src,
            wrapMode: (anyTex as TextureDef).wrapMode,
            filterMode: (anyTex as TextureDef).filterMode
          }
        }
      }
    }
    return u as TextureUnion
  }

  // Oneof value without wrapper: { $case: 'texture', texture: { src } }
  const asCase = u as { $case?: string; texture?: TextureDef }
  if (asCase.$case === 'texture' && asCase.texture?.src?.trim()) {
    return { tex: { $case: 'texture', texture: asCase.texture } }
  }

  // Nested Texture only: { texture: { src } } (common partial decode)
  const nested = u as { texture?: TextureDef & { src?: string } }
  if (nested.texture?.src?.trim()) {
    return { tex: { $case: 'texture', texture: nested.texture } }
  }

  // Flat Texture: { src }
  const flat = u as { src?: string; wrapMode?: number; filterMode?: number }
  if (flat.src?.trim()) {
    return {
      tex: {
        $case: 'texture',
        texture: { src: flat.src, wrapMode: flat.wrapMode, filterMode: flat.filterMode }
      }
    }
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

/**
 * Color-only PBR with alpha < 1 (or explicit blend) — plaza event blackMask fades
 * albedoColor.a every frame with no texture/transparencyMode. Must not stay on lit PBR.
 */
function isColorOnlyTranslucent(pb: PbMaterial): boolean {
  if (materialHasTextureSlots(pb)) return false
  if (pb.material?.$case !== 'pbr') return false
  const pbr = pb.material.pbr
  const mode = pbr.transparencyMode
  if (mode === MTM_ALPHA_BLEND || mode === MTM_ALPHA_TEST_AND_ALPHA_BLEND) return true
  const a = pbr.albedoColor?.a
  return typeof a === 'number' && a < 0.999
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

    // Color-only translucent PBR (plaza event blackMask / pool glass): MeshBasicMaterial is
    // reliable for alpha dim planes — MeshPhysicalMaterial + lights often reads as invisible.
    const colorOnlyAlpha = isColorOnlyTranslucent(pb)
    const needsUnlit = !isPbr || colorOnlyAlpha
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
      // Unlit path — also color-only translucent PBR remapped to MeshBasicMaterial.
      if (isPbr && colorOnlyAlpha) {
        const ac = (inner as PbrMaterial).albedoColor
        m.color.setRGB(ac?.r ?? 0, ac?.g ?? 0, ac?.b ?? 0)
      } else {
        // Plaza event thumbnails omit diffuseColor — always white so map is not crushed
        // by a leftover tint from a prior material apply on a reused MeshBasicMaterial.
        const diffuse = (inner as UnlitMaterial).diffuseColor
        m.color.setRGB(diffuse?.r ?? 1, diffuse?.g ?? 1, diffuse?.b ?? 1)
      }
    }

    const alpha =
      (isPbr ? (inner as PbrMaterial).albedoColor?.a : (inner as UnlitMaterial).diffuseColor?.a) ?? 1
    // Dedicated alphaMap only — do not treat albedo map as AUTO cutout (Unity parity).
    const hasAlphaMap =
      !!(m as THREE.MeshPhysicalMaterial).alphaMap || !!(m as THREE.MeshBasicMaterial).alphaMap
    // Color-only masks omit transparencyMode (plaza GQe blackMask) — force blend.
    const transparencyMode =
      isPbr && colorOnlyAlpha
        ? MTM_ALPHA_BLEND
        : isPbr
          ? (inner as PbrMaterial).transparencyMode
          : MTM_AUTO
    applyTransparency(m, alpha, inner.alphaTest, transparencyMode, hasAlphaMap)
    if (colorOnlyAlpha) {
      // Dim mask planes: draw *behind* opaque event cards. depthWrite off + low renderOrder
      // so transparent sort does not paint the mask over thumbnails/JUMP IN.
      m.depthWrite = false
      m.depthTest = true
      m.toneMapped = false
      mesh.renderOrder = -10
      mesh.frustumCulled = false
      m.transparent = true
      m.opacity = Math.max(0, Math.min(1, alpha))
      m.polygonOffset = true
      m.polygonOffsetFactor = 1
      m.polygonOffsetUnits = 1
    }
    // Scalar-only path is terminal for color materials — honor castShadows here too.
    applyMaterialCastShadows(mesh, inner.castShadows)
    m.side = mesh.userData.primitiveDoubleSided === true ? THREE.DoubleSide : THREE.FrontSide
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
    const isPrimitive = mesh.userData.primitiveMeshKey != null
    const isGltfMod = options?.gltfNodeModifier === true
    // Map / content orientation:
    //
    // • MeshRenderer JUMP IN (wide atlas): content-flip mesh.scale.x (not tall arrows).
    // • GltfNodeModifiers: no mesh U flip. flipY depends on texture source (below).
    if (!marqueeAtlas && isPrimitive && !isGltfMod) {
      const tallAtlas = meshAtlasUvIsTall(mesh)
      ensureMeshContentFlipX(mesh, !tallAtlas)
    } else if (isGltfMod && mesh.userData.dclPlaneContentFlipX) {
      ensureMeshContentFlipX(mesh, false)
    }

    let texturesOk = true
    let alphaTex: THREE.Texture | null = null
    /** Scene set alphaTexture (including same-src as albedo). Drives AUTO cutout. */
    let hasAlphaTextureSlot = false
    const mainUnion = coerceTextureUnion(inner.texture)
    // flipY: MeshRenderer planes = true (TextureLoader). Scene-content on GLB = false (glTF UV).
    // External https posters (events-assets webp) are TextureLoader/fetch images — use flipY
    // true so WebGL upload matches decoder; false left many plaza event cards blank/black.
    const mainSrc = getTextureDef(mainUnion)?.src?.trim() ?? ''
    const externalHttpPoster = isGltfMod && /^https?:\/\//i.test(mainSrc)
    const flipY =
      externalHttpPoster || (isPrimitive && !marqueeAtlas && !isGltfMod)
    if (mainUnion) {
      const prev = m.map
      const mainTex = await this.loadUnionTexture(mainUnion, { flipY })
      m.map = mainTex
      if (!mainTex) texturesOk = false
      else {
        this.applyUvTransform(mainTex, getTextureDef(mainUnion), prev, mesh)
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
        m.alphaMap = alphaTex
        if (!alphaTex) texturesOk = false
        else {
          this.applyUvTransform(alphaTex, getTextureDef(alphaUnion), prev, mesh)
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

    const colorOnlyAlpha = isColorOnlyTranslucent(pb)
    const transparencyMode =
      isPbr && colorOnlyAlpha
        ? MTM_ALPHA_BLEND
        : isPbr
          ? (inner as PbrMaterial).transparencyMode
          : MTM_AUTO
    const alpha =
      (isPbr ? (inner as PbrMaterial).albedoColor?.a : (inner as UnlitMaterial).diffuseColor?.a) ?? 1
    // AUTO cutout when scene provided alphaTexture (dedicated map, or same-src PNG alpha).
    // Bare albedo PNG without alphaTexture stays opaque (Explorer parity) — except GltfNodeModifiers
    // UI chips (close_button) that sample atlas PNGs with transparency.
    const hasAlpha =
      hasAlphaTextureSlot || !!alphaTex || !!m.alphaMap
    applyTransparency(
      m,
      alpha,
      inner.alphaTest,
      transparencyMode,
      hasAlpha
    )
    // Atlas UI (JUMP IN / arrows): same-src alphaTexture under AUTO is cutout-only in
    // applyTransparency (no blend). Dual-face + content flip leaves opaque “bg” scraps.
    // Always force cutout+blend for unlit same-src alpha atlas planes (not only when flipped).
    if (
      !isPbr &&
      m.map &&
      hasAlphaTextureSlot &&
      (transparencyMode === MTM_AUTO || transparencyMode === undefined) &&
      isPrimitive
    ) {
      m.transparent = true
      m.alphaTest = Math.min(m.alphaTest || 0.5, 0.15)
      m.depthWrite = false
    }
    // Close X only (button_atlas / close_button) — NOT event thumbnails.
    // Applying alphaTest to all GltfNodeModifiers unlit maps blanked plaza event photos
    // (thumbnails also have no alphaTexture slot).
    const modTexSrc = getTextureDef(mainUnion)?.src ?? ''
    const isCloseUiChip =
      options?.gltfNodeModifier === true &&
      !isPbr &&
      !!m.map &&
      !hasAlphaTextureSlot &&
      (transparencyMode === MTM_AUTO || transparencyMode === undefined) &&
      /button_atlas|close_button|closeButton/i.test(modTexSrc)
    if (isCloseUiChip) {
      m.transparent = true
      m.alphaTest = 0.5
      m.depthWrite = false
      m.depthTest = true
      m.side = THREE.DoubleSide
      mesh.renderOrder = Math.max(mesh.renderOrder, 5)
      mesh.frustumCulled = false
    }
    if (transparencyMode === MTM_ALPHA_BLEND || transparencyMode === MTM_ALPHA_TEST_AND_ALPHA_BLEND) {
      m.depthWrite = false
    }
    if (colorOnlyAlpha) {
      m.depthWrite = false
      m.depthTest = true
      m.toneMapped = false
      mesh.renderOrder = -10
      mesh.frustumCulled = false
      m.transparent = true
      m.opacity = Math.max(0, Math.min(1, alpha))
      m.polygonOffset = true
      m.polygonOffsetFactor = 1
      m.polygonOffsetUnits = 1
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
    // Event-card thumbnails (GltfNodeModifiers unlit): always DoubleSide — FrontSide alone
    // culls the board face under dclToThree + board yaw (poster reads pure black).
    // Close chip also needs DoubleSide (set above). Video screens set primitiveDoubleSided.
    if (options?.gltfNodeModifier === true) {
      m.side = THREE.DoubleSide
    } else {
      m.side =
        mesh.userData.primitiveDoubleSided === true ? THREE.DoubleSide : THREE.FrontSide
    }
    // Event photos / unlit node maps: full albedo visibility (no leftover alphaTest/tint).
    if (
      options?.gltfNodeModifier === true &&
      !isPbr &&
      !isCloseUiChip
    ) {
      // Plaza thumbnails omit diffuseColor — keep white multiply so map is not crushed.
      if (!hasAlphaTextureSlot) {
        m.color.setRGB(1, 1, 1)
        m.transparent = false
        m.alphaTest = 0
        m.depthWrite = true
        m.opacity = 1
      }
      if (m.map) {
        m.map.colorSpace = THREE.SRGBColorSpace
        m.map.needsUpdate = true
      }
      // In front of dim blackMask (renderOrder -10).
      mesh.renderOrder = Math.max(mesh.renderOrder, 2)
      mesh.frustumCulled = false
    }
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

/** Flip mesh local X so atlas UVs stay on-sheet while content reads L→R. */
function ensureMeshContentFlipX(mesh: THREE.Mesh, wantFlip: boolean): void {
  const has = !!mesh.userData.dclPlaneContentFlipX
  if (has === wantFlip) return
  // Always flip relative to +1 base so re-applies are stable.
  const mag = Math.abs(mesh.scale.x) < 1e-8 ? 1 : Math.abs(mesh.scale.x)
  mesh.scale.x = wantFlip ? -mag : mag
  mesh.userData.dclPlaneContentFlipX = wantFlip
}

/** Tall atlas cells (e.g. 64×128 event_menu_arrow) vs wide buttons (JUMP IN). */
function meshAtlasUvIsTall(mesh: THREE.Mesh): boolean {
  const uv = mesh.geometry?.getAttribute('uv') as THREE.BufferAttribute | undefined
  if (!uv || uv.count < 4) return false
  let umin = Infinity
  let umax = -Infinity
  let vmin = Infinity
  let vmax = -Infinity
  // North face first (first 4 verts of dual DCL plane).
  const n = Math.min(4, uv.count)
  for (let i = 0; i < n; i++) {
    const u = uv.getX(i)
    const v = uv.getY(i)
    if (u < umin) umin = u
    if (u > umax) umax = u
    if (v < vmin) vmin = v
    if (v > vmax) vmax = v
  }
  const du = umax - umin
  const dv = vmax - vmin
  if (du < 1e-6) return false
  return dv > du * 1.2
}

/**
 * Mirror geometry U within the attribute’s current [umin,umax] span (preserves atlas sub-rects).
 */
export function mirrorGeometryUInPlace(mesh: THREE.Mesh): void {
  let geo = mesh.geometry as THREE.BufferGeometry
  if (!geo?.getAttribute) return
  if (!geo.userData?.dclUniqueUv) {
    geo = geo.clone()
    geo.userData = { ...(mesh.geometry as THREE.BufferGeometry).userData, dclUniqueUv: true }
    mesh.geometry = geo
  }
  const uv = geo.getAttribute('uv') as THREE.BufferAttribute | undefined
  if (!uv || uv.count < 2) return
  let umin = Infinity
  let umax = -Infinity
  for (let i = 0; i < uv.count; i++) {
    const u = uv.getX(i)
    if (u < umin) umin = u
    if (u > umax) umax = u
  }
  if (!(umax - umin > 1e-8)) return
  const sum = umin + umax
  for (let i = 0; i < uv.count; i++) {
    uv.setX(i, sum - uv.getX(i))
  }
  uv.needsUpdate = true
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

  // AUTO — cutout only with a dedicated alpha map (Unity Explorer parity).
  // Albedo-only PNG alpha is ignored; transparent texels draw as their RGB (often black).
  if (hasAlphaMap) {
    m.alphaTest = alphaTest ?? 0.5
    return
  }
  // Color-only alpha (plaza blackMask fade) — blend without writing depth.
  if (alpha < 0.999) {
    m.transparent = true
    m.opacity = alpha
    m.depthWrite = false
  }
}
