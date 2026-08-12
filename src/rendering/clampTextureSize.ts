import * as THREE from 'three'

/** Match Explorer-web asset processor: never upload a scene map larger than this edge. */
export const MAX_SCENE_TEXTURE_EDGE = 1024

const seen = new WeakSet<THREE.Texture>()

/**
 * Downscale `texture.image` so max(width,height) ≤ {@link MAX_SCENE_TEXTURE_EDGE}.
 * Keeps flipY / colorSpace. Safe to call more than once.
 */
export function clampTextureSize(texture: THREE.Texture, maxEdge = MAX_SCENE_TEXTURE_EDGE): void {
  if (seen.has(texture)) return
  const image = texture.image as
    | { width?: number; height?: number }
    | HTMLImageElement
    | HTMLCanvasElement
    | ImageBitmap
    | undefined
  if (!image || typeof image.width !== 'number' || typeof image.height !== 'number') return
  const w = image.width
  const h = image.height
  if (!(w > 0) || !(h > 0)) return
  const max = Math.max(w, h)
  if (max <= maxEdge) {
    adoptCanvasIfDecodedImage(texture, image, w, h)
    dropTextureCpuAfterUpload(texture)
    seen.add(texture)
    return
  }
  const scale = maxEdge / max
  const cw = Math.max(1, Math.round(w * scale))
  const ch = Math.max(1, Math.round(h * scale))
  const canvas = document.createElement('canvas')
  canvas.width = cw
  canvas.height = ch
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.drawImage(image as CanvasImageSource, 0, 0, cw, ch)
  closeDecodedImage(image)
  texture.image = canvas
  texture.needsUpdate = true
  texture.generateMipmaps = true
  dropTextureCpuAfterUpload(texture)
  seen.add(texture)
}

/** Copy HTMLImageElement / ImageBitmap onto a same-size canvas so the decode can GC. */
function adoptCanvasIfDecodedImage(
  texture: THREE.Texture,
  image: { width?: number; height?: number },
  w: number,
  h: number
): void {
  if (image instanceof HTMLCanvasElement) return
  if (!(image instanceof HTMLImageElement) && !(typeof ImageBitmap !== 'undefined' && image instanceof ImageBitmap)) {
    return
  }
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.drawImage(image as CanvasImageSource, 0, 0, w, h)
  closeDecodedImage(image)
  texture.image = canvas
  texture.needsUpdate = true
}

function closeDecodedImage(image: unknown): void {
  if (image && typeof (image as ImageBitmap).close === 'function') {
    try {
      ;(image as ImageBitmap).close()
    } catch {
      /* ignore */
    }
  }
}

/**
 * After the first GPU upload (Three `onUpdate` is post-texImage2D), drop CPU pixels.
 * Video / compressed maps stay intact. Dimension placeholder keeps later width reads safe.
 */
export function dropTextureCpuAfterUpload(texture: THREE.Texture): void {
  if (texture.userData.dclCpuDropHook) return
  if ((texture as THREE.VideoTexture).isVideoTexture) return
  if ((texture as THREE.CompressedTexture).isCompressedTexture) return
  texture.userData.dclCpuDropHook = true
  const prev = texture.onUpdate
  texture.onUpdate = () => {
    try {
      prev?.call(texture)
    } finally {
      releaseTextureCpu(texture)
    }
  }
}

function releaseTextureCpu(texture: THREE.Texture): void {
  if (texture.userData.dclCpuDropped) return
  const image = texture.image as { width?: number; height?: number; close?: () => void } | null
  if (!image) return
  const w = typeof image.width === 'number' && image.width > 0 ? image.width : 1
  const h = typeof image.height === 'number' && image.height > 0 ? image.height : 1
  texture.userData.dclTexW = w
  texture.userData.dclTexH = h
  closeDecodedImage(image)
  texture.image = { width: w, height: h }
  texture.userData.dclCpuDropped = true
}

/** Clamp every map on a parsed GLB (shared template — run once before cache). */
export function clampObject3DTextures(root: THREE.Object3D, maxEdge = MAX_SCENE_TEXTURE_EDGE): void {
  root.traverse((node) => {
    if (!(node instanceof THREE.Mesh)) return
    const mats = Array.isArray(node.material) ? node.material : [node.material]
    for (const mat of mats) {
      if (!mat || typeof mat !== 'object') continue
      for (const key of Object.keys(mat)) {
        const val = (mat as unknown as Record<string, unknown>)[key]
        if (val instanceof THREE.Texture) clampTextureSize(val, maxEdge)
      }
    }
  })
}
