/**
 * Capture the photo-mode frame from the WebGL canvas.
 * Explorer: crop center “rule of thirds” area → 1920×1080.
 */

import type { WebGLRenderer } from 'three'
import {
  PHOTO_FRAME_SCALE,
  PHOTO_TARGET_HEIGHT,
  PHOTO_TARGET_WIDTH
} from './constants'
import type { PhotoMetadata } from './photoMetadata'

export type PhotoCaptureResult = {
  blob: Blob
  dataUrl: string
  width: number
  height: number
  metadata: PhotoMetadata
}

function frameRect(
  canvasW: number,
  canvasH: number,
  frameScale: number
): { sx: number; sy: number; sw: number; sh: number } {
  const targetAspect = PHOTO_TARGET_WIDTH / PHOTO_TARGET_HEIGHT
  const screenAspect = canvasW / canvasH
  let frameW: number
  let frameH: number
  if (screenAspect > targetAspect) {
    frameH = canvasH * frameScale
    frameW = frameH * targetAspect
  } else {
    frameW = canvasW * frameScale
    frameH = frameW / targetAspect
  }
  return {
    sx: (canvasW - frameW) / 2,
    sy: (canvasH - frameH) / 2,
    sw: frameW,
    sh: frameH
  }
}

/**
 * Capture current canvas, crop to viewfinder, scale to 1920×1080 JPEG.
 * Call after HUD is hidden and a full frame has been rendered.
 */
export async function capturePhotoFromRenderer(
  renderer: WebGLRenderer,
  metadata: PhotoMetadata,
  frameScale = PHOTO_FRAME_SCALE
): Promise<PhotoCaptureResult> {
  const source = renderer.domElement
  const cssW = source.clientWidth || source.width
  const cssH = source.clientHeight || source.height
  // Canvas buffer may be DPR-scaled; map CSS frame → buffer pixels.
  const dprX = source.width / Math.max(cssW, 1)
  const dprY = source.height / Math.max(cssH, 1)
  const cssFrame = frameRect(cssW, cssH, frameScale)
  const sx = Math.round(cssFrame.sx * dprX)
  const sy = Math.round(cssFrame.sy * dprY)
  const sw = Math.max(1, Math.round(cssFrame.sw * dprX))
  const sh = Math.max(1, Math.round(cssFrame.sh * dprY))

  const out = document.createElement('canvas')
  out.width = PHOTO_TARGET_WIDTH
  out.height = PHOTO_TARGET_HEIGHT
  const ctx = out.getContext('2d')
  if (!ctx) throw new Error('2D canvas unavailable for photo capture')

  // WebGL canvas Y is bottom-up for readback; drawImage uses top-left — use source canvas directly.
  ctx.drawImage(source, sx, sy, sw, sh, 0, 0, PHOTO_TARGET_WIDTH, PHOTO_TARGET_HEIGHT)

  const dataUrl = out.toDataURL('image/jpeg', 0.92)
  const blob = await new Promise<Blob>((resolve, reject) => {
    out.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('toBlob failed'))),
      'image/jpeg',
      0.92
    )
  })

  return {
    blob,
    dataUrl,
    width: PHOTO_TARGET_WIDTH,
    height: PHOTO_TARGET_HEIGHT,
    metadata
  }
}

export function downloadPhotoCapture(result: PhotoCaptureResult, filename?: string): void {
  const a = document.createElement('a')
  a.href = result.dataUrl
  a.download = filename ?? `dcl-photo-${result.metadata.dateTime}.jpg`
  a.rel = 'noopener'
  document.body.appendChild(a)
  a.click()
  a.remove()
}

/**
 * Share via Web Share API (files) when available; else copy image to clipboard.
 * Returns true if something useful happened.
 */
export async function sharePhotoCapture(result: PhotoCaptureResult): Promise<boolean> {
  const name = `dcl-photo-${result.metadata.dateTime}.jpg`
  const file = new File([result.blob], name, { type: result.blob.type || 'image/jpeg' })

  const nav = navigator as Navigator & {
    canShare?: (data: ShareData) => boolean
    share?: (data: ShareData) => Promise<void>
  }

  if (typeof nav.share === 'function') {
    const data: ShareData = {
      files: [file],
      title: 'Decentraland photo',
      text: `${result.metadata.scene.name} · ${result.metadata.scene.parcelX},${result.metadata.scene.parcelY}`
    }
    if (!nav.canShare || nav.canShare(data)) {
      await nav.share(data)
      return true
    }
  }

  if (navigator.clipboard && typeof ClipboardItem !== 'undefined') {
    try {
      await navigator.clipboard.write([new ClipboardItem({ [result.blob.type || 'image/jpeg']: result.blob })])
      return true
    } catch {
      /* fall through */
    }
  }

  return false
}
