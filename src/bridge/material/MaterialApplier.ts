import * as THREE from 'three'
import type { ResolvedScene } from '../../dcl/content/types'
import type { AssetCache } from '../../rendering/AssetCache'
import { isSharedAssetResource } from '../../rendering/sharedAsset'
import { renderQuality } from '../../rendering/RenderQualitySettings'
import { setMeshDesiredCastShadow } from '../../rendering/shadowCastPolicy'
import { resolveSceneTextureUrl } from './resolveTexture'
import { applyPbrColors, applyPbrScalars, configureEmissiveRendering } from './pbrApply'
import { configureSceneVideoTexture } from '../../media/videoTextureOrientation'
import {
  DEPTH_BAND_BLEND_SURFACE,
  DEPTH_BAND_MARKER_GLOW,
  DEPTH_BAND_OPAQUE_SOLID
} from './depthCompositeBands'

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
export function materialFingerprint(pb: PbMaterial): string {
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
 *
 * Quality gate (pixelwars / board games stamp 10k+ MeshRenderers with default cast):
 * - ultra: SDK default (cast when castShadows !== false)
 * - high: only when author sets castShadows === true (avoid 12k-caster FPS death)
 * - medium/low/off: never cast from materials
 * Explicit false always wins.
 */
export function applyMaterialCastShadows(
  mesh: THREE.Mesh,
  castShadows: boolean | undefined
): void {
  const q = renderQuality.getShadowQuality()
  let cast = false
  if (castShadows === false) {
    cast = false
  } else if (q === 'ultra') {
    // SDK default: cast when not explicitly false
    cast = true
  } else if (q === 'high') {
    // Explicit true only — 10k+ MeshRenderer boards default-true and kill FPS
    cast = castShadows === true
  }
  // Author Material path wins over GltfContainer ultra-default cast marker.
  setMeshDesiredCastShadow(mesh, cast, 'environment', { gltfDefaultCaster: false })
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

/** True when material is color-only (safe for MeshRenderer instancing + instanceColor). */
export function materialIsScalarOnly(pb: PbMaterial): boolean {
  return !materialHasTextureSlots(pb) && !hasVideoOrAvatarSlot(pb)
}

function hasVideoOrAvatarSlot(pb: PbMaterial): boolean {
  for (const slot of materialTextureSlots(pb)) {
    if (slot?.tex?.$case === 'videoTexture' || slot?.tex?.$case === 'avatarTexture') return true
  }
  return false
}

/** Normalize a color channel — DCL is usually 0–1; some content still emits 0–255. */
function normChannel(v: number | undefined, fallback: number): number {
  if (v === undefined || Number.isNaN(v)) return fallback
  if (v > 1) return Math.min(1, v / 255)
  return Math.max(0, v)
}

/** RGB 0–1 for instanceColor / palette (unlit diffuse or pbr albedo). */
export function materialAlbedoRgb(pb: PbMaterial): { r: number; g: number; b: number } {
  const materialCase = pb.material?.$case
  if (materialCase === 'unlit') {
    const d = pb.material!.unlit.diffuseColor
    return {
      r: normChannel(d?.r, 1),
      g: normChannel(d?.g, 1),
      b: normChannel(d?.b, 1)
    }
  }
  if (materialCase === 'pbr') {
    const a = pb.material!.pbr.albedoColor
    const e = pb.material!.pbr.emissiveColor
    const er = e ? normChannel(e.r, 0) : 0
    const eg = e ? normChannel(e.g, 0) : 0
    const eb = e ? normChannel(e.b, 0) : 0
    const emissiveLum = (er + eg + eb) / 3
    // Selection rings / click markers: white albedo + colored emissive — instanceColor
    // must use emissive or GPU instances stay mat#ffffff and rings vanish on light ground.
    if (a) {
      const ar = normChannel(a.r, 1)
      const ag = normChannel(a.g, 1)
      const ab = normChannel(a.b, 1)
      const albedoLum = (ar + ag + ab) / 3
      if (albedoLum > 0.88 && emissiveLum > 0.12) {
        return { r: er, g: eg, b: eb }
      }
      return { r: ar, g: ag, b: ab }
    }
    if (e && emissiveLum > 0) {
      return { r: er, g: eg, b: eb }
    }
  }
  return { r: 1, g: 1, b: 1 }
}

/** Alpha 0–1 from unlit/pbr color. */
export function materialAlbedoAlpha(pb: PbMaterial): number {
  const materialCase = pb.material?.$case
  if (materialCase === 'unlit') {
    return normChannel(pb.material!.unlit.diffuseColor?.a, 1)
  }
  if (materialCase === 'pbr') {
    return normChannel(pb.material!.pbr.albedoColor?.a, 1)
  }
  return 1
}

/** Shared Three materials for scalar MeshRenderers (refcounted by fingerprint). */
const scalarMaterialPool = new Map<string, { mat: THREE.Material; refs: number }>()

export function acquireScalarMaterial(pb: PbMaterial): THREE.Material {
  const fp = materialFingerprint(pb)
  let entry = scalarMaterialPool.get(fp)
  if (!entry) {
    const materialCase = pb.material?.$case
    const isUnlit = materialCase === 'unlit'
    const mat = isUnlit
      ? new THREE.MeshBasicMaterial({ color: 0xffffff })
      : new THREE.MeshPhysicalMaterial({ color: 0xffffff })
    // Apply colors onto a temp mesh path — use white base; instanceColor multiplies.
    const rgb = materialAlbedoRgb(pb)
    if ('color' in mat) (mat as THREE.MeshBasicMaterial).color.setRGB(rgb.r, rgb.g, rgb.b)
    const alpha =
      materialCase === 'pbr'
        ? (pb.material!.pbr.albedoColor?.a ?? 1)
        : materialCase === 'unlit'
          ? (pb.material!.unlit.diffuseColor?.a ?? 1)
          : 1
    if (alpha < 0.999) {
      mat.transparent = true
      mat.opacity = alpha
      mat.depthWrite = alpha > 0.95
    }
    mat.userData.dclScalarMaterialFp = fp
    entry = { mat, refs: 0 }
    scalarMaterialPool.set(fp, entry)
  }
  entry.refs++
  return entry.mat
}

export function releaseScalarMaterial(mat: THREE.Material | null | undefined): void {
  if (!mat) return
  const fp = mat.userData.dclScalarMaterialFp as string | undefined
  if (!fp) {
    if (!isSharedAssetResource(mat)) mat.dispose()
    return
  }
  const entry = scalarMaterialPool.get(fp)
  if (!entry || entry.mat !== mat) {
    if (!isSharedAssetResource(mat)) mat.dispose()
    return
  }
  entry.refs = Math.max(0, entry.refs - 1)
  if (entry.refs === 0) {
    scalarMaterialPool.delete(fp)
    entry.mat.dispose()
  }
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

  /**
   * Mark scalar Material as applied without walking meshes.
   * Used for InstancedMesh boards (color lives in instanceColor, not a private Mesh material).
   */
  markScalarApplied(entity: number, pb: PbMaterial): void {
    if (
      materialHasTextureSlots(pb) ||
      this.hasUnresolvedVideo(pb) ||
      this.hasUnresolvedAvatar(pb)
    ) {
      return
    }
    this.applied.set(entity, `scalar:${materialFingerprint(pb)}`)
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
      // GLB / non-plane meshes: event-card map-U path. Material re-apply without this flag
      // skipped flipMapU entirely (primitiveMeshKey only) → plaza posters L–R mirrored.
      const gltfMesh = mesh.userData.primitiveMeshKey == null
      const ok = await this.applyToMesh(
        mesh,
        pb,
        gltfMesh ? { gltfNodeModifier: true } : undefined
      )
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

    const alpha =
      (isPbr ? (inner as PbrMaterial).albedoColor?.a : (inner as UnlitMaterial).diffuseColor?.a) ?? 1
    // Dedicated alphaMap only — do not treat albedo map as AUTO cutout (Unity parity).
    const hasAlphaMap =
      !!(m as THREE.MeshPhysicalMaterial).alphaMap || !!(m as THREE.MeshBasicMaterial).alphaMap

    if (m instanceof THREE.MeshPhysicalMaterial) {
      const pbr = inner as PbrMaterial
      applyPbrColors(m, pbr)
      applyPbrScalars(m, pbr)
      const emissiveUnion = coerceTextureUnion(pbr.emissiveTexture)
      const mainUnion = coerceTextureUnion(inner.texture)
      if (emissiveUnion && m.map && textureUnionSameSrc(emissiveUnion, mainUnion)) {
        m.emissiveMap = m.map
      }
      // Transparency first, then glow — glow re-forces depthWrite=false for click rings.
      applyTransparency(m, alpha, inner.alphaTest, pbr.transparencyMode, hasAlphaMap)
      configureEmissiveRendering(
        m,
        pbr.emissiveIntensity,
        !!m.emissiveMap,
        pbr.transparencyMode
      )
      applyGlowMarkerRenderOrder(mesh, m, pbr.transparencyMode, pbr.emissiveIntensity)
      applyBlendSurfaceRenderOrder(mesh, m)
    } else {
      const diffuse = (inner as UnlitMaterial).diffuseColor
      if (diffuse) {
        m.color.setRGB(diffuse.r ?? 1, diffuse.g ?? 1, diffuse.b ?? 1)
      }
      applyTransparency(
        m,
        alpha,
        inner.alphaTest,
        isPbr ? (inner as PbrMaterial).transparencyMode : MTM_AUTO,
        hasAlphaMap
      )
      applyBlendSurfaceRenderOrder(mesh, m)
    }

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
    // MeshRenderer planes: flipY on (TextureLoader / DCL V=0 bottom). Marquee re-basis
    // and GltfNodeModifiers keep flipY off (glTF UV space). Do not gate MeshRenderer
    // flipY on primitiveMeshKey — press_e / fold apply can land before the key is stamped,
    // which uploaded the atlas upside-down over the fishing bobber.
    const geo = mesh.geometry as THREE.BufferGeometry | undefined
    const marqueeAtlas = !!geo?.userData?.dclTextAlongYBasis
    const flipY = !marqueeAtlas && !options?.gltfNodeModifier
    // ── Plaza event-card law (from Genesis bin/index.js + event_card_thumbnail.glb) ──
    // Bundle: GltfContainer(event_card_thumbnail.glb) + GltfNodeModifiers path "" unlit
    //   Texture.Common({ src: event.thumbnailSrc }) — live events CDN poster (L→R correct).
    // GLB mesh `thumbnail_plane`: XY card, extent X=2 Y=1 Z=0; UVs LH-mirrored
    //   (u@x=-1 → 1, u@x=+1 → 0). Parent scale is +ve (5,5,1) — not scale.x=-1.
    // Texture ST flips were undone by Material re-apply / TextureMove. **Geometry U flip**
    // normalizes LH UVs once (cloned buffer) and survives re-apply. Texture map-U flip is
    // reserved for MeshRenderer planes with world scale.x < 0 (Poker boards, etc.).
    const worldMirror = objectWorldMirrorX(mesh)
    const uvMirror = meshUvMapsUMirroredHorizontal(mesh)
    const isGltfMaterialPath = !!options?.gltfNodeModifier && !marqueeAtlas
    // Event-card quads only. Curved marquees (uvAnimScreen) fail the U-mirror heuristic
    // and a geometry U flip slides the LED border onto the side faces.
    if (isGltfMaterialPath) {
      ensureGeometryUFlipped(mesh, isFlatCardGeometry(mesh.geometry) && uvMirror)
    }
    // After UV normalize, only cancel world reflection via texture ST.
    const flipMapU =
      !marqueeAtlas &&
      (isGltfMaterialPath
        ? worldMirror
        : mesh.userData.primitiveMeshKey != null && worldMirror)

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
        // Authored/held ST only for GLB — never inherit flipped previous.repeat.
        this.applyUvTransform(
          mainTex,
          getTextureDef(mainUnion),
          isGltfMaterialPath ? null : prev,
          mesh
        )
        if (mainUnion.tex?.$case === 'texture') flipTextureU(mainTex, flipMapU)
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
          this.applyUvTransform(
            alphaTex,
            getTextureDef(alphaUnion),
            isGltfMaterialPath ? null : prev,
            mesh
          )
          if (alphaUnion.tex?.$case === 'texture') flipTextureU(alphaTex, flipMapU)
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
            this.applyUvTransform(
              emissiveTex,
              getTextureDef(emissiveUnion),
              isGltfMaterialPath ? null : prev,
              mesh
            )
            if (emissiveUnion.tex?.$case === 'texture') flipTextureU(emissiveTex, flipMapU)
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
          this.applyUvTransform(
            bumpTex,
            getTextureDef(bumpUnion),
            isGltfMaterialPath ? null : prev,
            mesh
          )
          if (bumpUnion.tex?.$case === 'texture') flipTextureU(bumpTex, flipMapU)
        }
      }
      // Re-apply after maps land — emissiveIntensity drives flame brightness when albedoColor is absent.
      applyPbrColors(m, pbr)
      applyPbrScalars(m, pbr)
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

    // Glow after transparency so depthWrite=false sticks for click rings (not fog covers).
    if (m instanceof THREE.MeshPhysicalMaterial && isPbr) {
      const pbr = inner as PbrMaterial
      configureEmissiveRendering(
        m,
        pbr.emissiveIntensity,
        !!m.emissiveMap,
        pbr.transparencyMode
      )
      applyGlowMarkerRenderOrder(mesh, m, pbr.transparencyMode, pbr.emissiveIntensity)
    }
    applyBlendSurfaceRenderOrder(mesh, m)

    // Material.castShadows → mesh.castShadow (see applyMaterialCastShadows).
    applyMaterialCastShadows(mesh, inner.castShadows)
    // Marquees face inward (FrontSide). Dual-face DCL plane geometry already has both
    // normals — FrontSide shows both. DoubleSide only when author marks primitiveDoubleSided.
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
    // Clone may copy userData from a previously flipped instance — always start unflipped.
    tex.userData.dclMapUFlipped = false
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
   *
   * **Map U orientation law:** `dclMapUFlipped` must stay in sync with actual ST.
   * Copying previous.repeat (already U-flipped for event cards) without the flag makes
   * flipTextureU double-flip on re-apply → plaza event cards L–R mirrored again.
   * Authored/held ST is unflipped base → clear the flag before flipTextureU runs.
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

    let orientationKnown = false

    // TextureMove held ST is always **base/unflipped** DCL space. Prefer it over previous
    // (which may already carry map-U flip ST) so flipTextureU can re-apply cleanly.
    if (held?.tiling) {
      tex.repeat.set(held.x, held.y)
      tex.userData.dclMapUFlipped = false
      orientationKnown = true
    } else if (def?.tiling) {
      tex.repeat.set(def.tiling.x ?? 1, def.tiling.y ?? 1)
      tex.userData.dclMapUFlipped = false
      orientationKnown = true
    } else if (previous && previous !== tex && !held) {
      tex.repeat.copy(previous.repeat)
      tex.userData.dclMapUFlipped = !!previous.userData.dclMapUFlipped
      orientationKnown = true
    }

    if (held && !held.tiling) {
      tex.offset.set(held.x, held.y)
      // Base-space offset — force unflipped so flipTextureU is absolute.
      tex.userData.dclMapUFlipped = false
      orientationKnown = true
      // Drop any flipped residual from previous.repeat if we skipped that inherit.
      if (tex.repeat.x < 0) tex.repeat.x = Math.abs(tex.repeat.x) || 1
    } else if (def?.offset) {
      tex.offset.set(def.offset.x ?? 0, def.offset.y ?? 0)
      if (!orientationKnown) {
        tex.userData.dclMapUFlipped = false
        orientationKnown = true
      }
    } else if (previous && previous !== tex && !held) {
      tex.offset.copy(previous.offset)
      if (!orientationKnown) {
        tex.userData.dclMapUFlipped = !!previous.userData.dclMapUFlipped
        orientationKnown = true
      }
    }

    if (!orientationKnown) {
      // Fresh clone defaults — unflipped base for flipTextureU.
      tex.userData.dclMapUFlipped = false
    }
  }
}

