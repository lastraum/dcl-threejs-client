export type OpenExternalUrlRequest = {
  url: string
}

export type OpenExternalUrlResponse = {
  success: boolean
}

/** DCL `RestrictedActions.openExternalUrl` — http/https only, opens in a new tab. */
export function openExternalUrl(request: OpenExternalUrlRequest): boolean {
  const url = request.url?.trim()
  if (!url) return false

  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return false
  }

  const opened = window.open(parsed.href, '_blank', 'noopener,noreferrer')
  return opened !== null
}
