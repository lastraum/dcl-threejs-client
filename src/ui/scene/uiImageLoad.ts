import { proxiedTextureUrl, TEXTURE_PROXY_PREFIX } from '../../rendering/textureProxy'

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
  if (url.startsWith(TEXTURE_PROXY_PREFIX) || url.startsWith('/api/texture/')) {
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
      .then((blob) => {
        // Catalyst often serves PNGs as application/octet-stream — still displayable.
        const looksImage =
          blob.type.startsWith('image/') ||
          blob.type === '' ||
          blob.type === 'application/octet-stream' ||
          /\.(png|jpe?g|gif|webp|svg)(\?|#|$)/i.test(key)
        if (!looksImage) throw new Error(`not image: ${blob.type}`)
        const blobUrl = URL.createObjectURL(blob)
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