import * as THREE from 'three'
import type { Entity } from '@dcl/ecs'
import type { PBNftShape } from '@dcl/ecs/dist/components/generated/pb/decentraland/sdk/components/nft_shape.gen'
import type { MirrorComponents } from './mirrorComponents'
import type { ProjectionView } from './ProjectionView'
import type { AssetCache } from '../rendering/AssetCache'
import { fetchNftInfo } from '../media/nftInfo'
import { color3ToThree } from './pbColor'
import { buildDclPlaneGeometry } from './primitiveShapes'
import { disposeOwnedObject3D } from '../rendering/sharedAsset'
import { proxiedTextureUrl } from '../rendering/textureProxy'

/** Default purple background (SDK docs). */
const DEFAULT_BG = { r: 0.6404918, g: 0.611472, b: 0.8584906 }

/** NftFrameType enum values (const enum not importable under isolatedModules). */
const STYLE_NONE = 22
const STYLE_CLASSIC = 0

const NFT_ROOT = '__nft_shape'
/** Longest edge of the picture plane in meters (Unity ~1m). */
const BASE_SIZE = 1

type FrameStyle = {
  border: number
  color: number
  metalness: number
  roughness: number
  emissive?: number
  emissiveIntensity?: number
}

function styleLook(style: number | undefined): FrameStyle | null {
  const s = style ?? STYLE_CLASSIC
  if (s === STYLE_NONE) return null
  switch (s) {
    case 1: // BAROQUE
      return { border: 0.08, color: 0xc9a227, metalness: 0.55, roughness: 0.35 }
    case 2: // DIAMOND
      return { border: 0.07, color: 0xddeeff, metalness: 0.85, roughness: 0.15 }
    case 3: // MINIMAL_WIDE
      return { border: 0.06, color: 0xeeeeee, metalness: 0.1, roughness: 0.55 }
    case 4: // MINIMAL_GREY
      return { border: 0.04, color: 0x888888, metalness: 0.05, roughness: 0.7 }
    case 5: // BLOCKY
      return { border: 0.1, color: 0x333333, metalness: 0.0, roughness: 0.9 }
    case 6: // GOLD_EDGES
      return { border: 0.05, color: 0xd4af37, metalness: 0.8, roughness: 0.25 }
    case 7: // GOLD_CARVED
      return { border: 0.07, color: 0xb8860b, metalness: 0.75, roughness: 0.3 }
    case 8: // GOLD_WIDE
      return { border: 0.1, color: 0xd4af37, metalness: 0.8, roughness: 0.25 }
    case 9: // GOLD_ROUNDED
      return { border: 0.06, color: 0xe6c35c, metalness: 0.7, roughness: 0.28 }
    case 10: // METAL_MEDIUM
      return { border: 0.05, color: 0x9aa0a6, metalness: 0.9, roughness: 0.3 }
    case 11: // METAL_WIDE
      return { border: 0.09, color: 0x9aa0a6, metalness: 0.9, roughness: 0.3 }
    case 12: // METAL_SLIM
      return { border: 0.03, color: 0xa8b0b8, metalness: 0.92, roughness: 0.25 }
    case 13: // METAL_ROUNDED
      return { border: 0.05, color: 0xb0b8c0, metalness: 0.88, roughness: 0.28 }
    case 14: // PINS
      return { border: 0.035, color: 0x555555, metalness: 0.4, roughness: 0.5 }
    case 15: // MINIMAL_BLACK
      return { border: 0.04, color: 0x111111, metalness: 0.05, roughness: 0.75 }
    case 16: // MINIMAL_WHITE
      return { border: 0.04, color: 0xf5f5f5, metalness: 0.05, roughness: 0.65 }
    case 17: // TAPE
      return { border: 0.025, color: 0xc4b59a, metalness: 0.0, roughness: 0.85 }
    case 18: // WOOD_SLIM
      return { border: 0.035, color: 0x8b5a2b, metalness: 0.05, roughness: 0.75 }
    case 19: // WOOD_WIDE
      return { border: 0.09, color: 0x6b4226, metalness: 0.05, roughness: 0.8 }
    case 20: // WOOD_TWIGS
      return { border: 0.06, color: 0x5a3a1a, metalness: 0.0, roughness: 0.9 }
    case 21: // CANVAS
      return { border: 0.05, color: 0xe8dcc8, metalness: 0.0, roughness: 0.85 }
    case STYLE_CLASSIC:
    default:
      // Classic: thin dark frame + soft emissive pulse edge feel
      return {
        border: 0.045,
        color: 0x2a2040,
        metalness: 0.2,
        roughness: 0.55,
        emissive: 0x6b4dff,
        emissiveIntensity: 0.35
      }
  }
}

