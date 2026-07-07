import { catalystPeerBaseUrl } from '../../map/mapConfig'

/** Catalyst nodes removed from the network (see decentraland.github.io/catalyst-monitor). */
const DEPRECATED_CATALYST_HOSTS = new Set([
  'peer-wc1.decentraland.org',
  'peer-ue1.decentraland.org'
])

const SKIP_REWRITE_HOSTS = new Set([
  'worlds-content-server.decentraland.org',
  'profile-images.decentraland.org',
  'marketplace-api.decentraland.org',
  'places.decentraland.org'
])

/**
 * Scene thumbnails from Places API may point at retired catalysts (e.g. peer-wc1).
 * Re-host `/content/contents/{cid}` on the configured live catalyst.
 */
export function rewriteCatalystUrl(
  raw: string | null | undefined,
  fallbackBase = catalystPeerBaseUrl()
): string | null {
  const value = String(raw ?? '').trim()
  if (!value) return null

  let url: URL
  try {
    url = new URL(value)
  } catch {
    return value
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') return value
  if (SKIP_REWRITE_HOSTS.has(url.hostname)) return value

  const fallbackHost = new URL(fallbackBase.replace(/\/$/, '') || 'https://peer.decentraland.org').hostname
  if (url.hostname === fallbackHost) return value

  const isDeprecated = DEPRECATED_CATALYST_HOSTS.has(url.hostname)
  const isPeerCatalyst =
    url.hostname === 'peer.decentraland.org' || /^peer-[a-z0-9]+\.decentraland\.org$/i.test(url.hostname)

  if (!isDeprecated && !isPeerCatalyst) return value
  if (!url.pathname.includes('/content/')) return value

  const base = fallbackBase.replace(/\/$/, '')
  return `${base}${url.pathname}${url.search}`
}