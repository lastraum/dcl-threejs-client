import { PETBARN_MAX_THUMB_BYTES } from './constants'

/**
 * Compress an image File/Blob to ≤ maxBytes (prefer WebP, fallback JPEG).
 * Scales longest edge down as needed.
 */
export async function compressPetBarnThumbnail(
  source: Blob,
  maxBytes = PETBARN_MAX_THUMB_BYTES
): Promise<Blob> {
  if (source.size > 0 && source.size <= maxBytes && isAcceptableImage(source)) {
    // Still decode/re-encode large dimensions? If under budget, keep as-is.
    return source
  }

  const bitmap = await createImageBitmap(source)
  try {
    let maxEdge = 768
    const qualities = [0.86, 0.76, 0.66, 0.55, 0.45, 0.35]

    for (let scaleAttempt = 0; scaleAttempt < 6; scaleAttempt++) {
      const { w, h } = fitSize(bitmap.width, bitmap.height, maxEdge)
      const canvas = document.createElement('canvas')
      canvas.width = w
      canvas.height = h
      const ctx = canvas.getContext('2d')
      if (!ctx) throw new Error('Canvas unavailable for thumbnail compress')
      ctx.drawImage(bitmap, 0, 0, w, h)

      for (const q of qualities) {
        const webp = await canvasToBlob(canvas, 'image/webp', q)
        if (webp && webp.size <= maxBytes) return webp
        const jpeg = await canvasToBlob(canvas, 'image/jpeg', q)
        if (jpeg && jpeg.size <= maxBytes) return jpeg
      }
      maxEdge = Math.max(256, Math.floor(maxEdge * 0.75))
    }
    throw new Error(
      `Could not compress thumbnail under ${formatKb(maxBytes)}. Use a smaller image.`
    )
  } finally {
    bitmap.close?.()
  }
}

function isAcceptableImage(blob: Blob): boolean {
  const t = (blob.type || '').toLowerCase()
  return !t || t.startsWith('image/')
}

function fitSize(w: number, h: number, maxEdge: number): { w: number; h: number } {
  const long = Math.max(w, h)
  if (long <= maxEdge) return { w, h }
  const scale = maxEdge / long
  return {
    w: Math.max(1, Math.round(w * scale)),
    h: Math.max(1, Math.round(h * scale))
  }
}

function canvasToBlob(
  canvas: HTMLCanvasElement,
  type: string,
  quality: number
): Promise<Blob | null> {
  return new Promise((resolve) => {
    canvas.toBlob((b) => resolve(b), type, quality)
  })
}

function formatKb(n: number): string {
  return `${Math.round(n / 1024)} KB`
}