function getTextureDef(union?: TextureUnion): TextureDef | undefined {
  const coerced = coerceTextureUnion(union)
  return coerced?.tex?.$case === 'texture' ? coerced.tex.texture : undefined
}

/** Event-card / poster quads — not curved marquees or furniture. */
function isFlatCardGeometry(geo: THREE.BufferGeometry | undefined): boolean {
  if (!geo) return false
  const pos = geo.getAttribute('position')
  if (!pos || pos.count > 12) return false
  if (!geo.boundingBox) geo.computeBoundingBox()
  const box = geo.boundingBox
  if (!box) return false
  const sx = box.max.x - box.min.x
  const sy = box.max.y - box.min.y
  const sz = box.max.z - box.min.z
  const thick = Math.min(sx, sy, sz)
  const wide = Math.max(sx, sy, sz)
  return wide > 1e-4 && thick / wide < 0.08
}

/**
 * Flip geometry U in place (1−u). Idempotent via mesh.userData.dclGeomUFlipped.
 * Clones geometry first so shared GLB buffers are not mutated for every instance.
 * Survives Material re-clone / TextureMove (texture ST no longer carries orientation).
 */
function ensureGeometryUFlipped(mesh: THREE.Mesh, want: boolean): void {
  const cur = !!mesh.userData.dclGeomUFlipped
  if (cur === want) return
  let geo = mesh.geometry as THREE.BufferGeometry | undefined
  if (!geo) return
  if (!mesh.userData.dclGeomUOwned) {
    geo = geo.clone()
    mesh.geometry = geo
    mesh.userData.dclGeomUOwned = true
  }
  const uv = geo.getAttribute('uv') as THREE.BufferAttribute | undefined
  if (!uv || uv.count < 1) return
  for (let i = 0; i < uv.count; i++) {
    uv.setX(i, 1 - uv.getX(i))
  }
  uv.needsUpdate = true
  mesh.userData.dclGeomUFlipped = want
}

