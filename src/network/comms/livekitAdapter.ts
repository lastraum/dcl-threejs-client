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
