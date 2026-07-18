import { showHudConfirm } from './hudConfirm'

export type OpenExternalUrlRequest = {
  url: string
}

export type OpenExternalUrlResponse = {
  success: boolean
}

/** DCL `RestrictedActions.openExternalUrl` — http/https only, HUD confirm then new tab. */
export async function openExternalUrl(request: OpenExternalUrlRequest): Promise<boolean> {
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

  const ok = await showHudConfirm({
    title: 'Open external link',
    message: parsed.href,
    confirmLabel: 'Open',
    cancelLabel: 'Cancel'
  })
  if (!ok) return false

  const opened = window.open(parsed.href, '_blank', 'noopener,noreferrer')
  return opened !== null
}
