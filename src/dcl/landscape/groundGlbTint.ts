import * as THREE from 'three'
import type { AssetCache } from '../../rendering/AssetCache'
import { loadMeshTemplates } from './gltfInstancing'

export type GroundGlbTint = {
  /** Average albedo sampled from the parcel ground GLB. */
  base: THREE.Color
}

const tintCache = new Map<string, GroundGlbTint>()

function materialAlbedo(material: THREE.Material): THREE.Color {
  const color = new THREE.Color(1, 1, 1)
  if ('color' in material && material.color instanceof THREE.Color) {
    color.copy(material.color)
  }
  return color
}

function sampleImageAverage(image: CanvasImageSource, width: number, height: number): THREE.Color | null {
  if (typeof document === 'undefined') return null

  const size = 32
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  if (!ctx) return null

  ctx.drawImage(image, 0, 0, width, height, 0, 0, size, size)
  const data = ctx.getImageData(0, 0, size, size).data

  let r = 0
  let g = 0
  let b = 0
  let n = 0
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3]! < 40) continue
    r += data[i]!
    g += data[i + 1]!
    b += data[i + 2]!
    n++
  }
  if (!n) return null
  return new THREE.Color(r / n / 255, g / n / 255, b / n / 255)
}

async function sampleTextureAverage(tex: THREE.Texture): Promise<THREE.Color | null> {
  const image = tex.image as { width?: number; height?: number } | undefined
  if (!image?.width || !image?.height) return null
  return sampleImageAverage(image as CanvasImageSource, image.width, image.height)
}

/**
 * Sample the empty-parcel ground GLB albedo so scattered grass matches the tile color.
 */
export async function sampleGroundGlbTint(cache: AssetCache, groundHash: string): Promise<GroundGlbTint> {
  const cached = tintCache.get(groundHash)
  if (cached) return cached

  const templates = await loadMeshTemplates(cache, groundHash)
  const base = new THREE.Color(0x6b4a32)

  for (const template of templates) {
    const mat = template.material
    const mats = Array.isArray(mat) ? mat : [mat]
    for (const m of mats) {
      const albedo = materialAlbedo(m)
      if ('map' in m && m.map instanceof THREE.Texture) {
        const avg = await sampleTextureAverage(m.map)
        if (avg) {
          base.copy(avg).multiply(albedo)
          tintCache.set(groundHash, { base })
          return tintCache.get(groundHash)!
        }
      }
      if (albedo.r < 0.99 || albedo.g < 0.99 || albedo.b < 0.99) {
        base.copy(albedo)
        tintCache.set(groundHash, { base })
        return tintCache.get(groundHash)!
      }
    }
  }

  tintCache.set(groundHash, { base })
  return tintCache.get(groundHash)!
}

/** Per-instance tint variation around the ground GLB hue (ez-tree-style scatter). */
export function grassInstanceColor(rng: () => number, groundTint: THREE.Color): THREE.Color {
  const hsl = { h: 0, s: 0, l: 0 }
  groundTint.getHSL(hsl)
  return new THREE.Color().setHSL(
    hsl.h + (rng() - 0.5) * 0.035,
    THREE.MathUtils.clamp(hsl.s * (0.92 + rng() * 0.16), 0, 1),
    THREE.MathUtils.clamp(hsl.l * (0.88 + rng() * 0.22), 0, 1)
  )
}