import { closeHudConfirm, showHudConfirm } from './hudConfirm'

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

  // showHudConfirm exits pointer-lock so the faded dialog is clickable.
  // Scene worker awaits this RPC — a stuck dialog freezes asset-pack actions (CBD Plaza Discord).
  // Safety timeout: never leave the worker hung if the dialog is abandoned.
  const CONFIRM_TIMEOUT_MS = 90_000
  let timedOut = false
  const timeout = window.setTimeout(() => {
    timedOut = true
    closeHudConfirm()
  }, CONFIRM_TIMEOUT_MS)
  let ok = false
  try {
    ok = await showHudConfirm({
      title: 'Open external link',
      message: parsed.href,
      confirmLabel: 'Open',
      cancelLabel: 'Cancel'
    })
  } finally {
    window.clearTimeout(timeout)
  }
  if (timedOut || !ok) return false

  const opened = window.open(parsed.href, '_blank', 'noopener,noreferrer')
  return opened !== null
}
