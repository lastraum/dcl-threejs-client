/**
 * Compress a leader-uploaded image for the follow tour flag wire payload.
 * Target: small data URL safe for LiveKit reliable data + heartbeat rebroadcast.
 */
const MAX_EDGE = 160
const MAX_BYTES = 12_000
const ALLOWED = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif'])

export function isAllowedFollowFlagFile(file: File): boolean {
  if (file.type && ALLOWED.has(file.type)) return true
  return /\.(jpe?g|png|webp|gif)$/i.test(file.name)
}

/** Returns a `data:image/jpeg;base64,…` string suitable for FollowWireMsg.flag. */
export async function prepareFollowFlagImage(file: File): Promise<string> {
  if (!isAllowedFollowFlagFile(file)) {
    throw new Error('Use JPEG, PNG, WebP, or GIF for the tour flag')
  }
  const buffer = await file.arrayBuffer()
  const blob = new Blob([buffer], { type: file.type || 'image/jpeg' })
  const bitmap = await createImageBitmap(blob)
  try {
    let w = bitmap.width
    let h = bitmap.height
    const scale = Math.min(1, MAX_EDGE / Math.max(w, h, 1))
    w = Math.max(1, Math.round(w * scale))
    h = Math.max(1, Math.round(h * scale))

    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('Could not process image')
    ctx.drawImage(bitmap, 0, 0, w, h)

    let quality = 0.82
    let dataUrl = canvas.toDataURL('image/jpeg', quality)
    while (approxBytes(dataUrl) > MAX_BYTES && quality > 0.35) {
      quality -= 0.12
      dataUrl = canvas.toDataURL('image/jpeg', quality)
    }
    // Still too big — shrink edge further
    let edge = MAX_EDGE
    while (approxBytes(dataUrl) > MAX_BYTES && edge > 48) {
      edge = Math.floor(edge * 0.75)
      const nw = Math.max(1, Math.round((w * edge) / Math.max(w, h)))
      const nh = Math.max(1, Math.round((h * edge) / Math.max(w, h)))
      canvas.width = nw
      canvas.height = nh
      ctx.drawImage(bitmap, 0, 0, nw, nh)
      dataUrl = canvas.toDataURL('image/jpeg', 0.7)
    }
    if (approxBytes(dataUrl) > MAX_BYTES * 1.5) {
      throw new Error('Image is still too large after compression — try a simpler image')
    }
    return dataUrl
  } finally {
    bitmap.close()
  }
}

function approxBytes(dataUrl: string): number {
  const i = dataUrl.indexOf(',')
  const b64 = i >= 0 ? dataUrl.slice(i + 1) : dataUrl
  return Math.floor((b64.length * 3) / 4)
}
