import * as THREE from 'three'
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js'
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
import { setMeshDesiredCastShadow } from '../rendering/shadowCastPolicy'

/** Default purple background (SDK docs / Explorer). */
const DEFAULT_BG = { r: 0.6404918, g: 0.611472, b: 0.8584906 }

/** NftFrameType — index matches Unity NFTShapeFactory prefab order. */
const STYLE_NONE = 22
const STYLE_CLASSIC = 0

/**
 * Explorer frame meshes from unity-renderer NFTShape/Meshes (served from /nft-frames/).
 * Index = NftFrameType enum value.
 */
const FRAME_FBX: readonly (string | null)[] = [
  'Classic.fbx', // 0 NFT_CLASSIC
  'Barroque_01.fbx', // 1 BAROQUE_ORNAMENT
  'Barroque_02.fbx', // 2 DIAMOND_ORNAMENT
  'Basic_01.fbx', // 3 MINIMAL_WIDE
  'Basic_02.fbx', // 4 MINIMAL_GREY
  'Blocky_01.fbx', // 5 BLOCKY
  'Golden_01.fbx', // 6 GOLD_EDGES
  'Golden_02.fbx', // 7 GOLD_CARVED
  'Golden_03.fbx', // 8 GOLD_WIDE
  'Golden_04.fbx', // 9 GOLD_ROUNDED
  'Metal_01.fbx', // 10 METAL_MEDIUM
  'Metal_02.fbx', // 11 METAL_WIDE
  'Metal_03.fbx', // 12 METAL_SLIM
  'Metal_04.fbx', // 13 METAL_ROUNDED
  'Pin.fbx', // 14 PINS
  'SimpleBlack.fbx', // 15 MINIMAL_BLACK
  'SimpleWhite.fbx', // 16 MINIMAL_WHITE
  'Tapper.fbx', // 17 TAPE
  'Wood.fbx', // 18 WOOD_SLIM
  'Wood_02.fbx', // 19 WOOD_WIDE
  'WoodSticks.fbx', // 20 WOOD_TWIGS
  'SimpleCanvas.fbx', // 21 CANVAS
  null // 22 NFT_NONE
]

const FRAME_BASE = '/nft-frames/'

/** Longest edge of the NFT image plane in meters (Explorer ~1m before Transform scale). */
const BASE_SIZE = 1

const NFT_ROOT = '__nft_shape'

type FrameMatLook = {
  color: number
  metalness: number
  roughness: number
  emissive?: number
  emissiveIntensity?: number
}

