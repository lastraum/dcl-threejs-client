/** Parses `livekit:wss://…?access_token=…` or bare `wss://…?access_token=…`. */
export function parseLiveKitConnectionString(raw: string): { url: string; token: string } {
  const trimmed = raw.trim()
  const withoutLivekit = trimmed.startsWith('livekit:') ? trimmed.slice('livekit:'.length) : trimmed
  const u = new URL(withoutLivekit)
  const token = u.searchParams.get('access_token')
  if (!token) throw new Error('connection_string_missing_access_token')
  const url = `${u.protocol}//${u.host}${u.pathname}`
  return { url, token }
}

export function isLiveKitAdapter(connectionString: string): boolean {
  const trimmed = connectionString.trim()
  return trimmed.startsWith('livekit:') || /^wss?:\/\//i.test(trimmed)
}

/**
 * Hosts that are clearly misconfigured placeholders (common on self-hosted world servers
 * that mint tokens against `livekit.host` without a real DNS target).
 * Connecting will only spam ERR_NAME_NOT_RESOLVED — treat as comms unavailable.
 */
const PLACEHOLDER_LIVEKIT_HOSTS = new Set([
  'livekit.host',
  'livekit.local',
  'localhost',
  '127.0.0.1',
  '0.0.0.0',
  'example.com',
  'example.org'
])

/** True when adapter string points at a known-useless LiveKit host. */
export function isUnusableLiveKitAdapter(connectionString: string): boolean {
  try {
    const { url } = parseLiveKitConnectionString(connectionString)
    const host = new URL(url).hostname.toLowerCase()
    if (PLACEHOLDER_LIVEKIT_HOSTS.has(host)) return true
    // Generic “*.host” placeholders (livekit.host already covered; other *.host TLDs)
    if (host.endsWith('.host') && !host.includes('.')) return true
    if (/\.host$/i.test(host) && host.split('.').length === 2) return true
    return false
  } catch {
    return true
  }
}