/**
 * True when mesh UVs are L–R mirrored along the board's horizontal axis vs spatial order.
 * `event_card_thumbnail.glb`: XY plane (X=2, Z≈0), u@minX=1 u@maxX=0 → mirrored.
 * Also handles Z-wide billboards (dominant axis pick).
 */
export function meshUvMapsUMirroredHorizontal(mesh: THREE.Mesh): boolean {
  const pos = mesh.geometry?.getAttribute('position')
  const uv = mesh.geometry?.getAttribute('uv')
  if (!pos || !uv || pos.count < 2 || uv.count < 2) return false

  let minX = Infinity
  let maxX = -Infinity
  let minZ = Infinity
  let maxZ = -Infinity
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i)
    const z = pos.getZ(i)
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (z < minZ) minZ = z
    if (z > maxZ) maxZ = z
  }
  const extX = maxX - minX
  const extZ = maxZ - minZ
  // Prefer the wider horizontal axis; fall back if both thin.
  const useZ = extZ >= extX && extZ > 1e-5
  const useX = !useZ && extX > 1e-5
  if (!useX && !useZ) return false

  let minA = Infinity
  let maxA = -Infinity
  let uAtMin = 0
  let uAtMax = 0
  for (let i = 0; i < pos.count; i++) {
    const a = useZ ? pos.getZ(i) : pos.getX(i)
    const u = uv.getX(i)
    if (a < minA) {
      minA = a
      uAtMin = u
    }
    if (a > maxA) {
      maxA = a
      uAtMax = u
    }
  }
  if (!(maxA - minA > 1e-5)) return false
  return uAtMin > uAtMax + 1e-5
}

