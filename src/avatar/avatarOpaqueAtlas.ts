import * as THREE from 'three'
import { yieldToNextFrame } from '../rendering/mainThreadYield'

/**
 * Practical per-avatar opaque albedo atlas.
 *
 * Packs opaque baseColor maps from a composed DCL avatar into one canvas texture,
 * remaps UVs, and points materials at the shared atlas. Leaves alone:
 * - transparent / alphaTest materials (hair cards, face features)
 * - hair / eyelash / fur named materials
 * - emissive-boosted / Em.* materials (neon)
 *
 * Goal: fewer unique textures + material map binds when many remotes are on screen,
 * without a full multi-map bake pipeline.
 */

const EMISSIVE_NAME = /^em\.|emissive|glow|neon|em_/i
const HAIR_NAME = /hair|eyelash|fur|brow|beard|mustache/i

/** Skip atlas if fewer unique maps than this (not worth the UV rewrite). */
const MIN_UNIQUE_MAPS = 3
/** Max atlas edge (px). 2048 keeps VRAM sane for many remotes. */
const ATLAS_MAX = 2048
/** Downscale each source so total pack fits more often. */
const SOURCE_MAX_EDGE = 512
const PAD = 2

type PackEntry = {
  tex: THREE.Texture
  /** Unique id for packing (texture.uuid). */
  id: string
  srcW: number
  srcH: number
  packW: number
  packH: number
  x: number
  y: number
}

type MeshMatRef = {
  mesh: THREE.Mesh
  matIndex: number
  material: THREE.MeshStandardMaterial
  tex: THREE.Texture
}

function isStandard(mat: THREE.Material): mat is THREE.MeshStandardMaterial {
  return (
    'isMeshStandardMaterial' in mat &&
    (mat as THREE.MeshStandardMaterial).isMeshStandardMaterial === true
  )
}

function shouldSkipMaterial(mat: THREE.MeshStandardMaterial): boolean {
  const name = (mat.name ?? '').toLowerCase()
  if (mat.transparent === true) return true
  if (typeof mat.alphaTest === 'number' && mat.alphaTest > 0.001) return true
  if (HAIR_NAME.test(name)) return true
  if (EMISSIVE_NAME.test(name)) return true
  const ud = mat.userData as Record<string, unknown>
  if (ud.dclEmissiveBoosted) return true
  if (ud.dclOpaqueAtlas) return true
  // No albedo map — solid color only; leave as-is.
  if (!mat.map?.image) return true
  return false
}

function imageSize(img: unknown): { w: number; h: number } | null {
  if (!img || typeof img !== 'object') return null
  const o = img as { width?: number; height?: number; videoWidth?: number; videoHeight?: number }
  const w = o.width ?? o.videoWidth ?? 0
  const h = o.height ?? o.videoHeight ?? 0
  if (w < 2 || h < 2) return null
  return { w, h }
}

function fitSize(w: number, h: number, maxEdge: number): { w: number; h: number } {
  const m = Math.max(w, h)
  if (m <= maxEdge) return { w, h }
  const s = maxEdge / m
  return {
    w: Math.max(1, Math.round(w * s)),
    h: Math.max(1, Math.round(h * s))
  }
}

/** Shelf pack — returns atlas size or null if it won't fit. */
function shelfPack(entries: PackEntry[], maxSize: number): { W: number; H: number } | null {
  entries.sort((a, b) => b.packH - a.packH || b.packW - a.packW)
  let x = PAD
  let y = PAD
  let shelfH = 0
  let maxX = 0
  let maxY = 0
  for (const e of entries) {
    if (e.packW + PAD * 2 > maxSize || e.packH + PAD * 2 > maxSize) return null
    if (x + e.packW + PAD > maxSize) {
      x = PAD
      y += shelfH + PAD
      shelfH = 0
    }
    if (y + e.packH + PAD > maxSize) return null
    e.x = x
    e.y = y
    x += e.packW + PAD
    shelfH = Math.max(shelfH, e.packH)
    maxX = Math.max(maxX, e.x + e.packW)
    maxY = Math.max(maxY, e.y + e.packH)
  }
  const W = Math.min(maxSize, Math.max(64, nextPow2(maxX + PAD)))
  const H = Math.min(maxSize, Math.max(64, nextPow2(maxY + PAD)))
  if (maxX + PAD > W || maxY + PAD > H) return null
  return { W, H }
}

