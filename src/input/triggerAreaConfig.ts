/** TriggerArea detection backend — Explorer-parity CCT capsule overlap by default. */

export type TriggerAreaBackend = 'math' | 'physx'

function readSearchParams(): URLSearchParams | null {
  try {
    if (typeof location === 'undefined') return null
    return new URLSearchParams(location.search)
  } catch {
    return null
  }
}

/**
 * Default: **math** = analytic **player CCT capsule** vs trigger volume (one capsule — Explorer overlap).
 * Optional: `?triggerPhysx` / `?triggerArea=physx` — PhysX scene.overlap with a **query geometry**
 * matching the CCT (not a second character actor; CCT shapes are simulation-only so they cannot
 * be the query volume themselves).
 */
export function resolveTriggerAreaBackend(): TriggerAreaBackend {
  const params = readSearchParams()
  if (!params) return 'math'
  if (params.has('triggerPhysx')) return 'physx'
  const mode = params.get('triggerArea')?.toLowerCase()
  if (mode === 'physx' || mode === 'physics') return 'physx'
  return 'math'
}

/** `?triggerParity` — run math + physx, log set mismatches (dev validation). */
export function isTriggerAreaParityMode(): boolean {
  const params = readSearchParams()
  return params?.has('triggerParity') ?? false
}

/**
 * `?triggerverbose` — extra probe spam (per-volume inside/outside every 3s).
 * Enter/exit always log to the browser console (platform default).
 */
export function isTriggerAreaVerbose(): boolean {
  const params = readSearchParams()
  return params?.has('triggerverbose') ?? false
}
