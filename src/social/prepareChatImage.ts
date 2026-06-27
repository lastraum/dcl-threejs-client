import { GIFEncoder, applyPalette, quantize } from 'gifenc'
import { DCM_MAX_IMAGE_BYTES } from './dcmChatMedia'

export type PreparedChatImage = {
  bytes: Uint8Array
  mime: string
  width: number
  height: number
}

const MAX_DIMENSION_START = 2048
const MIN_DIMENSION = 64

const ALLOWED_MIME = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif'
])

/** Whether a dropped file is allowed in scene chat media. */
export function isAllowedChatImageFile(file: File): boolean {
  if (file.type && ALLOWED_MIME.has(file.type)) return true
  const name = file.name.toLowerCase()
  return /\.(jpe?g|png|webp|gif)$/.test(name)
}

/** Resize / compress any supported image (incl. animated GIF) to under {@link DCM_MAX_IMAGE_BYTES}. */
export async function prepareChatImageFile(file: File): Promise<PreparedChatImage> {
  if (!isAllowedChatImageFile(file)) {
    throw new Error('Only JPEG, PNG, WebP, and GIF images are supported')
  }

  const buffer = await file.arrayBuffer()
  const bytes = new Uint8Array(buffer)
  const mime = normalizeMime(file.type, file.name)

  if (mime === 'image/gif') {
    if (isAnimatedGif(bytes)) {
      return resizeAnimatedGif(bytes, DCM_MAX_IMAGE_BYTES)
    }
    return compressStaticRaster(bytes, 'image/gif', DCM_MAX_IMAGE_BYTES)
  }

  return compressStaticRaster(bytes, mime, DCM_MAX_IMAGE_BYTES)
}

function normalizeMime(type: string, name: string): string {
  const t = type.trim().toLowerCase()
  if (ALLOWED_MIME.has(t)) return t
  const lower = name.toLowerCase()
  if (lower.endsWith('.png')) return 'image/png'
  if (lower.endsWith('.webp')) return 'image/webp'
  if (lower.endsWith('.gif')) return 'image/gif'
  return 'image/jpeg'
}

/** Quick GIF frame-count probe — animated when 2+ image descriptors exist. */
export function isAnimatedGif(bytes: Uint8Array): boolean {
  if (bytes.length < 10) return false
  const sig = String.fromCharCode(bytes[0]!, bytes[1]!, bytes[2]!)
  if (sig !== 'GIF') return false

  let frames = 0
  for (let i = 0; i < bytes.length - 1; i++) {
    if (bytes[i] === 0x21 && bytes[i + 1] === 0xf9) {
      frames++
      if (frames > 1) return true
    }
    if (bytes[i] === 0x3b) break
  }
  return false
}

async function compressStaticRaster(
  bytes: Uint8Array,
  sourceMime: string,
  maxBytes: number
): Promise<PreparedChatImage> {
  const bitmap = await loadImageBitmap(bytes, sourceMime)
  try {
    let maxDim = MAX_DIMENSION_START
    let quality = 0.92

    while (maxDim >= MIN_DIMENSION) {
      const { canvas, width, height } = scaleBitmap(bitmap, maxDim)
      const webp = await canvasToBlob(canvas, 'image/webp', quality)
      if (webp.size <= maxBytes) {
        return blobToPrepared(webp, 'image/webp', width, height)
      }

      if (quality > 0.45) {
        quality -= 0.12
        continue
      }

      quality = 0.92
      maxDim = Math.floor(maxDim * 0.72)
    }

    const { canvas, width, height } = scaleBitmap(bitmap, MIN_DIMENSION)
    const jpeg = await canvasToBlob(canvas, 'image/jpeg', 0.75)
    if (jpeg.size <= maxBytes) {
      return blobToPrepared(jpeg, 'image/jpeg', width, height)
    }

    throw new Error('Image is too large — try a smaller file')
  } finally {
    bitmap.close()
  }
}