function nftKey(entity: Entity): string {
  return `${NFT_ROOT}_${entity}`
}

function signature(spec: PBNftShape): string {
  const c = spec.color
  return `${spec.urn}|${spec.style ?? STYLE_CLASSIC}|${c?.r ?? ''},${c?.g ?? ''},${c?.b ?? ''}`
}

/**
 * ECS NftShape (1040) — framed NFT picture planes.
 * Fetches image via DCL OpenSea proxy; builds procedural frames (style palette, not Unity GLBs).
 */
export class NftShapeBridge {
  private lastSig = new Map<Entity, string>()
  private inflight = new Set<Entity>()
  private generation = new Map<Entity, number>()

  constructor(
    private readonly ecs: MirrorComponents,
    private readonly cache: AssetCache,
    private readonly getNodes: () => Map<Entity, THREE.Group> | undefined
  ) {}

  dispose(): void {
    const nodes = this.getNodes()
    if (nodes) {
      for (const entity of this.lastSig.keys()) {
        this.clearEntity(entity, nodes.get(entity))
      }
    }
    this.lastSig.clear()
    this.inflight.clear()
    this.generation.clear()
  }

  /** Diff NftShape components and rebuild when urn/style/color change. */
  sync(view: ProjectionView): void {
    const { NftShape } = this.ecs
    const nodes = this.getNodes()
    if (!nodes) return

    const live = new Set<Entity>()
    for (const [entity, raw] of view.getEntitiesWith(NftShape)) {
      live.add(entity)
      const spec = raw as PBNftShape
      const urn = spec.urn?.trim() ?? ''
      if (!urn) {
        this.clearEntity(entity, nodes.get(entity))
        this.lastSig.delete(entity)
        continue
      }
      const sig = signature(spec)
      if (this.lastSig.get(entity) === sig) continue
      this.lastSig.set(entity, sig)
      const gen = (this.generation.get(entity) ?? 0) + 1
      this.generation.set(entity, gen)
      void this.attach(entity, spec, gen)
    }

    for (const entity of [...this.lastSig.keys()]) {
      if (live.has(entity)) continue
      this.clearEntity(entity, nodes.get(entity))
      this.lastSig.delete(entity)
      this.generation.delete(entity)
    }
  }

  private clearEntity(entity: Entity, obj?: THREE.Group): void {
    if (!obj) return
    const existing = obj.getObjectByName(nftKey(entity))
    if (existing) {
      disposeOwnedObject3D(existing)
      obj.remove(existing)
    }
  }

  private async attach(entity: Entity, spec: PBNftShape, gen: number): Promise<void> {
    if (this.inflight.has(entity)) {
      // Newer generation will re-run after; still kick load.
    }
    this.inflight.add(entity)
    try {
      const info = await fetchNftInfo(spec.urn)
      if (this.generation.get(entity) !== gen) return
      const nodes = this.getNodes()
      const obj = nodes?.get(entity)
      if (!obj) return

      if (!info) {
        this.mountPlaceholder(entity, obj, spec, 'NFT not found')
        return
      }

      let texture: THREE.Texture
      try {
        texture = await this.loadNftTexture(info.imageUrl)
      } catch {
        if (this.generation.get(entity) !== gen) return
        this.mountPlaceholder(entity, obj, spec, 'Image failed')
        return
      }
      if (this.generation.get(entity) !== gen) return

      this.mountPicture(entity, obj, spec, texture)
    } finally {
      this.inflight.delete(entity)
    }
  }

  private async loadNftTexture(url: string): Promise<THREE.Texture> {
    // Prefer raster via AssetCache (proxied CORS). SVG often fails TextureLoader — canvas fallback.
    const lower = url.split('?')[0]!.toLowerCase()
    if (lower.endsWith('.svg')) {
      return loadTextureViaImage(url)
    }
    try {
      return await this.cache.loadTexture(url)
    } catch {
      return loadTextureViaImage(url)
    }
  }

  private mountPlaceholder(
    entity: Entity,
    obj: THREE.Group,
    spec: PBNftShape,
    label: string
  ): void {
    this.clearEntity(entity, obj)
    const root = new THREE.Group()
    root.name = nftKey(entity)
    const bg = color3ToThree(spec.color ?? DEFAULT_BG)
    const geo = buildDclPlaneGeometry(BASE_SIZE, BASE_SIZE)
    const mat = new THREE.MeshStandardMaterial({
      color: bg,
      side: THREE.DoubleSide,
      roughness: 0.8,
      metalness: 0.05
    })
    const plane = new THREE.Mesh(geo, mat)
    plane.name = 'nft_placeholder'
    root.add(plane)
    root.userData.nftPlaceholder = label
    obj.add(root)
  }

