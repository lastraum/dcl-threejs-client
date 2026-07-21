/**
 * Mirror PE worker state onto main-thread primary systems the avatar/physics read.
 *
 * PE has a full SceneScriptSystem, but PlayerSystem locomotion / physics only consult the
 * primary SceneScriptSystem projection. Without this bridge, PE InputModifier and
 * PhysicsCombinedForce/Impulse never affect the real capsule.
 *
 * VirtualCamera / MainCamera are NOT mirrored: PE VirtualCamera entities live in the PE
 * entity store. World switches PlayerSystem onto the PE VirtualCameraBridge instead.
 * Copying MainCamera.virtualCameraEntity ids onto empty primary ECS blocked freecam
 * without ever driving the lens (drone appeared frozen).
 *
 * Priority: primary wins when both write the same channel (caller drains privileged intents
 * after this so PE movePlayer only applies if primary silent). For continuous components
 * (InputModifier, forces), PE values apply when PE has them; when PE clears, we remove only
 * what we previously mirrored (primary scene puts still win if present).
 */
import type { Entity } from '@dcl/ecs'
import type { SceneScriptSystem } from '../../core/systems/SceneScriptSystem'
import type { PlayerSystem } from '../../player/PlayerSystem'
import type { PortableExperienceManager } from './PortableExperienceManager'

export type PeMainThreadMirrorContext = {
  pe: PortableExperienceManager
  primary: SceneScriptSystem
  player: PlayerSystem | null
  /** Apply movePlayer / emote / teleport from arbiter (primary-silent only). */
  drainPrivilegedIntents: () => void
}

type StandardMode = {
  disableAll?: boolean
  disableWalk?: boolean
  disableJog?: boolean
  disableRun?: boolean
  disableJump?: boolean
  disableDoubleJump?: boolean
  disableEmote?: boolean
  disableGliding?: boolean
}

function readStandard(mod: unknown): StandardMode | null {
  if (!mod || typeof mod !== 'object') return null
  const mode = (mod as { mode?: { $case?: string; standard?: StandardMode } }).mode
  if (mode?.$case !== 'standard' || !mode.standard) return null
  return mode.standard
}

function freezesAvatar(mod: unknown): boolean {
  const s = readStandard(mod)
  if (!s) return false
  if (s.disableAll) return true
  return !!(s.disableWalk && s.disableJog && s.disableRun)
}

function cloneJson<T>(value: T): T {
  try {
    return structuredClone(value)
  } catch {
    return JSON.parse(JSON.stringify(value)) as T
  }
}

/**
 * Every play frame after PE workers tick — push PE effects onto primary projection + player.
 */
export class PeMainThreadMirror {
  private inputMirrored = false
  private forceMirrored = false
  private impulseMirrored = false
  private lastFreezeLog = false

  /** Max PhysicsCombinedImpulse Lamport across primary + all PE workers. */
  impulseLamportAcross(primary: SceneScriptSystem, pe: PortableExperienceManager): number {
    let max = primary.getPhysicsImpulseLamport()
    for (const sys of pe.getRunningSystems()) {
      try {
        max = Math.max(max, sys.getPhysicsImpulseLamport())
      } catch {
        /* ignore */
      }
    }
    return max
  }

  apply(ctx: PeMainThreadMirrorContext): void {
    const systems = ctx.pe.getRunningSystems()
    if (!systems.length) {
      this.clearAllMirrored(ctx)
      ctx.drainPrivilegedIntents()
      return
    }

    this.mirrorInputModifier(ctx, systems)
    this.mirrorPhysicsCombined(ctx, systems)
    ctx.drainPrivilegedIntents()
  }

