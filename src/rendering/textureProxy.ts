/** Same-origin texture proxy — avoids browser CORS blocks on third-party image CDNs. */

export const TEXTURE_PROXY_PREFIX = '/api/texture/'

const STREAMING_MEDIA_RE = /\.(m3u8|mpd|mp4|webm|mov|ogg|wav|mp3)(\?|#|$)/i

/** HLS / video manifests and streams — must never use the image texture proxy. */
export function isStreamingMediaUrl(url: string): boolean {
  if (!url) return false
  if (STREAMING_MEDIA_RE.test(url)) return true
  if (/gumlet\.io/i.test(url)) return true
  if (/livekit-video:\/\//i.test(url)) return true
  return false
}

/** Hosts/paths that already work with WebGL `crossOrigin` uploads (or are same-origin). */
export function isCorsSafeTextureUrl(url: string): boolean {
  if (!url || url.startsWith('data:') || url.startsWith('blob:')) return true
  if (url.startsWith(TEXTURE_PROXY_PREFIX)) return true
  if (!/^https?:/i.test(url)) return true
  if (typeof window !== 'undefined' && url.startsWith(window.location.origin)) return true
  if (/\.decentraland\.org\//i.test(url)) return true
  if (/gstatic\.com\//i.test(url)) return true
  // Arweave gateways send ACAO:* — direct fetch/Image works after redirect.
  if (/\.arweave\.net\//i.test(url)) return true
  if (/^https?:\/\/arweave\.net\//i.test(url)) return true
  // RickRoll CameraOperator QR images — server sends ACAO:*.
  if (/\.lastslice\.co\//i.test(url)) return true
  return false
}

/** Rewrite external **image** URLs to the dev/prod same-origin proxy path. */
export function proxiedTextureUrl(url: string): string {
  if (!url || isCorsSafeTextureUrl(url) || isStreamingMediaUrl(url)) return url
  try {
    const parsed = new URL(url)
    const path = `${parsed.pathname}${parsed.search}`
    return `${TEXTURE_PROXY_PREFIX}${parsed.protocol.replace(':', '')}/${parsed.host}${path}`
  } catch {
    return url
  }
}

/** Parse `/api/texture/https/host/path` back to an absolute fetch target (dev proxy / nginx). */
export function absoluteUrlFromTextureProxyPath(path: string): string | null {
  const m = path.match(/^\/api\/texture\/(https?)\/([^/]+)(\/.*)?$/)
  if (!m) return null
  const [, proto, host, rest = ''] = m
  return `${proto}://${host}${rest}`
}

/** Streaming assets must never use the image texture proxy — unwrap if misrouted. */
export function unwrapMisroutedMediaUrl(url: string): string {
  if (isStreamingMediaUrl(url)) {
    const unwrapped = absoluteUrlFromTextureProxyPath(url)
    if (unwrapped) return unwrapped
  }
  return url
}

/** Image loads that should use fetch (redirect follow) instead of raw Image src. */
export function preferFetchTextureLoad(url: string): boolean {
  return url.startsWith(TEXTURE_PROXY_PREFIX) || /\.arweave\.net\//i.test(url) || /^https?:\/\/arweave\.net\//i.test(url)
}