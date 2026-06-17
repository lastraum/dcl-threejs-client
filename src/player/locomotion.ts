import type { Entity } from '@dcl/ecs'
import type { MirrorComponents } from '../bridge/mirrorComponents'

/** DCL Explorer defaults — docs.decentraland.org player avatar locomotion. */
export const DCL_LOCOMOTION_DEFAULTS = {
  walkSpeed: 1.5,
  jogSpeed: 8,
  /** Shift sprint — faster than auto-jog (Explorer default jog is 8 m/s). */
  runSpeed: 12,
  jumpHeight: 1,
  runJumpHeight: 1.5,
  doubleJumpHeight: 2,
  hardLandingCooldown: 0.75
} as const

export type LocomotionMode = 'walk' | 'jog' | 'run'

export type LocomotionConfig = {
  walkSpeed: number
  jogSpeed: number
  runSpeed: number
  jumpHeight: number
  runJumpHeight: number
  doubleJumpHeight: number
  disableWalk: boolean
  disableJog: boolean
  disableRun: boolean
  disableJump: boolean
  disableDoubleJump: boolean
}

export type LocomotionKeys = {
  ctrl: boolean
  shift: boolean
}

export function defaultLocomotionConfig(): LocomotionConfig {
  return {
    ...DCL_LOCOMOTION_DEFAULTS,
    disableWalk: false,
    disableJog: false,
    disableRun: false,
    disableJump: false,
    disableDoubleJump: false
  }
}

/** Desktop bindings: Ctrl walk · default jog · Shift run (Explorer). */
export function resolveLocomotionMode(keys: LocomotionKeys, config: LocomotionConfig): LocomotionMode {
  if (keys.shift && !config.disableRun) return 'run'
  if (keys.ctrl && !config.disableWalk) return 'walk'
  if (!config.disableJog) return 'jog'
  if (!config.disableRun) return 'run'
  if (!config.disableWalk) return 'walk'
  return 'jog'
}

export function speedForMode(mode: LocomotionMode, config: LocomotionConfig): number {
  switch (mode) {
    case 'walk':
      return config.walkSpeed
    case 'run':
      return config.runSpeed
    default:
      return config.jogSpeed
  }
}

export function jumpHeightForMode(mode: LocomotionMode, config: LocomotionConfig): number {
  return mode === 'run' ? config.runJumpHeight : config.jumpHeight
}

export function readLocomotionFromComponents(components: MirrorComponents, player: Entity): LocomotionConfig {
  const config = defaultLocomotionConfig()

  if (components.AvatarLocomotionSettings.has(player)) {
    const s = components.AvatarLocomotionSettings.get(player)
    if (s.walkSpeed !== undefined) config.walkSpeed = Math.max(0, s.walkSpeed)
    if (s.jogSpeed !== undefined) config.jogSpeed = Math.max(0, s.jogSpeed)
    if (s.runSpeed !== undefined) config.runSpeed = Math.max(0, s.runSpeed)
    if (s.jumpHeight !== undefined) config.jumpHeight = Math.max(0, s.jumpHeight)
    if (s.runJumpHeight !== undefined) config.runJumpHeight = Math.max(0, s.runJumpHeight)
  }

  if (components.InputModifier.has(player)) {
    const mod = components.InputModifier.get(player)
    const std = mod.mode?.$case === 'standard' ? mod.mode.standard : undefined
    if (std?.disableWalk) config.disableWalk = true
    if (std?.disableJog) config.disableJog = true
    if (std?.disableRun) config.disableRun = true
    if (std?.disableJump) config.disableJump = true
    if (std?.disableDoubleJump) config.disableDoubleJump = true
  }

  return config
}
