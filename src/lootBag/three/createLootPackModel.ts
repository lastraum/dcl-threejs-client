import * as THREE from 'three'

/**
 * Loot Pack 3D — rebuilt from public/media/lootbag/lootpack.png.
 *
 * Likeness strategy (img2threejs projection-first):
 * - Front face uses the real photo (black studio bg removed)
 * - Soft pillow volume + foil side/back materials
 * - No separate "giant logo" meshes — the mark is in the photo
 *
 * Claim animation: tearPivot (top seal peel) + fallRoot (drop away).
 */

export interface LootPackModelOptions {
  /** Overall world scale (default 1 ≈ 1 unit tall). */
  scale?: number
  /**
   * Front albedo URL. Defaults try app public path then repo public path.
   * Pass `null` to skip loading (procedural foil only).
   */
  foilMapUrl?: string | null
  /** Skip photo; copper→magenta procedural foil only. */
  proceduralOnly?: boolean
}

const FOIL_ORANGE = 0xf08a45
const FOIL_MAGENTA = 0xe85aaa
const FOIL_PINK = 0xd45ec8

/** Fallback pack aspect if image bounds fail (width / height). */
const FALLBACK_ASPECT = 0.72
const PACK_H = 1.0
const PACK_D = 0.085
const SEAL_H = 0.055

export type LootPackAnimationApi = {
  openTear: (t: number) => void
  fallAway: (t: number) => void
  idleTick: (elapsedSec: number) => void
  reset: () => void
}

export type LootPackSculptRuntime = {
  nodes: Record<string, THREE.Object3D>
  sockets: Record<string, THREE.Object3D>
  materials: Record<string, THREE.Material>
  animation: LootPackAnimationApi
  destructionGroups: string[]
  phase: 'idle' | 'tearing' | 'falling' | 'revealed'
}

// ---------------------------------------------------------------------------
// Texture helpers
// ---------------------------------------------------------------------------

type CropRect = { x: number; y: number; w: number; h: number }

/** Bounding box of non-black content (normalized 0..1). */
function contentCrop(image: HTMLImageElement | ImageBitmap, threshold = 14): CropRect {
  const w = 'width' in image ? image.width : (image as ImageBitmap).width
  const h = 'height' in image ? image.height : (image as ImageBitmap).height
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) return { x: 0.18, y: 0.08, w: 0.64, h: 0.84 }
  ctx.drawImage(image as CanvasImageSource, 0, 0)
  const { data } = ctx.getImageData(0, 0, w, h)

  let minX = w
  let minY = h
  let maxX = 0
  let maxY = 0
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4
      const lum = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]
      if (lum > threshold) {
        if (x < minX) minX = x
        if (y < minY) minY = y
        if (x > maxX) maxX = x
        if (y > maxY) maxY = y
      }
    }
  }
  if (maxX <= minX || maxY <= minY) {
    return { x: 0.18, y: 0.08, w: 0.64, h: 0.84 }
  }
  // Small padding so seals aren't clipped
  const pad = Math.round(Math.min(w, h) * 0.008)
  minX = Math.max(0, minX - pad)
  minY = Math.max(0, minY - pad)
  maxX = Math.min(w - 1, maxX + pad)
  maxY = Math.min(h - 1, maxY + pad)
  return {
    x: minX / w,
    y: minY / h,
    w: (maxX - minX + 1) / w,
    h: (maxY - minY + 1) / h,
  }
}

/**
 * Crop pack pixels out of the studio plate and force pure black → transparent
 * so the mesh silhouette matches the photo bag.
 */
function makePackAlbedoTexture(image: HTMLImageElement): {
  texture: THREE.CanvasTexture
  aspect: number
} {
  const crop = contentCrop(image)
  const sw = Math.max(1, Math.round(crop.w * image.width))
  const sh = Math.max(1, Math.round(crop.h * image.height))
  const sx = Math.round(crop.x * image.width)
  const sy = Math.round(crop.y * image.height)

  const canvas = document.createElement('canvas')
  canvas.width = sw
  canvas.height = sh
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) {
    const tex = new THREE.Texture(image)
    tex.colorSpace = THREE.SRGBColorSpace
    tex.needsUpdate = true
    return { texture: tex as THREE.CanvasTexture, aspect: FALLBACK_ASPECT }
  }

  ctx.drawImage(image, sx, sy, sw, sh, 0, 0, sw, sh)
  const imgData = ctx.getImageData(0, 0, sw, sh)
  const d = imgData.data
  for (let i = 0; i < d.length; i += 4) {
    const lum = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]
    // Soft edge: fade near-black fringe so the cutout isn't jagged
    if (lum < 10) {
      d[i + 3] = 0
    } else if (lum < 28) {
      d[i + 3] = Math.round(((lum - 10) / 18) * 255)
    }
  }
  ctx.putImageData(imgData, 0, 0)

  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.anisotropy = 8
  texture.wrapS = THREE.ClampToEdgeWrapping
  texture.wrapT = THREE.ClampToEdgeWrapping
  texture.needsUpdate = true
  return { texture, aspect: sw / sh }
}

