import type { PetAnimState, PetCategory } from './types'

/** Wire u8 for DPET Announce — unknown → walking. */
export const PetCategoryWire = {
  walking: 0,
  flying: 1
} as const

export function petCategoryFromWire(code: number): PetCategory {
  return code === PetCategoryWire.flying ? 'flying' : 'walking'
}

export function petCategoryToWire(category: PetCategory): number {
  return category === 'flying' ? PetCategoryWire.flying : PetCategoryWire.walking
}

export function normalizePetCategory(value: unknown): PetCategory {
  return value === 'flying' ? 'flying' : 'walking'
}

export type PetCategoryConfig = {
  /** Metres above owner feet for base Y. */
  yOffset: number
  /** Optional idle hover bob amplitude (flying). */
  bobAmplitude: number
  bobHz: number
  /** Horizontal follow rates (1/s-ish lerp). */
  followRate: number
  yawRate: number
  /** Clip aliases per anim band. */
  clipAliases: Record<PetAnimState, string[]>
}

export const PET_CATEGORY_CONFIG: Record<PetCategory, PetCategoryConfig> = {
  walking: {
    yOffset: 0.05,
    bobAmplitude: 0,
    bobHz: 0,
    followRate: 6,
    yawRate: 10,
    clipAliases: {
      idle: ['idle', 'Idle', 'stand', 'Stand'],
      walk: ['walk', 'Walk', 'walking', 'Walking'],
      run: ['run', 'Run', 'sprint', 'Sprint'],
      fly: ['walk', 'Walk'],
      flyFast: ['run', 'Run']
    }
  },
  flying: {
    yOffset: 1.6,
    bobAmplitude: 0.08,
    bobHz: 0.9,
    followRate: 4.5,
    yawRate: 8,
    clipAliases: {
      idle: ['idle', 'Idle', 'hover', 'Hover'],
      walk: ['fly', 'Fly', 'flap', 'Flap', 'walk', 'Walk'],
      run: ['flyFast', 'FlyFast', 'dash', 'Dash', 'run', 'Run', 'fly', 'Fly'],
      fly: ['fly', 'Fly', 'flap', 'Flap', 'walk', 'Walk'],
      flyFast: ['flyFast', 'FlyFast', 'dash', 'Dash', 'run', 'Run', 'fly', 'Fly']
    }
  }
}

/** Horizontal speed thresholds for loco clips (m/s). */
export const PET_IDLE_SPEED = 0.12
export const PET_WALK_SPEED = 2.2

export function resolvePetAnimState(category: PetCategory, horizontalSpeed: number): PetAnimState {
  if (horizontalSpeed < PET_IDLE_SPEED) return 'idle'
  if (category === 'flying') {
    return horizontalSpeed < PET_WALK_SPEED ? 'fly' : 'flyFast'
  }
  return horizontalSpeed < PET_WALK_SPEED ? 'walk' : 'run'
}