  private mirrorInputModifier(
    ctx: PeMainThreadMirrorContext,
    systems: SceneScriptSystem[]
  ): void {
    const { InputModifier } = ctx.primary.readComponents
    const player = ctx.primary.view.PlayerEntity as Entity

    let peMod: unknown | null = null
    for (const sys of systems) {
      try {
        const im = sys.readComponents.InputModifier
        const pe = sys.view.PlayerEntity as Entity
        if (!im.has(pe)) continue
        const mod = im.get(pe)
        if (freezesAvatar(mod)) {
          peMod = mod
          break
        }
        if (!peMod) peMod = mod
      } catch {
        /* ignore */
      }
    }

    if (peMod) {
      InputModifier.createOrReplace(player, cloneJson(peMod) as never)
      if (!this.inputMirrored || freezesAvatar(peMod) !== this.lastFreezeLog) {
        this.inputMirrored = true
        this.lastFreezeLog = freezesAvatar(peMod)
        if (this.lastFreezeLog) {
          console.info('[pe-mirror] InputModifier → avatar freeze (PE owns locomotion)')
        }
      }
      if (freezesAvatar(peMod)) {
        ctx.player?.clearMoveKeys()
      }
      return
    }

    if (this.inputMirrored) {
      InputModifier.deleteFrom(player)
      this.inputMirrored = false
      this.lastFreezeLog = false
      console.info('[pe-mirror] InputModifier cleared — avatar locomotion restored')
    }
  }

  private mirrorPhysicsCombined(
    ctx: PeMainThreadMirrorContext,
    systems: SceneScriptSystem[]
  ): void {
    const primary = ctx.primary.readComponents
    const player = ctx.primary.view.PlayerEntity as Entity

    // Continuous force — last PE write wins among PEs (primary component only holds one vector).
    let force: unknown | null = null
    let impulse: unknown | null = null
    let bestImpulseLamport = 0

    for (const sys of systems) {
      try {
        const pe = sys.view.PlayerEntity as Entity
        const Force = sys.readComponents.PhysicsCombinedForce
        const Impulse = sys.readComponents.PhysicsCombinedImpulse
        if (Force?.has(pe)) {
          force = Force.get(pe)
        }
        if (Impulse?.has(pe)) {
          const lamport = sys.getPhysicsImpulseLamport()
          if (lamport >= bestImpulseLamport) {
            bestImpulseLamport = lamport
            impulse = Impulse.get(pe)
          }
        }
      } catch {
        /* ignore */
      }
    }

    if (force && primary.PhysicsCombinedForce) {
      primary.PhysicsCombinedForce.createOrReplace(player, cloneJson(force) as never)
      this.forceMirrored = true
    } else if (this.forceMirrored && primary.PhysicsCombinedForce) {
      primary.PhysicsCombinedForce.deleteFrom(player)
      this.forceMirrored = false
    }

    if (impulse && primary.PhysicsCombinedImpulse) {
      primary.PhysicsCombinedImpulse.createOrReplace(player, cloneJson(impulse) as never)
      this.impulseMirrored = true
    } else if (this.impulseMirrored && primary.PhysicsCombinedImpulse) {
      // Don't delete impulse if primary scene also writes — only clear if we put it and PE gone.
      // Keep last impulse for one frame then clear when PE has no component.
      primary.PhysicsCombinedImpulse.deleteFrom(player)
      this.impulseMirrored = false
    }
  }

  private clearAllMirrored(ctx: PeMainThreadMirrorContext): void {
    const { InputModifier, PhysicsCombinedForce, PhysicsCombinedImpulse } = ctx.primary.readComponents
    const player = ctx.primary.view.PlayerEntity as Entity

    if (this.inputMirrored) {
      InputModifier.deleteFrom(player)
      this.inputMirrored = false
      this.lastFreezeLog = false
    }
    if (this.forceMirrored && PhysicsCombinedForce) {
      PhysicsCombinedForce.deleteFrom(player)
      this.forceMirrored = false
    }
    if (this.impulseMirrored && PhysicsCombinedImpulse) {
      PhysicsCombinedImpulse.deleteFrom(player)
      this.impulseMirrored = false
    }
  }

  reset(): void {
    this.inputMirrored = false
    this.forceMirrored = false
    this.impulseMirrored = false
    this.lastFreezeLog = false
  }
}
