/** `?gltfloadstate` / `?gltfloadingverbose` — log GltfContainerLoadingState host→worker path. */
export function isGltfLoadingStateVerbose(): boolean {
  try {
    if (typeof location === 'undefined') return false
    const params = new URLSearchParams(location.search)
    if (params.has('gltfloadstate') || params.has('gltfloadingverbose')) return true
  } catch {
    /* ignore */
  }
  try {
    if (localStorage.getItem('gltfloadstate') === '1') return true
  } catch {
    /* ignore */
  }
  return false
}

/** ADR-215 LoadingState labels for logs. */
export function gltfLoadingStateLabel(currentState: number): string {
  switch (currentState) {
    case 0:
      return 'UNKNOWN'
    case 1:
      return 'LOADING'
    case 2:
      return 'NOT_FOUND'
    case 3:
      return 'FINISHED_WITH_ERROR'
    case 4:
      return 'FINISHED'
    default:
      return `state=${currentState}`
  }
}
