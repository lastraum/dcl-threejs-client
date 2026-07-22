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
  // Hosts that send ACAO for WebGL Image uploads (verify before adding — marketing-files does NOT).
  // Peer content / profiles.
  if (/peer[^/]*\.decentraland\.(org|zone|today)\//i.test(url)) return true
  if (/peer-ec\d*\.decentraland\./i.test(url)) return true
  // Content CDN for scene assets.
  if (/^https?:\/\/[^/]*content\.decentraland\./i.test(url)) return true
  if (/gstatic\.com\//i.test(url)) return true
  // Arweave gateways send ACAO:* — direct fetch/Image works after redirect.
  if (/\.arweave\.net\//i.test(url)) return true
  if (/^https?:\/\/arweave\.net\//i.test(url)) return true
  // GitHub raw / user content (plaza banner sheet images).
  if (/raw\.githubusercontent\.com\//i.test(url)) return true
  if (/user-images\.githubusercontent\.com\//i.test(url)) return true
  // RickRoll CameraOperator QR images — server sends ACAO:*.
  if (/\.lastslice\.co\//i.test(url)) return true
  // Planet Angzaar cutscene / stream thumbnails.
  if (/dclstreams\.com\//i.test(url)) return true
  // Event / social image hosts commonly used by plaza boards.
  if (/images\.unsplash\.com\//i.test(url)) return true
  if (/res\.cloudinary\.com\//i.test(url)) return true
  if (/imgur\.com\//i.test(url) || /i\.imgur\.com\//i.test(url)) return true
  // Genesis Plaza event posters (events API CDN — ACAO:*).
  if (/events-assets[^/]*\.decentraland\.org\//i.test(url)) return true
  if (/^https?:\/\/events\.decentraland\.org\//i.test(url)) return true
  // Everything else (incl. marketing-files.decentraland.org) → /api/texture proxy.
  return false
}

/** Guess image MIME from URL path when servers send application/octet-stream (event posters). */
export function guessImageMimeFromUrl(url: string): string | null {
  const path = url.split('?')[0]?.split('#')[0]?.toLowerCase() ?? ''
  if (path.endsWith('.webp')) return 'image/webp'
  if (path.endsWith('.png')) return 'image/png'
  if (path.endsWith('.jpg') || path.endsWith('.jpeg')) return 'image/jpeg'
  if (path.endsWith('.gif')) return 'image/gif'
  if (path.endsWith('.avif')) return 'image/avif'
  if (path.endsWith('.bmp')) return 'image/bmp'
  // Proxy path embeds the remote path — sniff leaf after last slash.
  if (url.startsWith(TEXTURE_PROXY_PREFIX)) {
    const leaf = path.split('/').pop() ?? ''
    if (leaf.endsWith('.webp')) return 'image/webp'
    if (leaf.endsWith('.png')) return 'image/png'
    if (leaf.endsWith('.jpg') || leaf.endsWith('.jpeg')) return 'image/jpeg'
    if (leaf.endsWith('.gif')) return 'image/gif'
  }
  return null
}

/**
 * Magic-byte MIME for content CDN hashes (no file extension) served as
 * `application/octet-stream` + `X-Content-Type-Options: nosniff`.
 * Image() rejects those; fetch + typed blob is required (Jump Zone logos, etc.).
 */
export function guessImageMimeFromBytes(bytes: ArrayBuffer | Uint8Array): string | null {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  if (u8.length < 12) return null
  // PNG
  if (u8[0] === 0x89 && u8[1] === 0x50 && u8[2] === 0x4e && u8[3] === 0x47) return 'image/png'
  // JPEG
  if (u8[0] === 0xff && u8[1] === 0xd8 && u8[2] === 0xff) return 'image/jpeg'
  // GIF
  if (u8[0] === 0x47 && u8[1] === 0x49 && u8[2] === 0x46 && u8[3] === 0x38) return 'image/gif'
  // WebP: RIFF....WEBP
  if (
    u8[0] === 0x52 &&
    u8[1] === 0x49 &&
    u8[2] === 0x46 &&
    u8[3] === 0x46 &&
    u8[8] === 0x57 &&
    u8[9] === 0x45 &&
    u8[10] === 0x42 &&
    u8[11] === 0x50
  ) {
    return 'image/webp'
  }
  // BMP
  if (u8[0] === 0x42 && u8[1] === 0x4d) return 'image/bmp'
  return null
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
  if (url.startsWith(TEXTURE_PROXY_PREFIX)) return true
  if (/\.arweave\.net\//i.test(url) || /^https?:\/\/arweave\.net\//i.test(url)) return true
  // Event posters are often .webp with Content-Type: application/octet-stream — fetch + typed blob.
  if (/\.webp(\?|#|$)/i.test(url)) return true
  // Scene content CDN: `/content/contents/<cid>` (no extension) + octet-stream + nosniff.
  // TextureLoader/Image() refuses; fetch + magic-byte MIME is required (Jump Zone board art).
  if (/\/content\/contents\//i.test(url)) return true
  if (/\/contents\/(bafy|bafkre|Qm)/i.test(url)) return true
  // Any decentraland content host (peer-ec1, etc.) may serve PNG as octet-stream.
  if (/decentraland\.(org|zone|today)\/.*\/contents\//i.test(url)) return true
  return false
}