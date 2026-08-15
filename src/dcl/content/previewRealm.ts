/**
 * Same-machine Creator Hub / `sdk-commands start` preview realm.
 *
 * Explorer / Bevy Web:
 *   decentraland://realm=http://127.0.0.1:8000&local-scene=true
 *   https://decentraland.org/bevy-web/?preview=true&realm=http://127.0.0.1:8000
 *
 * This client:
 *   /preview
 *   /preview?port=8001
 *   /preview?realm=http://127.0.0.1:8000
 *   ?preview=true&realm=http://127.0.0.1:8000
 *
 * Only loopback hosts are accepted — the tab must be on the same machine as Hub.
 */

export const DEFAULT_PREVIEW_REALM = 'http://127.0.0.1:8000'
export const DEFAULT_PREVIEW_PORT = 8000

export function isTruthyQueryFlag(value: string | null | undefined): boolean {
  if (!value) return false
  const v = value.trim().toLowerCase()
  return v === '1' || v === 'true' || v === 'yes'
}

export function isPreviewLoopbackHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase()
  return h === '127.0.0.1' || h === 'localhost' || h === '::1'
}

function decodeMaybe(raw: string): string {
  let text = raw.trim()
  try {
    if (/%[0-9a-f]{2}/i.test(text)) text = decodeURIComponent(text)
  } catch {
    /* keep raw */
  }
  return text.trim()
}

/**
 * Parse a Hub / Explorer preview realm into an origin (`http://127.0.0.1:8000`).
 * Returns null for non-loopback hosts (custom worlds servers, LAN, etc.).
 */
export function parsePreviewRealmUrl(raw: string | null | undefined): string | null {
  if (!raw) return null
  const text = decodeMaybe(raw).replace(/\/+$/, '')
  if (!text) return null

  let candidate = text
  if (candidate.startsWith('//')) candidate = `http:${candidate}`
  if (!/^https?:\/\//i.test(candidate)) {
    const hostPart = candidate.split('/')[0] ?? candidate
    const hostname = hostPart.replace(/:\d+$/, '').replace(/^\[|\]$/g, '')
    if (!isPreviewLoopbackHost(hostname)) return null
    candidate = `http://${candidate}`
  }

  let url: URL
  try {
    url = new URL(candidate)
  } catch {
    return null
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  if (!isPreviewLoopbackHost(url.hostname)) return null

  const port = url.port || String(DEFAULT_PREVIEW_PORT)
  return `${url.protocol}//${url.hostname}:${port}`
}

/** Effective preview origin from `?realm=` / `?port=` (default 127.0.0.1:8000). */
export function previewRealmFromSearch(params: URLSearchParams): string {
  const fromRealm = parsePreviewRealmUrl(params.get('realm'))
  if (fromRealm) return fromRealm

  const portRaw = params.get('port')?.trim()
  if (portRaw && /^\d{1,5}$/.test(portRaw)) {
    const port = Number(portRaw)
    if (Number.isInteger(port) && port >= 1 && port <= 65535) {
      return `http://127.0.0.1:${port}`
    }
  }

  return DEFAULT_PREVIEW_REALM
}

/** True when the URL is asking to load the same-machine Hub preview. */
export function isPreviewQuery(params: URLSearchParams): boolean {
  if (isTruthyQueryFlag(params.get('preview'))) return true
  if (isTruthyQueryFlag(params.get('local-scene'))) return true
  return parsePreviewRealmUrl(params.get('realm')) !== null
}
