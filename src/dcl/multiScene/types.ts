/**
 * Multi-scene FocusOwner + LOD rings (product model):
 * - primary: parcel under feet — **FocusOwner** (UI, audio, video, inputs, locomotion)
 * - secondary (live): muted workers when **player** ≤16m of that scene; keep until 80m
 *   (hard-capped; no media/UI). Stand-on / sticky demote still promote-safe.
 * - tertiary: Scene Distance disc — roads, empty land, composite shells (no worker)
 * - pe: portable experience / smart wearable (own UI root; arbiter below primary)
 *
 * Warm/visual band = user Scene Distance (`sceneLoadRadiusM`). Live workers use
 * player enter/keep radii (caps.ts) — warm-all ≠ live-all.
 */

export type SceneWorkerKind = 'primary' | 'secondary' | 'pe'

/**
 * Focus policy for a SceneScriptSystem.
 * - primary: media on, UI may show (play-chrome gates visibility)
 * - secondary: hard mute + video stop + UI never shown
 * - pe: media on; UI owned by PortableExperienceManager
 */
export type FocusPolicy = 'primary' | 'secondary' | 'pe'

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
  /**
   * Min distance (m) from **player feet** to this scene's footprint edge.
   * Live boot at ≤ enter (16m); keep scripts until ≤ keep (80m).
   */
  distM: number
  /** Parcel footprint size — large estates prefer composite, not full live worker. */
  parcelCount?: number
  /**
   * Absolute parcel keys this deployment covers. Required for under-feet priority
   * (base alone fails when player stands on a non-base multi-parcel cell).
   */
  parcels?: string[]
}