function nextPow2(n: number): number {
  let p = 1
  while (p < n) p <<= 1
  return p
}

function drawTex(
  ctx: CanvasRenderingContext2D,
  tex: THREE.Texture,
  x: number,
  y: number,
  w: number,
  h: number
): boolean {
  const img = tex.image as CanvasImageSource | undefined
  if (!img) return false
  try {
    ctx.drawImage(img, x, y, w, h)
    return true
  } catch {
    return false
  }
}

/**
 * Pack opaque albedo maps on a composed avatar into one atlas and rebind materials.
 * Safe no-op when too few maps, canvas unavailable, or pack fails.
 * Mutates geometry UVs (clones geometry when shared).
 */
export async function applyAvatarOpaqueAtlas(root: THREE.Object3D): Promise<boolean> {
  if (typeof document === 'undefined') return false

  const refs: MeshMatRef[] = []
  root.traverse((obj) => {
    if (!(obj as THREE.Mesh).isMesh) return
    const mesh = obj as THREE.Mesh
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
    mats.forEach((mat, matIndex) => {
      if (!mat || !isStandard(mat)) return
      if (shouldSkipMaterial(mat)) return
      const tex = mat.map!
      refs.push({ mesh, matIndex, material: mat, tex })
    })
  })

  if (refs.length < MIN_UNIQUE_MAPS) return false

  const byId = new Map<string, PackEntry>()
  for (const ref of refs) {
    const id = ref.tex.uuid
    if (byId.has(id)) continue
    const size = imageSize(ref.tex.image)
    if (!size) continue
    const fitted = fitSize(size.w, size.h, SOURCE_MAX_EDGE)
    byId.set(id, {
      tex: ref.tex,
      id,
      srcW: size.w,
      srcH: size.h,
      packW: fitted.w,
      packH: fitted.h,
      x: 0,
      y: 0
    })
  }

  if (byId.size < MIN_UNIQUE_MAPS) return false

  const entries = [...byId.values()]
  let pack = shelfPack(entries, ATLAS_MAX)
  // Retry with smaller sources if first pack fails.
  if (!pack) {
    for (const e of entries) {
      const f = fitSize(e.srcW, e.srcH, 256)
      e.packW = f.w
      e.packH = f.h
    }
    pack = shelfPack(entries, ATLAS_MAX)
  }
  if (!pack) return false

  await yieldToNextFrame()

  const canvas = document.createElement('canvas')
  canvas.width = pack.W
  canvas.height = pack.H
  const ctx = canvas.getContext('2d', { willReadFrequently: false })
  if (!ctx) return false
  ctx.clearRect(0, 0, pack.W, pack.H)

  let drawn = 0
  for (const e of entries) {
    if (drawTex(ctx, e.tex, e.x, e.y, e.packW, e.packH)) drawn++
  }
  if (drawn < MIN_UNIQUE_MAPS) return false

  const atlas = new THREE.CanvasTexture(canvas)
  atlas.colorSpace = THREE.SRGBColorSpace
  atlas.flipY = true
  atlas.wrapS = THREE.ClampToEdgeWrapping
  atlas.wrapT = THREE.ClampToEdgeWrapping
  atlas.magFilter = THREE.LinearFilter
  atlas.minFilter = THREE.LinearMipmapLinearFilter
  atlas.generateMipmaps = true
  atlas.needsUpdate = true
  ;(atlas.userData as Record<string, unknown>).dclOpaqueAtlas = true
  ;(atlas.userData as Record<string, unknown>).dclAvatarAtlas = true

  // Mark root so dispose can free the atlas once.
  const rootUd = root.userData as Record<string, unknown>
  const prev = rootUd.dclOpaqueAtlasTexture as THREE.Texture | undefined
  if (prev && prev !== atlas) {
    prev.dispose()
  }
  rootUd.dclOpaqueAtlasTexture = atlas

  const invW = 1 / pack.W
  const invH = 1 / pack.H

  // One rewritten material instance per original material.
  const matRewrite = new Map<THREE.MeshStandardMaterial, THREE.MeshStandardMaterial>()

  for (const ref of refs) {
    const entry = byId.get(ref.tex.uuid)
    if (!entry) continue

    // UV remap in mesh-local geometry.
    ensureUniqueGeometry(ref.mesh)
    const geo = ref.mesh.geometry
    const uv = geo.getAttribute('uv') as THREE.BufferAttribute | undefined
    if (!uv) continue

    // Multi-material: only remap UVs for index range of this material group.
    const ranges = uvRangesForMaterial(geo, ref.matIndex, uv.count)
    const u0 = entry.x * invW
    const v0 = entry.y * invH
    const su = entry.packW * invW
    const sv = entry.packH * invH

    for (const [i0, i1] of ranges) {
      for (let i = i0; i < i1; i++) {
        const u = uv.getX(i)
        const v = uv.getY(i)
        // Repeat wrap into [0,1) so tiled clothing still maps into the rect.
        const ur = u - Math.floor(u)
        const vr = v - Math.floor(v)
        uv.setXY(i, u0 + ur * su, v0 + vr * sv)
      }
    }
    uv.needsUpdate = true

    let next = matRewrite.get(ref.material)
    if (!next) {
      // Clone so we don't mutate AssetCache-shared templates.
      next = ref.material.clone()
      next.map = atlas
      next.needsUpdate = true
      ;(next.userData as Record<string, unknown>).dclOpaqueAtlas = true
      matRewrite.set(ref.material, next)
    }

    if (Array.isArray(ref.mesh.material)) {
      const arr = ref.mesh.material.slice()
      arr[ref.matIndex] = next
      ref.mesh.material = arr
    } else {
      ref.mesh.material = next
    }
  }

  await yieldToNextFrame()
  return true
}

