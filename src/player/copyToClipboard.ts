/**
 * SDK `RestrictedActions.copyToClipboard`.
 */
export type CopyToClipboardRequest = {
  text: string
}

/** SDK EmptyResponse. */
export type CopyToClipboardResponse = Record<string, never>

export async function copyToClipboard(request: CopyToClipboardRequest): Promise<boolean> {
  const text = typeof request.text === 'string' ? request.text : ''
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    /* fall through */
  }
  // Fallback for insecure contexts / denied permission.
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.setAttribute('readonly', '')
    ta.style.cssText = 'position:fixed;left:-9999px;top:0'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    ta.remove()
    return ok
  } catch {
    return false
  }
}