function frameMaterialLook(style: number): FrameMatLook {
  switch (style) {
    case 1:
    case 6:
    case 7:
    case 8:
    case 9:
      return { color: 0xd4af37, metalness: 0.85, roughness: 0.28 }
    case 2:
      return { color: 0xddeeff, metalness: 0.9, roughness: 0.18 }
    case 3:
      return { color: 0xeeeeee, metalness: 0.08, roughness: 0.55 }
    case 4:
      return { color: 0x888888, metalness: 0.05, roughness: 0.7 }
    case 5:
      return { color: 0x333333, metalness: 0.0, roughness: 0.9 }
    case 10:
    case 11:
    case 12:
    case 13:
      return { color: 0x9aa0a6, metalness: 0.92, roughness: 0.28 }
    case 14:
      return { color: 0x555555, metalness: 0.45, roughness: 0.5 }
    case 15:
      return { color: 0x111111, metalness: 0.05, roughness: 0.75 }
    case 16:
      return { color: 0xf5f5f5, metalness: 0.05, roughness: 0.65 }
    case 17:
      return { color: 0xc4b59a, metalness: 0.0, roughness: 0.85 }
    case 18:
    case 19:
    case 20:
      return { color: 0x6b4226, metalness: 0.05, roughness: 0.8 }
    case 21:
      return { color: 0xe8dcc8, metalness: 0.0, roughness: 0.85 }
    case STYLE_CLASSIC:
    default:
      return {
        color: 0x2a2040,
        metalness: 0.25,
        roughness: 0.5,
        emissive: 0x6b4dff,
        emissiveIntensity: 0.4
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

type GifEntry = {
  img: HTMLImageElement
  canvas: HTMLCanvasElement
  ctx: CanvasRenderingContext2D
  texture: THREE.CanvasTexture
  /** Hide from layout but keep browser animating the GIF. */
  host: HTMLImageElement
}

/**
 * ECS NftShape (1040) — Explorer frame FBX + aspect-correct image plane.
 * GIFs animate via browser Image decode + per-frame canvas blit.
 */
export class NftShapeBridge {
  private lastSig = new Map<Entity, string>()
  private inflight = new Set<Entity>()
  private generation = new Map<Entity, number>()
  private readonly fbxLoader = new FBXLoader()
  private readonly frameTemplates = new Map<string, Promise<THREE.Group | null>>()
  private readonly gifs = new Map<Entity, GifEntry>()

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
    for (const entity of this.gifs.keys()) this.stopGif(entity)
    this.lastSig.clear()
    this.inflight.clear()
    this.generation.clear()
    this.frameTemplates.clear()
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

  /** Advance animated GIF textures (call every render frame). */
  update(): void {
    for (const entry of this.gifs.values()) {
      const { img, canvas, ctx, texture } = entry
      if (!img.complete || img.naturalWidth === 0) continue
      ctx.clearRect(0, 0, canvas.width, canvas.height)
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
      texture.needsUpdate = true
    }
  }

  private clearEntity(entity: Entity, obj?: THREE.Group): void {
    this.stopGif(entity)
    if (!obj) return
    const existing = obj.getObjectByName(nftKey(entity))
    if (existing) {
      disposeOwnedObject3D(existing)
      obj.remove(existing)
    }
  }

  private stopGif(entity: Entity): void {
    const g = this.gifs.get(entity)
    if (!g) return
    this.gifs.delete(entity)
    g.host.remove()
    g.texture.dispose()
  }

  private async attach(entity: Entity, spec: PBNftShape, gen: number): Promise<void> {
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
      let isGif = false
      try {
        const loaded = await this.loadNftTexture(info.imageUrl)
        texture = loaded.texture
        isGif = loaded.animated
      } catch {
        if (this.generation.get(entity) !== gen) return
        this.mountPlaceholder(entity, obj, spec, 'Image failed')
        return
      }
      if (this.generation.get(entity) !== gen) {
        abandonPendingGif(texture)
        return
      }

      const style = spec.style ?? STYLE_CLASSIC
      const frameRoot = style === STYLE_NONE ? null : await this.loadFrameTemplate(style)
      if (this.generation.get(entity) !== gen) {
        abandonPendingGif(texture)
        return
      }

      this.mountPicture(entity, obj, spec, texture, frameRoot, isGif)
    } finally {
      this.inflight.delete(entity)
    }
  }

  private loadFrameTemplate(style: number): Promise<THREE.Group | null> {
    const file = FRAME_FBX[style] ?? FRAME_FBX[STYLE_CLASSIC]
    if (!file) return Promise.resolve(null)
    const hit = this.frameTemplates.get(file)
    if (hit) return hit

    const url = `${FRAME_BASE}${file}`
    const task = this.fbxLoader
      .loadAsync(url)
      .then((root) => {
        // Normalize once — templates stay in cache; clones get look materials at mount.
        root.traverse((child) => {
          if ((child as THREE.Mesh).isMesh) {
            const mesh = child as THREE.Mesh
            setMeshDesiredCastShadow(mesh, true, 'environment')
            mesh.receiveShadow = true
          }
        })
        // Fit frame so its X/Y span is ~BASE_SIZE (image aperture).
        const box = new THREE.Box3().setFromObject(root)
        const size = new THREE.Vector3()
        box.getSize(size)
        const maxXY = Math.max(size.x, size.y, 1e-4)
        const s = BASE_SIZE / maxXY
        root.scale.setScalar(s)
        root.updateMatrixWorld(true)
        // Center on origin
        const center = new THREE.Vector3()
        box.setFromObject(root).getCenter(center)
        root.position.sub(center)
        return root
      })
      .catch((err) => {
        console.warn('[NftShape] frame FBX load failed', file, err)
        return null
      })

    this.frameTemplates.set(file, task)
    return task
  }

  private async loadNftTexture(
    url: string
  ): Promise<{ texture: THREE.Texture; animated: boolean }> {
    const lower = url.split('?')[0]!.toLowerCase()
    const isGif = lower.endsWith('.gif')
    const isSvg = lower.endsWith('.svg')

    if (isGif) {
      return { texture: await this.loadGifTexture(url), animated: true }
    }
    if (isSvg) {
      return { texture: await loadTextureViaImage(url), animated: false }
    }
    try {
      const tex = await this.cache.loadTexture(url)
      return { texture: tex, animated: false }
    } catch {
      return { texture: await loadTextureViaImage(url), animated: false }
    }
  }

  /**
   * Animated GIF: keep a hidden `<img>` so the browser advances frames,
   * blit to canvas each `update()` for a CanvasTexture (parity+ with Explorer).
   */
  private async loadGifTexture(url: string): Promise<THREE.CanvasTexture> {
    const src = proxiedTextureUrl(url)
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image()
      el.crossOrigin = 'anonymous'
      el.onload = () => resolve(el)
      el.onerror = () => reject(new Error(`gif load failed: ${src}`))
      el.src = src
    })

    const maxDim = 1024
    let w = img.naturalWidth || img.width || 512
    let h = img.naturalHeight || img.height || 512
    if (w > maxDim || h > maxDim) {
      const scale = maxDim / Math.max(w, h)
      w = Math.max(1, Math.round(w * scale))
      h = Math.max(1, Math.round(h * scale))
    }

    // Keep GIF animating: append off-screen (some engines pause non-DOM images).
    const host = img
    host.style.cssText =
      'position:fixed;left:-9999px;top:0;width:1px;height:1px;opacity:0;pointer-events:none'
    document.body.appendChild(host)

    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('2d context unavailable')
    ctx.drawImage(img, 0, 0, w, h)

    const texture = new THREE.CanvasTexture(canvas)
    texture.colorSpace = THREE.SRGBColorSpace
    texture.needsUpdate = true
    // Temporary hold until mountPicture registers on entity — store on texture userData.
    ;(texture as THREE.CanvasTexture & { userData: Record<string, unknown> }).userData.gifPending = {
      img,
      canvas,
      ctx,
      texture,
      host
    }
    return texture
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
    texture: THREE.Texture,
    frameTemplate: THREE.Group | null,
    isGif: boolean
  ): void {
    this.clearEntity(entity, obj)

    if (isGif) {
      const pending = (texture as THREE.Texture).userData?.gifPending as GifEntry | undefined
      if (pending) {
        this.gifs.set(entity, pending)
        delete (texture as THREE.Texture).userData.gifPending
      }
    }

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
    const style = spec.style ?? STYLE_CLASSIC

    // Background (transparency + back side) — Explorer always has this except NFT_NONE pure.
    {
      const bgGeo = buildDclPlaneGeometry(width, height)
      const bgMat = new THREE.MeshStandardMaterial({
        color: bgColor,
        side: THREE.DoubleSide,
        roughness: 0.85,
        metalness: 0.0
      })
      const bgMesh = new THREE.Mesh(bgGeo, bgMat)
      bgMesh.name = 'nft_bg'
      bgMesh.position.z = -0.008
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
    imgMesh.position.z = 0.002
    root.add(imgMesh)

    if (frameTemplate && style !== STYLE_NONE) {
      const frame = frameTemplate.clone(true)
      frame.name = 'nft_frame_fbx'
      // Scale frame XY to wrap the image (frame template normalized to BASE_SIZE).
      const span = Math.max(width, height)
      frame.scale.multiplyScalar(span / BASE_SIZE)
      applyFrameMaterials(frame, frameMaterialLook(style))
      // Sit slightly behind image so glass/edge doesn't z-fight the plane.
      frame.position.z = -0.02
      root.add(frame)
    }

    obj.add(root)
  }
}

function applyFrameMaterials(root: THREE.Object3D, look: FrameMatLook): void {
  root.traverse((child) => {
    if (!(child as THREE.Mesh).isMesh) return
    const mesh = child as THREE.Mesh
    const mat = new THREE.MeshStandardMaterial({
      color: look.color,
      metalness: look.metalness,
      roughness: look.roughness,
      ...(look.emissive != null
        ? {
            emissive: new THREE.Color(look.emissive),
            emissiveIntensity: look.emissiveIntensity ?? 0.35
          }
        : {})
    })
    if (Array.isArray(mesh.material)) {
      mesh.material.forEach((m) => m.dispose())
    } else {
      mesh.material?.dispose()
    }
    mesh.material = mat
  })
}

function abandonPendingGif(texture: THREE.Texture): void {
  const pending = texture.userData?.gifPending as GifEntry | undefined
  if (!pending) return
  delete texture.userData.gifPending
  pending.host.remove()
  pending.texture.dispose()
}

/** Image → canvas texture (SVG / CORS-hard hosts). */
async function loadTextureViaImage(url: string): Promise<THREE.Texture> {
  const src = proxiedTextureUrl(url)
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const el = new Image()
    el.crossOrigin = 'anonymous'
    el.onload = () => resolve(el)
    el.onerror = () => reject(new Error(`image load failed: ${src}`))
    el.src = src
  })

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
