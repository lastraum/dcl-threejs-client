/**
 * Multi-scene worker tiers:
 * - primary: parcel under feet (full privilege)
 * - secondary: inner AOI live scripts (throttled, limited privilege)
 * - tertiary: outer AOI visuals only (no worker — AoiVisualLayer)
 * - pe: portable experience / smart wearable (full surface, below primary)
 */

export type SceneWorkerKind = 'primary' | 'secondary' | 'pe'

/** Higher number wins on privileged channels. */
export const SCENE_WORKER_PRIORITY: Record<SceneWorkerKind, number> = {
  primary: 100,
  pe: 50,
  secondary: 10
}

export type PrivilegedChannel =
  | 'movePlayer'
  | 'camera'
  | 'teleport'
  | 'emote'
  | 'openExternal'
  | 'changeRealm'
  | 'locomotionClear'

export type PeSlotStatus =
  | 'available' // detected, not running, may need consent
  | 'prompted' // consent modal shown this session
  | 'running'
  | 'user_disabled' // closed / HUD off — fully unloaded
  | 'scene_blocked' // primary scene forbids PE

export type PeCandidate = {
  id: string
  urn: string
  title: string
  /** Thumbnail / menu icon URL if known. */
  iconUrl?: string
  /** Larger wearable / navmap thumbnail for consent modal. */
  thumbnailUrl?: string
  /**
   * scene.json `requiredPermissions` codes
   * (USE_WEB3_API, OPEN_EXTERNAL_LINK, USE_FETCH, …).
   */
  permissions: string[]
}

export type PeSlotState = {
  candidate: PeCandidate
  status: PeSlotStatus
  /** While running: show PE scene UI. */
  uiEnabled: boolean
  /** User chose Enable this session (survives /goto world rebuild). */
  wantEnabled: boolean
}

export type SecondaryLiveRequest = {
  entityId: string
  title: string
  base: string
  resolveX: number
  resolveY: number
  distM: number
}