function makeFoilMaterial(opts?: {
  color?: number
  map?: THREE.Texture | null
  transparent?: boolean
}): THREE.MeshPhysicalMaterial {
  const map = opts?.map ?? null
  return new THREE.MeshPhysicalMaterial({
    color: map ? 0xffffff : (opts?.color ?? FOIL_MAGENTA),
    map,
    metalness: map ? 0.55 : 0.9,
    roughness: map ? 0.32 : 0.24,
    clearcoat: map ? 0.35 : 0.5,
    clearcoatRoughness: 0.22,
    envMapIntensity: map ? 0.85 : 1.1,
    transparent: opts?.transparent ?? !!map,
    alphaTest: map ? 0.04 : 0,
    side: THREE.DoubleSide,
    depthWrite: true,
  })
}

function makeProceduralFoilMaterial(): THREE.MeshPhysicalMaterial {
  const mat = makeFoilMaterial({ color: FOIL_MAGENTA, transparent: false })
  const left = new THREE.Color(FOIL_ORANGE).convertSRGBToLinear()
  const right = new THREE.Color(FOIL_PINK).convertSRGBToLinear()
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader =
      'varying vec2 vPackUv;\n' +
      shader.vertexShader.replace(
        '#include <uv_vertex>',
        `#include <uv_vertex>
         vPackUv = uv;`,
      )
    shader.fragmentShader =
      'varying vec2 vPackUv;\n' +
      shader.fragmentShader.replace(
        '#include <color_fragment>',
        `#include <color_fragment>
         vec3 leftC = vec3(${left.r.toFixed(4)}, ${left.g.toFixed(4)}, ${left.b.toFixed(4)});
         vec3 rightC = vec3(${right.r.toFixed(4)}, ${right.g.toFixed(4)}, ${right.b.toFixed(4)});
         float gx = smoothstep(0.0, 1.0, vPackUv.x);
         float cy = 1.0 - abs(vPackUv.y - 0.5) * 0.12;
         diffuseColor.rgb *= mix(leftC, rightC, gx) * cy;`,
      )
  }
  mat.customProgramCacheKey = () => 'lootpack-foil-grad-v2'
  return mat
}

/** Soft pillow: push plane vertices out along Z with a smooth dome. */
function applyPillowBulge(geo: THREE.PlaneGeometry, amount: number): void {
  const pos = geo.attributes.position as THREE.BufferAttribute
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i)
    const y = pos.getY(i)
    const nx = x / (geo.parameters.width * 0.5)
    const ny = y / (geo.parameters.height * 0.5)
    const r = Math.min(1, Math.sqrt(nx * nx + ny * ny))
    const dome = Math.cos(r * Math.PI * 0.5)
    pos.setZ(i, amount * Math.max(0, dome))
  }
  pos.needsUpdate = true
  geo.computeVertexNormals()
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.decoding = 'async'
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error(`Failed to load ${url}`))
    img.src = url
  })
}