  private mountPicture(
    entity: Entity,
    obj: THREE.Group,
    spec: PBNftShape,
    texture: THREE.Texture
  ): void {
    this.clearEntity(entity, obj)

    const img = texture.image as { width?: number; height?: number } | undefined
    const iw = Math.max(1, img?.width ?? 512)
    const ih = Math.max(1, img?.height ?? 512)
    const aspect = iw / ih
    let width = BASE_SIZE
    let height = BASE_SIZE
    if (aspect >= 1) height = BASE_SIZE / aspect
    else width = BASE_SIZE * aspect

    const root = new THREE.Group()
    root.name = nftKey(entity)
    root.userData.nftUrn = spec.urn

    const bgColor = color3ToThree(spec.color ?? DEFAULT_BG)
    const style = styleLook(spec.style)

    // Background (visible through transparent pixels + back face color).
    if (style !== null || spec.color) {
      const bgGeo = buildDclPlaneGeometry(width, height)
      const bgMat = new THREE.MeshStandardMaterial({
        color: bgColor,
        side: THREE.DoubleSide,
        roughness: 0.85,
        metalness: 0.0
      })
      const bgMesh = new THREE.Mesh(bgGeo, bgMat)
      bgMesh.name = 'nft_bg'
      bgMesh.position.z = -0.005
      root.add(bgMesh)
    }

    texture.colorSpace = THREE.SRGBColorSpace
    texture.needsUpdate = true
    const imgGeo = buildDclPlaneGeometry(width, height)
    const imgMat = new THREE.MeshStandardMaterial({
      map: texture,
      transparent: true,
      side: THREE.FrontSide,
      roughness: 0.65,
      metalness: 0.0,
      depthWrite: true
    })
    const imgMesh = new THREE.Mesh(imgGeo, imgMat)
    imgMesh.name = 'nft_image'
    imgMesh.position.z = 0.001
    root.add(imgMesh)

    if (style) {
      addProceduralFrame(root, width, height, style)
    }

    obj.add(root)
  }
}

function addProceduralFrame(
  root: THREE.Group,
  width: number,
  height: number,
  style: FrameStyle
): void {
  const b = style.border
  const mat = new THREE.MeshStandardMaterial({
    color: style.color,
    metalness: style.metalness,
    roughness: style.roughness,
    ...(style.emissive != null
      ? { emissive: new THREE.Color(style.emissive), emissiveIntensity: style.emissiveIntensity ?? 0.35 }
      : {})
  })

  const depth = Math.max(0.02, b * 0.6)
  const hw = width / 2
  const hh = height / 2

  // Outer rim pieces (top/bottom/left/right).
  const pieces: Array<{ w: number; h: number; x: number; y: number }> = [
    { w: width + b * 2, h: b, x: 0, y: hh + b / 2 },
    { w: width + b * 2, h: b, x: 0, y: -(hh + b / 2) },
    { w: b, h: height, x: -(hw + b / 2), y: 0 },
    { w: b, h: height, x: hw + b / 2, y: 0 }
  ]

  const frame = new THREE.Group()
  frame.name = 'nft_frame'
  for (const p of pieces) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(p.w, p.h, depth), mat)
    mesh.position.set(p.x, p.y, -depth / 2)
    frame.add(mesh)
  }
  root.add(frame)
}

/** Image → canvas texture (SVG / CORS-hard hosts). Uses texture proxy when needed. */
async function loadTextureViaImage(url: string): Promise<THREE.Texture> {
  const src = proxiedTextureUrl(url)
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const el = new Image()
    el.crossOrigin = 'anonymous'
    el.onload = () => resolve(el)
    el.onerror = () => reject(new Error(`image load failed: ${src}`))
    el.src = src
  })

  // Rasterize large images down a bit for GPU memory.
  const maxDim = 1024
  let w = img.naturalWidth || img.width || 512
  let h = img.naturalHeight || img.height || 512
  if (w > maxDim || h > maxDim) {
    const scale = maxDim / Math.max(w, h)
    w = Math.max(1, Math.round(w * scale))
    h = Math.max(1, Math.round(h * scale))
  }
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('2d context unavailable')
  ctx.drawImage(img, 0, 0, w, h)
  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.needsUpdate = true
  return tex
}
