/** Pet locomotion / height class — first-class inventory + network metadata. */
export type PetCategory = 'walking' | 'flying'

export type PetAnimState = 'idle' | 'walk' | 'run' | 'fly' | 'flyFast'

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
}