async function loadFirstImage(urls: string[]): Promise<HTMLImageElement | null> {
  for (const url of urls) {
    try {
      return await loadImage(url)
    } catch {
      // try next
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

function buildPack(options: LootPackModelOptions, photo?: {
  texture: THREE.Texture
  aspect: number
}): THREE.Group {
  const scale = options.scale ?? 1
  const aspect = photo?.aspect ?? FALLBACK_ASPECT
  const H = PACK_H
  const W = H * aspect
  const D = PACK_D

  const root = new THREE.Group()
  root.name = 'loot-pack'

  const fallRoot = new THREE.Group()
  fallRoot.name = 'fall-root'
  root.add(fallRoot)

  const bodyPivot = new THREE.Group()
  bodyPivot.name = 'body-pivot'
  fallRoot.add(bodyPivot)

  const nodes: Record<string, THREE.Object3D> = {}
  const sockets: Record<string, THREE.Object3D> = {}

  const frontMat = photo
    ? makeFoilMaterial({ map: photo.texture, transparent: true })
    : makeProceduralFoilMaterial()
  const sideMat = makeFoilMaterial({ color: FOIL_MAGENTA, transparent: false })
  sideMat.metalness = 0.92
  sideMat.roughness = 0.26
  const backMat = makeFoilMaterial({ color: FOIL_ORANGE, transparent: false })
  backMat.metalness = 0.9
  backMat.roughness = 0.28

  // --- Front (photo or procedural), slight pillow bulge ---
  const frontGeo = new THREE.PlaneGeometry(W, H, 48, 64)
  applyPillowBulge(frontGeo, D * 0.55)
  const front = new THREE.Mesh(frontGeo, frontMat)
  front.name = 'bodyFront'
  front.position.z = D * 0.15
  front.castShadow = true
  front.receiveShadow = true
  bodyPivot.add(front)
  nodes.bodyFront = front

  // --- Back (mirrored pillow, solid foil) ---
  const backGeo = new THREE.PlaneGeometry(W * 0.98, H * 0.98, 24, 32)
  applyPillowBulge(backGeo, D * 0.4)
  const back = new THREE.Mesh(backGeo, backMat)
  back.name = 'bodyBack'
  back.rotation.y = Math.PI
  back.position.z = -D * 0.15
  back.castShadow = true
  bodyPivot.add(back)
  nodes.bodyBack = back

  // --- Side rim (thin shell so edge reads as a sachet, not a card) ---
  const rim = new THREE.Mesh(
    new THREE.BoxGeometry(W * 0.97, H * 0.97, D * 0.7),
    sideMat,
  )
  rim.name = 'bodyShell'
  rim.castShadow = true
  rim.receiveShadow = true
  bodyPivot.add(rim)
  nodes.bodyShell = rim

  // --- Top seal (tear hinge) ---
  const tearPivot = new THREE.Group()
  tearPivot.name = 'tear-pivot'
  tearPivot.position.set(0, H * 0.5 - SEAL_H * 0.35, D * 0.05)
  bodyPivot.add(tearPivot)
  nodes.tearPivot = tearPivot
  sockets.tearPivot = tearPivot

  const sealMat = sideMat.clone() as THREE.MeshPhysicalMaterial
  sealMat.roughness = 0.34
  sealMat.metalness = 0.88

  const topSeal = new THREE.Mesh(
    new THREE.BoxGeometry(W * 0.99, SEAL_H, D * 0.95),
    sealMat,
  )
  topSeal.name = 'topSeal'
  topSeal.position.set(0, SEAL_H * 0.15, 0)
  topSeal.castShadow = true
  tearPivot.add(topSeal)
  nodes.topSeal = topSeal

  // Subtle tear lip
  const tearLip = new THREE.Mesh(
    new THREE.BoxGeometry(W * 0.96, 0.01, D * 1.05),
    sealMat,
  )
  tearLip.name = 'tearLip'
  tearLip.position.set(0, -SEAL_H * 0.2, D * 0.08)
  tearPivot.add(tearLip)
  nodes.tearLip = tearLip

  // --- Bottom seal ---
  const bottomSeal = new THREE.Mesh(
    new THREE.BoxGeometry(W * 0.99, SEAL_H, D * 0.95),
    sealMat,
  )
  bottomSeal.name = 'bottomSeal'
  bottomSeal.position.set(0, -H * 0.5 + SEAL_H * 0.45, 0)
  bottomSeal.castShadow = true
  bodyPivot.add(bottomSeal)
  nodes.bottomSeal = bottomSeal

  // Invisible collider
  const collider = new THREE.Mesh(
    new THREE.BoxGeometry(W, H, D * 1.5),
    new THREE.MeshBasicMaterial({ visible: false }),
  )
  collider.name = 'collider'
  bodyPivot.add(collider)
  nodes.collider = collider

  const frontSocket = new THREE.Object3D()
  frontSocket.name = 'frontFace'
  frontSocket.position.set(0, 0, D * 0.7)
  bodyPivot.add(frontSocket)
  sockets.frontFace = frontSocket
  sockets.fallRoot = fallRoot
  sockets.bodyPivot = bodyPivot

  root.scale.setScalar(scale)

  const baseRough = (frontMat as THREE.MeshPhysicalMaterial).roughness
  const baseEnv = (frontMat as THREE.MeshPhysicalMaterial).envMapIntensity

  const animation: LootPackAnimationApi = {
    openTear: (t: number) => {
      const k = THREE.MathUtils.clamp(t, 0, 1)
      tearPivot.rotation.x = -k * Math.PI * 0.65
      tearPivot.position.z = D * 0.05 + k * 0.05
      tearLip.scale.y = 1 + k * 3
    },
    fallAway: (t: number) => {
      const k = THREE.MathUtils.clamp(t, 0, 1)
      const ease = k * k * (3 - 2 * k)
      fallRoot.position.y = -ease * 1.4
      fallRoot.rotation.z = ease * 0.2
      fallRoot.rotation.x = ease * 0.1
      fallRoot.scale.setScalar(1 - ease * 0.06)
      const opacity = 1 - ease * 0.2
      for (const m of [frontMat, sideMat, backMat, sealMat]) {
        m.transparent = opacity < 0.999
        m.opacity = opacity
      }
    },
    idleTick: (elapsedSec: number) => {
      bodyPivot.position.y = Math.sin(elapsedSec * 1.35) * 0.01
      bodyPivot.rotation.y = Math.sin(elapsedSec * 0.65) * 0.035
      const fm = frontMat as THREE.MeshPhysicalMaterial
      fm.roughness = baseRough + Math.sin(elapsedSec * 2.1) * 0.025
      fm.envMapIntensity = baseEnv + Math.sin(elapsedSec * 1.5) * 0.08
    },
    reset: () => {
      tearPivot.rotation.set(0, 0, 0)
      tearPivot.position.set(0, H * 0.5 - SEAL_H * 0.35, D * 0.05)
      tearLip.scale.set(1, 1, 1)
      fallRoot.position.set(0, 0, 0)
      fallRoot.rotation.set(0, 0, 0)
      fallRoot.scale.setScalar(1)
      bodyPivot.position.set(0, 0, 0)
      bodyPivot.rotation.set(0, 0, 0)
      for (const m of [frontMat, sideMat, backMat, sealMat]) {
        m.opacity = 1
        m.transparent = m === frontMat && !!photo
      }
      const fm = frontMat as THREE.MeshPhysicalMaterial
      fm.roughness = baseRough
      fm.envMapIntensity = baseEnv
    },
  }

  const runtime: LootPackSculptRuntime = {
    nodes,
    sockets,
    materials: {
      front: frontMat,
      side: sideMat,
      back: backMat,
      seal: sealMat,
    },
    animation,
    destructionGroups: ['topSeal', 'bottomSeal', 'bodyFront', 'bodyBack', 'bodyShell'],
    phase: 'idle',
  }
  root.userData.sculptRuntime = runtime
  root.userData.tick = (_dt: number, elapsed: number) => {
    if (runtime.phase === 'idle') animation.idleTick(elapsed)
  }

  return root
}

/** Sync factory — procedural foil only (no photo). Prefer async for likeness. */
export function createLootPackModel(options: LootPackModelOptions = {}): THREE.Group {
  return buildPack({ ...options, proceduralOnly: true })
}

/**
 * Preferred: loads lootpack.png, crops the bag, maps it to a soft pillow front.
 */
export async function createLootPackModelAsync(
  options: LootPackModelOptions = {},
): Promise<THREE.Group> {
  if (options.proceduralOnly || options.foilMapUrl === null) {
    return buildPack(options)
  }

  const urls =
    options.foilMapUrl != null
      ? [options.foilMapUrl]
      : [
          '/media/lootbag/lootpack.png',
          '/public/media/lootbag/lootpack.png',
          'media/lootbag/lootpack.png',
          'public/media/lootbag/lootpack.png',
        ]

  const image = await loadFirstImage(urls)
  if (!image) {
    console.warn('[loot-pack] reference image not found; using procedural foil')
    return buildPack(options)
  }

  const { texture, aspect } = makePackAlbedoTexture(image)
  return buildPack(options, { texture, aspect })
}

/** Claim sequence matching LootBagView timings (tear → fall). */
export function playLootPackClaimAnimation(
  root: THREE.Group,
  opts: { tearMs?: number; fallMs?: number } = {},
): Promise<void> {
  const runtime = root.userData.sculptRuntime as LootPackSculptRuntime | undefined
  if (!runtime) return Promise.resolve()

  const tearMs = opts.tearMs ?? 480
  const fallMs = opts.fallMs ?? 1050
  const anim = runtime.animation
  anim.reset()
  runtime.phase = 'tearing'

  return new Promise((resolve) => {
    const t0 = performance.now()
    const frame = (now: number) => {
      const elapsed = now - t0
      if (elapsed < tearMs) {
        anim.openTear(elapsed / tearMs)
        requestAnimationFrame(frame)
        return
      }
      if (elapsed < tearMs + fallMs) {
        runtime.phase = 'falling'
        anim.openTear(1)
        anim.fallAway((elapsed - tearMs) / fallMs)
        requestAnimationFrame(frame)
        return
      }
      anim.openTear(1)
      anim.fallAway(1)
      runtime.phase = 'revealed'
      resolve()
    }
    requestAnimationFrame(frame)
  })
}