function ensureUniqueGeometry(mesh: THREE.Mesh): void {
  const geo = mesh.geometry
  const ud = geo.userData as Record<string, unknown>
  if (ud.dclAtlasUvOwned) return
  mesh.geometry = geo.clone()
  ;(mesh.geometry.userData as Record<string, unknown>).dclAtlasUvOwned = true
}

/** Vertex index ranges [start, end) for a material slot (groups or full mesh). */
function uvRangesForMaterial(
  geo: THREE.BufferGeometry,
  matIndex: number,
  vertexCount: number
): Array<[number, number]> {
  const groups = geo.groups
  if (!groups?.length) return [[0, vertexCount]]

  const index = geo.index
  const ranges: Array<[number, number]> = []
  for (const g of groups) {
    if (g.materialIndex !== matIndex) continue
    if (index) {
      // Indexed: walk triangle verts — remap unique vertex indices in range.
      // Simpler: expand all verts referenced by this group into a set, then remap those.
      // For correctness under shared verts across groups, remap all verts in index range
      // (may double-touch shared verts if multi-mat shares — rare for wearables).
      const start = g.start
      const end = g.start + g.count
      const seen = new Set<number>()
      for (let i = start; i < end; i++) {
        seen.add(index.getX(i))
      }
      for (const vi of seen) {
        ranges.push([vi, vi + 1])
      }
    } else {
      ranges.push([g.start, g.start + g.count])
    }
  }
  return ranges.length ? ranges : [[0, vertexCount]]
}

/** Dispose atlas owned by a composed avatar root (if any). */
export function disposeAvatarOpaqueAtlas(root: THREE.Object3D): void {
  const ud = root.userData as Record<string, unknown>
  const tex = ud.dclOpaqueAtlasTexture as THREE.Texture | undefined
  if (tex) {
    tex.dispose()
    delete ud.dclOpaqueAtlasTexture
  }
}