/**
 * True when an odd product of **local scale.x** in the parent chain reflects the mesh
 * (DCL boards often use Transform.scale.x = −1).
 *
 * Do **not** use matrixWorld.determinant(): dcl→Three handedness conversion can make
 * det &lt; 0 for ordinary positive-scale objects, which falsely flipped every
 * MeshRenderer plane (JUMP IN buttons, TextureMove marquees) L–R.
 */
function objectWorldMirrorX(obj: THREE.Object3D): boolean {
  return poseAwareMirrorX(obj)
}

/** scale.x product along the pose chain — skip drawRoot (identity, not ECS). */
export function poseAwareMirrorX(obj: THREE.Object3D): boolean {
  let sx = obj.scale.x
  const pose = (obj.userData.dclPoseNode as THREE.Object3D | undefined) ?? obj
  let o: THREE.Object3D | null = pose === obj ? obj.parent : pose
  for (let i = 0; i < 48 && o; i++) {
    if (o.name === 'draw-root' || o.name === 'pose-root' || o.name === 'scene-entities') break
    sx *= o.scale.x
    o = o.parent
  }
  return sx < 0
}

/**
 * Absolute map-U orientation: sample' = 1 − sample when wantFlip.
 * Idempotent vs `tex.userData.dclMapUFlipped` — requires applyUvTransform to keep that
 * flag honest (never leave flipped ST with flag false, or re-apply double-flips).
 * Event cards: first paint often before scale.x = −1; re-apply when scale settles.
 * Negative repeat requires RepeatWrapping (ClampToEdge breaks the U flip sample).
 */
