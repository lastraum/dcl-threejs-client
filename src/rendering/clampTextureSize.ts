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
  texture.image = canvas
  texture.needsUpdate = true
  seen.add(texture)
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
