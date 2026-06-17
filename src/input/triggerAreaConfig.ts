/** TriggerArea detection backend — Tier A default; Tier B opt-in via URL. */

export type TriggerAreaBackend = 'math' | 'physx'

function readSearchParams(): URLSearchParams | null {
  try {
    if (typeof location === 'undefined') return null
    return new URLSearchParams(location.search)
  } catch {
    return null
  }
}

/** `?triggerPhysx` or `?triggerArea=physx` — PhysX trigger actors + capsule overlap. */
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

/** `?triggerverbose` — log enter/exit on the client debug panel. */
export function isTriggerAreaVerbose(): boolean {
  const params = readSearchParams()
  return params?.has('triggerverbose') ?? false
}