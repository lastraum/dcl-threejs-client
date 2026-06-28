import { absoluteUrlFromTextureProxyPath } from '../../rendering/textureProxy'

const blobByUrl = new Map<string, string>()

function absoluteImageUrl(url: string): string {
  if (url.startsWith('blob:') || url.startsWith('data:')) return url
  if (url.startsWith('/')) {
    return typeof location !== 'undefined' ? `${location.origin}${url}` : url
  }
  return url
}

function fetchTarget(url: string): string {
  return absoluteUrlFromTextureProxyPath(url) ?? absoluteImageUrl(url)
}

/** Keep DOM <img> elements alive across layout passes so loads can finish. */
export function assignUiImageSrc(img: HTMLImageElement, url: string): void {
  const target = absoluteImageUrl(url)
  const cached = blobByUrl.get(target)
  if (cached) {
    if (img.src !== cached) img.src = cached
    return
  }

  const desired = img.dataset.uiSrc ?? ''
  if (desired === target && img.src) return

  img.dataset.uiSrc = target
  img.decoding = 'async'

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
        if (!blob.type.startsWith('image/')) throw new Error(`not image: ${blob.type}`)
        const blobUrl = URL.createObjectURL(blob)
        blobByUrl.set(key, blobUrl)
        img.src = blobUrl
        img.dataset.uiFetch = '0'
      })
      .catch(() => {
        img.dataset.uiFetch = '0'
      })
  }

  img.src = target
}