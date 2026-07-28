import type { PetAnimClipMap, PetAnimState, PetCategory } from './types'
import { PET_ANIM_STATES } from './types'

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
  /** Default clip aliases per anim band (used when animClipMap has no entry). */
  clipAliases: Record<PetAnimState, string[]>
}

const LOCO_ALIASES_WALK: Record<PetAnimState, string[]> = {
  idle: ['idle', 'Idle', 'stand', 'Stand'],
  walk: ['walk', 'Walk', 'walking', 'Walking'],
  run: ['run', 'Run', 'sprint', 'Sprint'],
  fly: ['walk', 'Walk'],
  flyFast: ['run', 'Run'],
  afk: ['afk', 'AFK', 'sit', 'Sit', 'sleep', 'Sleep', 'rest', 'Rest', 'idle', 'Idle']
}

const LOCO_ALIASES_FLY: Record<PetAnimState, string[]> = {
  idle: ['idle', 'Idle', 'hover', 'Hover'],
  walk: ['fly', 'Fly', 'flap', 'Flap', 'walk', 'Walk'],
  run: ['flyFast', 'FlyFast', 'dash', 'Dash', 'run', 'Run', 'fly', 'Fly'],
  fly: ['fly', 'Fly', 'flap', 'Flap', 'walk', 'Walk'],
  flyFast: ['flyFast', 'FlyFast', 'dash', 'Dash', 'run', 'Run', 'fly', 'Fly'],
  afk: ['afk', 'AFK', 'hover', 'Hover', 'idle', 'Idle', 'sit', 'Sit']
}

export const PET_CATEGORY_CONFIG: Record<PetCategory, PetCategoryConfig> = {
  walking: {
    yOffset: 0.05,
    bobAmplitude: 0,
    bobHz: 0,
    followRate: 6,
    yawRate: 10,
    clipAliases: LOCO_ALIASES_WALK
  },
  flying: {
    yOffset: 1.6,
    bobAmplitude: 0.08,
    bobHz: 0.9,
    followRate: 4.5,
    yawRate: 8,
    clipAliases: LOCO_ALIASES_FLY
  }
}

/** Horizontal speed thresholds for loco clips (m/s). */
export const PET_IDLE_SPEED = 0.12
export const PET_WALK_SPEED = 2.2

/** Owner must stay under idle speed this long before AFK clips play. */
export const PET_AFK_IDLE_MS = 5 * 60 * 1000

export function resolvePetAnimState(category: PetCategory, horizontalSpeed: number): PetAnimState {
  if (horizontalSpeed < PET_IDLE_SPEED) return 'idle'
  if (category === 'flying') {
    return horizontalSpeed < PET_WALK_SPEED ? 'fly' : 'flyFast'
  }
  return horizontalSpeed < PET_WALK_SPEED ? 'walk' : 'run'
}

export function isPetAnimState(value: unknown): value is PetAnimState {
  return typeof value === 'string' && (PET_ANIM_STATES as readonly string[]).includes(value)
}

/** Sanitize user/library animClipMap — drop empty pools and unknown keys. */
export function normalizeAnimClipMap(raw: unknown): PetAnimClipMap | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const out: PetAnimClipMap = {}
  let any = false
  for (const state of PET_ANIM_STATES) {
    const list = (raw as Record<string, unknown>)[state]
    if (!Array.isArray(list)) continue
    const names = list
      .filter((n): n is string => typeof n === 'string' && n.trim().length > 0)
      .map((n) => n.trim())
    if (!names.length) continue
    out[state] = [...new Set(names)]
    any = true
  }
  return any ? out : undefined
}

export function petAnimStateLabel(state: PetAnimState): string {
  switch (state) {
    case 'idle':
      return 'Idle'
    case 'walk':
      return 'Walk'
    case 'run':
      return 'Run'
    case 'fly':
      return 'Fly'
    case 'flyFast':
      return 'Fly fast'
    case 'afk':
      return 'AFK'
    default:
      return state
  }
}
