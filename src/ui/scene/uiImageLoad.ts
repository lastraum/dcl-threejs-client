import { proxiedTextureUrl, TEXTURE_PROXY_PREFIX } from '../../rendering/textureProxy'
import { isKtx2Bytes, ktx2BytesToPngBlob } from './ktx2ToPngBlob'

const blobByUrl = new Map<string, string>()
const SCENE_UI_IMAGE_LOADED = 'scene-ui-image-loaded'

function notifySceneUiImageLoaded(): void {
  if (typeof document === 'undefined') return
  document.dispatchEvent(new CustomEvent(SCENE_UI_IMAGE_LOADED))
}

function absoluteImageUrl(url: string): string {
  if (url.startsWith('blob:') || url.startsWith('data:')) return url
  if (url.startsWith('/')) {
    return typeof location !== 'undefined' ? `${location.origin}${url}` : url
  }
  return url
}

/**
 * Prefer same-origin proxy for any remote http(s) scene-ui image (dclnodes peers lack CORS).
 * Already-proxied paths pass through; data/blob untouched.
 */
function sameOriginImageUrl(url: string): string {
  if (!url || url.startsWith('blob:') || url.startsWith('data:')) return url
  // Absolute same-origin including /api/texture/...
  if (typeof location !== 'undefined' && url.startsWith(location.origin)) return url
  if (
    url.startsWith(TEXTURE_PROXY_PREFIX) ||
    url.startsWith('/api/texture/') ||
    url.startsWith('/api/scene-http/')
  ) {
    return absoluteImageUrl(url)
  }
  if (/^https?:/i.test(url)) {
    return absoluteImageUrl(proxiedTextureUrl(url))
  }
  return absoluteImageUrl(url)
}

function fetchTarget(url: string): string {
  return sameOriginImageUrl(url)
}

const decodeInFlight = new Set<string>()

/** MediaConverter / scene-http convert — body is KTX2, not a CSS-paintable raster. */
export function isConvertedUiImageUrl(url: string): boolean {
  return /metamorph-api\.decentraland\.|\/api\/scene-http\/.*\/convert/i.test(url)
}

/**
 * CSS `background-image` and `<img>` need a raster URL. Converter responses are KTX2
 * (Explorer cache) — decode to a PNG blob first. Returns null while the decode is in flight.
 */
export function resolveDisplayableUiImageUrl(url: string): string | null {
  const target = sameOriginImageUrl(url)
  const cached = blobByUrl.get(target)
  if (cached) return cached
  if (!isConvertedUiImageUrl(target)) return target
  void ensureConvertedUiImage(target)
  return null
}

function ensureConvertedUiImage(target: string): Promise<string | null> {
  const hit = blobByUrl.get(target)
  if (hit) return Promise.resolve(hit)
  if (decodeInFlight.has(target)) return Promise.resolve(null)
  decodeInFlight.add(target)
  return fetch(fetchTarget(target))
    .then((res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return res.arrayBuffer()
    })
    .then(async (buf) => {
      const bytes = new Uint8Array(buf)
      let blob: Blob
      if (isKtx2Bytes(bytes)) {
        blob = await ktx2BytesToPngBlob(bytes)
      } else if (bytes[0] === 0x89 && bytes[1] === 0x50) {
        blob = new Blob([bytes], { type: 'image/png' })
      } else {
        throw new Error('converter did not return an image')
      }
      const blobUrl = URL.createObjectURL(blob)
      blobByUrl.set(target, blobUrl)
      decodeInFlight.delete(target)
      notifySceneUiImageLoaded()
      return blobUrl
    })
    .catch(() => {
      decodeInFlight.delete(target)
      return null
    })
}

/** Keep DOM <img> elements alive across layout passes so loads can finish. */
export function assignUiImageSrc(img: HTMLImageElement, url: string): void {
  // Always load via same-origin proxy when remote — never set raw peer.dclnodes.io as img.src.
  const target = sameOriginImageUrl(url)
  const cached = blobByUrl.get(target)
  if (cached) {
    if (img.src !== cached) img.src = cached
    return
  }

  const desired = img.dataset.uiSrc ?? ''
  if (desired === target && img.src) return

  img.dataset.uiSrc = target
  img.decoding = 'async'
  img.crossOrigin = 'anonymous'

  if (isConvertedUiImageUrl(target)) {
    img.dataset.uiFetch = '1'
    void ensureConvertedUiImage(target).then((blobUrl) => {
      if (blobUrl && img.dataset.uiSrc === target) img.src = blobUrl
      img.dataset.uiFetch = '0'
    })
    return
  }
  // Cache successful proxy loads as blob URLs so scale/tween repaints never re-hit the network.
  img.onload = () => {
    const key = img.dataset.uiSrc
    if (key && !blobByUrl.has(key) && img.src && !img.src.startsWith('blob:')) {
      // Best-effort: promote HTTP-cached image into a stable blob for the session.
      void fetch(fetchTarget(key))
        .then((res) => (res.ok ? res.blob() : null))
        .then((blob) => {
          if (!blob || blobByUrl.has(key)) return
          const blobUrl = URL.createObjectURL(blob)
          blobByUrl.set(key, blobUrl)
        })
        .catch(() => {
          /* browser HTTP cache still helps */
        })
    }
    notifySceneUiImageLoaded()
  }

  img.onerror = () => {
    const key = img.dataset.uiSrc
    if (!key || img.dataset.uiFetch === '1') return
    img.dataset.uiFetch = '1'
    void fetch(fetchTarget(key))
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return res.blob()
      })
      .then(async (blob) => {
        // Catalyst often serves PNGs as application/octet-stream — still displayable.
        // Official DCL UI atlas URLs (`decentraland.org/images/ui/*.png`) now return
        // the marketing HTML SPA — URL extension is not proof of an image.
        const bytes = new Uint8Array(await blob.arrayBuffer())
        const magic =
          bytes.length >= 12 &&
          ((bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) ||
            (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) ||
            (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) ||
            (bytes[0] === 0x52 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42))
        const typeImage = blob.type.startsWith('image/')
        if (!magic && !typeImage) throw new Error(`not image: ${blob.type || 'empty'}`)
        if (!magic && typeImage && blob.type.includes('html')) {
          throw new Error('html served as image')
        }
        const typed = magic
          ? new Blob([bytes], {
              type:
                bytes[0] === 0x89
                  ? 'image/png'
                  : bytes[0] === 0xff
                    ? 'image/jpeg'
                    : bytes[0] === 0x47
                      ? 'image/gif'
                      : 'image/webp'
            })
          : blob
        const blobUrl = URL.createObjectURL(typed)
        blobByUrl.set(key, blobUrl)
        img.src = blobUrl
        img.dataset.uiFetch = '0'
        notifySceneUiImageLoaded()
      })
      .catch(() => {
        img.dataset.uiFetch = '0'
      })
  }

  img.src = target
}

export function onSceneUiImageLoaded(listener: () => void): () => void {
  if (typeof document === 'undefined') return () => {}
  document.addEventListener(SCENE_UI_IMAGE_LOADED, listener)
  return () => document.removeEventListener(SCENE_UI_IMAGE_LOADED, listener)
}