function flipTextureU(tex: THREE.Texture, wantFlip = true): void {
  const isFlipped = !!tex.userData.dclMapUFlipped
  if (wantFlip === isFlipped) return
  if (wantFlip && tex.wrapS === THREE.ClampToEdgeWrapping) {
    tex.wrapS = THREE.RepeatWrapping
  }
  const rep = tex.repeat.x
  const off = tex.offset.x
  tex.repeat.x = -rep
  tex.offset.x = 1 - off
  tex.userData.dclMapUFlipped = wantFlip
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

/**
 * Click / selection glow discs (ALPHA_BLEND + high emissive, no maps) must paint after
 * blend covers. renderOrder is local to the transparent pass — use platform bands.
 */
function applyGlowMarkerRenderOrder(
  mesh: THREE.Mesh,
  m: THREE.MeshPhysicalMaterial,
  transparencyMode: number | undefined,
  emissiveIntensity: number | undefined
): void {
  const alphaBlend = transparencyMode === MTM_ALPHA_BLEND || transparencyMode === MTM_ALPHA_TEST_AND_ALPHA_BLEND
  const intensity = emissiveIntensity ?? 1
  const emissiveLum = m.emissive.r + m.emissive.g + m.emissive.b
  const mapLessRing =
    alphaBlend &&
    !m.map &&
    !m.emissiveMap &&
    intensity >= 1.5 &&
    emissiveLum > 0.05
  if (!mapLessRing) {
    if (mesh.renderOrder === DEPTH_BAND_MARKER_GLOW) {
      mesh.renderOrder = DEPTH_BAND_OPAQUE_SOLID
    }
    return
  }
  mesh.renderOrder = DEPTH_BAND_MARKER_GLOW
  // Top-down VC looks at the cylinder cap; DoubleSide avoids backface cull if Y flips.
  m.side = THREE.DoubleSide
}

/**
 * Platform transparency → depth composite law (no alpha-threshold scene forks).
 *
 * - OPAQUE / ALPHA_TEST: solid depth write
 * - ALPHA_BLEND: occluding blend surface (depthWrite true; MARKER path re-forces false)
 * - Marker glow: configureEmissiveRendering after this sets depthWrite=false + MARKER band
 */
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
  m.depthTest = true

  if (resolved === MTM_OPAQUE) return

  if (resolved === MTM_ALPHA_TEST) {
    m.alphaTest = alphaTest ?? 0.5
    return
  }

  if (resolved === MTM_ALPHA_BLEND) {
    m.transparent = true
    m.opacity = alpha
    // Mode-stable: blend surfaces occlude underlays. Marker glow re-forces depthWrite=false.
    m.depthWrite = true
    return
  }

  if (resolved === MTM_ALPHA_TEST_AND_ALPHA_BLEND) {
    m.transparent = true
    m.opacity = alpha
    m.alphaTest = alphaTest ?? 0.5
    m.depthWrite = true
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
    m.depthWrite = true
  }
}

/** Assign BLEND_SURFACE band when mesh is semi-transparent and not a marker. */
export function applyBlendSurfaceRenderOrder(mesh: THREE.Mesh, m: THREE.Material): void {
  if (mesh.renderOrder === DEPTH_BAND_MARKER_GLOW) return
  if ((m as THREE.MeshPhysicalMaterial).transparent || (m as THREE.MeshBasicMaterial).transparent) {
    if (mesh.renderOrder === DEPTH_BAND_OPAQUE_SOLID) {
      mesh.renderOrder = DEPTH_BAND_BLEND_SURFACE
    }
  }
}
