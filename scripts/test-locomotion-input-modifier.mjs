#!/usr/bin/env node
/**
 * Tier A unit checks for locomotion + InputModifier gating (mirrors src/player/locomotion.ts).
 * Run: npm run test:locomotion
 */

const DCL_LOCOMOTION_DEFAULTS = {
  walkSpeed: 1.5,
  jogSpeed: 8,
  runSpeed: 12,
  jumpHeight: 1,
  runJumpHeight: 1.5,
  doubleJumpHeight: 2,
  hardLandingCooldown: 0.75
}

function defaultLocomotionConfig() {
  return {
    ...DCL_LOCOMOTION_DEFAULTS,
    disableAll: false,
    disableWalk: false,
    disableJog: false,
    disableRun: false,
    disableJump: false,
    disableDoubleJump: false,
    disableEmote: false,
    disableGliding: false
  }
}

function resolveLocomotionMode(keys, config) {
  if (keys.shift && !config.disableRun) return 'run'
  if (keys.ctrl && !config.disableWalk) return 'walk'
  if (!config.disableJog) return 'jog'
  if (!config.disableRun) return 'run'
  if (!config.disableWalk) return 'walk'
  return 'jog'
}

function canLocomote(config) {
  if (config.disableAll) return false
  return !config.disableWalk || !config.disableJog || !config.disableRun
}

function canJumpLocomotion(config) {
  return !config.disableAll && !config.disableJump && config.jumpHeight > 0
}

function canDoubleJumpLocomotion(config) {
  return !config.disableAll && !config.disableDoubleJump && config.doubleJumpHeight > 0
}

function canVoluntaryEmote(config) {
  return !config.disableAll && !config.disableEmote
}

function canGlide(config) {
  return !config.disableAll && !config.disableGliding
}

function speedForMode(mode, config) {
  if (!canLocomote(config)) return 0
  switch (mode) {
    case 'walk':
      return config.walkSpeed
    case 'run':
      return config.runSpeed
    default:
      return config.jogSpeed
  }
}

function applyInputModifier(config, std) {
  if (std.disableAll) {
    config.disableAll = true
    config.disableWalk = true
    config.disableJog = true
    config.disableRun = true
    config.disableJump = true
    config.disableDoubleJump = true
    config.disableEmote = true
    config.disableGliding = true
    return
  }
  if (std.disableWalk) config.disableWalk = true
  if (std.disableJog) config.disableJog = true
  if (std.disableRun) config.disableRun = true
  if (std.disableJump) config.disableJump = true
  if (std.disableDoubleJump) config.disableDoubleJump = true
  if (std.disableEmote) config.disableEmote = true
  if (std.disableGliding) config.disableGliding = true
}

function readLocomotionFromMirror(components, player) {
  const config = defaultLocomotionConfig()

  if (components.AvatarLocomotionSettings?.has(player)) {
    const s = components.AvatarLocomotionSettings.get(player)
    if (s.walkSpeed !== undefined) config.walkSpeed = Math.max(0, s.walkSpeed)
    if (s.jogSpeed !== undefined) config.jogSpeed = Math.max(0, s.jogSpeed)
    if (s.runSpeed !== undefined) config.runSpeed = Math.max(0, s.runSpeed)
    if (s.jumpHeight !== undefined) config.jumpHeight = Math.max(0, s.jumpHeight)
    if (s.runJumpHeight !== undefined) config.runJumpHeight = Math.max(0, s.runJumpHeight)
  }

  if (components.InputModifier?.has(player)) {
    const mod = components.InputModifier.get(player)
    const std = mod.mode?.$case === 'standard' ? mod.mode.standard : undefined
    if (std) applyInputModifier(config, std)
  }

  return config
}

let passed = 0
let failed = 0

function assert(label, condition) {
  if (condition) {
    passed += 1
    console.log(`  ok ${label}`)
  } else {
    failed += 1
    console.error(` FAIL ${label}`)
  }
}

console.log('locomotion — defaults')
{
  const cfg = defaultLocomotionConfig()
  assert('can locomote by default', canLocomote(cfg))
  assert('can jump by default', canJumpLocomotion(cfg))
  assert('can double jump by default', canDoubleJumpLocomotion(cfg))
  assert('can voluntary emote by default', canVoluntaryEmote(cfg))
}

console.log('locomotion — disableAll')
{
  const cfg = defaultLocomotionConfig()
  applyInputModifier(cfg, { disableAll: true })
  assert('disableAll blocks locomotion', !canLocomote(cfg))
  assert('disableAll blocks jump', !canJumpLocomotion(cfg))
  assert('disableAll blocks double jump', !canDoubleJumpLocomotion(cfg))
  assert('disableAll blocks voluntary emote', !canVoluntaryEmote(cfg))
  assert('disableAll blocks glide', !canGlide(cfg))
  assert('disableAll zeroes speed', speedForMode('jog', cfg) === 0)
}

console.log('locomotion — partial disables')
{
  const cfg = defaultLocomotionConfig()
  applyInputModifier(cfg, { disableWalk: true, disableJog: true, disableRun: true })
  assert('all movement modes disabled', !canLocomote(cfg))

  const jumpOnly = defaultLocomotionConfig()
  applyInputModifier(jumpOnly, { disableJump: true })
  assert('disableJump only', !canJumpLocomotion(jumpOnly) && canLocomote(jumpOnly))

  const emoteOnly = defaultLocomotionConfig()
  applyInputModifier(emoteOnly, { disableEmote: true })
  assert('disableEmote only', !canVoluntaryEmote(emoteOnly) && canLocomote(emoteOnly))
}

console.log('locomotion — resolveLocomotionMode')
{
  const noKeys = { ctrl: false, shift: false }
  const cfg = defaultLocomotionConfig()
  assert('default jog', resolveLocomotionMode(noKeys, cfg) === 'jog')
  assert('shift run', resolveLocomotionMode({ ctrl: false, shift: true }, cfg) === 'run')
  assert('ctrl walk', resolveLocomotionMode({ ctrl: true, shift: false }, cfg) === 'walk')

  const noRun = defaultLocomotionConfig()
  applyInputModifier(noRun, { disableRun: true })
  assert('shift falls back when run disabled', resolveLocomotionMode({ ctrl: false, shift: true }, noRun) === 'jog')
}

console.log('locomotion — mirror read path')
{
  const player = 1
  const components = {
    AvatarLocomotionSettings: {
      has: (e) => e === player,
      get: () => ({ jogSpeed: 10, jumpHeight: 0 })
    },
    InputModifier: {
      has: (e) => e === player,
      get: () => ({
        mode: {
          $case: 'standard',
          standard: { disableEmote: true, disableJump: true }
        }
      })
    }
  }
  const cfg = readLocomotionFromMirror(components, player)
  assert('AvatarLocomotionSettings jog speed', cfg.jogSpeed === 10)
  assert('zero jump height blocks jump', !canJumpLocomotion(cfg))
  assert('InputModifier disableEmote applied', !canVoluntaryEmote(cfg))
  assert('movement still allowed', canLocomote(cfg))
}

console.log(`\nlocomotion: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)