async function resizeAnimatedGif(bytes: Uint8Array, maxBytes: number): Promise<PreparedChatImage> {
  if (bytes.length <= maxBytes) {
    const dims = await readImageDimensions(bytes, 'image/gif')
    return { bytes, mime: 'image/gif', width: dims.width, height: dims.height }
  }

  if (typeof ImageDecoder === 'undefined') {
    throw new Error('Animated GIF is too large for chat — use a smaller file or a static image')
  }

  let maxDim = 1024
  while (maxDim >= MIN_DIMENSION) {
    const encoded = await encodeScaledAnimatedGif(bytes, maxDim)
    if (encoded.bytes.length <= maxBytes) return encoded
    maxDim = Math.floor(maxDim * 0.72)
  }

  throw new Error('Animated GIF is too large — try a shorter or smaller animation')
}

async function encodeScaledAnimatedGif(
  bytes: Uint8Array,
  maxDim: number
): Promise<PreparedChatImage> {
  const decoder = new ImageDecoder({ data: bytes, type: 'image/gif' })
  try {
    const track = decoder.tracks.selectedTrack
    const frameCount = Math.max(1, track?.frameCount ?? 1)

    const first = await decoder.decode({ frameIndex: 0 })
    const srcW = first.image.displayWidth
    const srcH = first.image.displayHeight
    first.image.close()

    const scale = Math.min(1, maxDim / Math.max(srcW, srcH))
    const outW = Math.max(1, Math.round(srcW * scale))
    const outH = Math.max(1, Math.round(srcH * scale))

    const canvas = document.createElement('canvas')
    canvas.width = outW
    canvas.height = outH
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) throw new Error('Canvas unavailable')

    const encoder = GIFEncoder()
    for (let i = 0; i < frameCount; i++) {
      const result = await decoder.decode({ frameIndex: i })
      const delayMs = result.image.duration ?? 100
      ctx.clearRect(0, 0, outW, outH)
      ctx.drawImage(result.image, 0, 0, outW, outH)
      result.image.close()

      const { data } = ctx.getImageData(0, 0, outW, outH)
      const palette = quantize(data, 256)
      const index = applyPalette(data, palette)
      const delayCs = Math.max(2, Math.round(delayMs / 10))
      encoder.writeFrame(index, outW, outH, {
        palette,
        delay: delayCs,
        dispose: 2
      })
    }

    encoder.finish()
    return {
      bytes: encoder.bytes(),
      mime: 'image/gif',
      width: outW,
      height: outH
    }
  } finally {
    decoder.close()
  }
}

async function loadImageBitmap(bytes: Uint8Array, mime: string): Promise<ImageBitmap> {
  const blob = new Blob([bytes.slice()], { type: mime || 'image/png' })
  return createImageBitmap(blob)
}

async function readImageDimensions(
  bytes: Uint8Array,
  mime: string
): Promise<{ width: number; height: number }> {
  const bitmap = await loadImageBitmap(bytes, mime)
  try {
    return { width: bitmap.width, height: bitmap.height }
  } finally {
    bitmap.close()
  }
}

function scaleBitmap(
  bitmap: ImageBitmap,
  maxDim: number
): { canvas: HTMLCanvasElement; width: number; height: number } {
  const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height))
  const width = Math.max(1, Math.round(bitmap.width * scale))
  const height = Math.max(1, Math.round(bitmap.height * scale))
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas unavailable')
  ctx.drawImage(bitmap, 0, 0, width, height)
  return { canvas, width, height }
}

function canvasToBlob(
  canvas: HTMLCanvasElement,
  mime: string,
  quality: number
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('Image encode failed'))),
      mime,
      quality
    )
  })
}

async function blobToPrepared(
  blob: Blob,
  mime: string,
  width: number,
  height: number
): Promise<PreparedChatImage> {
  const buffer = await blob.arrayBuffer()
  return { bytes: new Uint8Array(buffer), mime, width, height }
}