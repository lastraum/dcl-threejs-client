/** True when this browsing context is in the background (rAF frozen / GPU cold). */
export function isDocumentHidden(): boolean {
  return typeof document !== 'undefined' && document.hidden
}

/**
 * Resolve immediately if visible; otherwise wait for the next `visibilitychange`
 * to visible. Loading GPU compile / play-loop start must not run in a hidden tab.
 */
export function whenDocumentVisible(): Promise<void> {
  if (!isDocumentHidden()) return Promise.resolve()
  return new Promise((resolve) => {
    const onChange = (): void => {
      if (document.hidden) return
      document.removeEventListener('visibilitychange', onChange)
      resolve()
    }
    document.addEventListener('visibilitychange', onChange)
  })
}
