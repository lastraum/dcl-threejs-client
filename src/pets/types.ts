/** Pet locomotion / height class — first-class inventory + network metadata. */
export type PetCategory = 'walking' | 'flying'

/**
 * Locomotion / behavior animation band.
 * `afk` plays when the owner is idle ≥5 minutes (local + pose wire).
 */
export type PetAnimState = 'idle' | 'walk' | 'run' | 'fly' | 'flyFast' | 'afk'

/**
 * User-authored clip → anim-state mapping.
 * Multiple clip names per state → random pick when that state is entered.
 */
export type PetAnimClipMap = Partial<Record<PetAnimState, string[]>>

/** All anim states that can appear in the edit panel mapper. */
export const PET_ANIM_STATES: readonly PetAnimState[] = [
  'idle',
  'walk',
  'run',
  'fly',
  'flyFast',
  'afk'
] as const

/** Library row for a user-uploaded pet GLB. */
export type PetLibraryEntry = {
  contentHash: string
  fileName: string
  byteSize: number
  addedAt: number
  category: PetCategory
  nickname?: string
  /**
   * Extra Y rotation applied to the GLB mesh only (degrees).
   * Use 180 when the export faces the wrong way relative to movement.
   */
  meshYawOffsetDeg?: number
  /** Clip names discovered in the GLB (cached at upload / first list). */
  clipNames?: string[]
  /** Per-anim-state clip pools (overrides default aliases). */
  animClipMap?: PetAnimClipMap
}

/** Per-wallet inventory snapshot in localStorage. */
export type PetInventoryState = {
  owned: PetLibraryEntry[]
  /** Active equipped content hash, or null when disabled. */
  activeHash: string | null
}

/** Local sim / network pose (DCL scene-local meters). */
export type PetPose = {
  x: number
  y: number
  z: number
  yaw: number
  horizontalSpeed: number
  anim: PetAnimState
}

export type ActivePetSpec = {
  contentHash: string
  category: PetCategory
  nickname?: string
  fileName?: string
  meshYawOffsetDeg?: number
  animClipMap?: PetAnimClipMap
}
