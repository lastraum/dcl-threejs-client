/**
 * Continuous player claims from scene layers (PX + primary).
 *
 * Product law (host-owned input):
 * - WASD / freecam always host capsule — PX InputModifier never freezes the body.
 * - Scene-authored moves (movePlayerTo, force/impulse) apply on host then rebroadcast.
 * - Camera / force claims still merge by priority.
 *
 * @see docs/PORTABLE_EXPERIENCE_COD.md
 */
import type { Entity } from '@dcl/ecs'
import type { VirtualCameraBridge } from '../../camera/VirtualCameraBridge'
import type { SceneScriptSystem } from '../../core/systems/SceneScriptSystem'
import type { PlayerSystem } from '../../player/PlayerSystem'
import { freezesAvatarFromModifier } from '../../player/locomotion'
import type { SceneLayer } from './SceneLayerRegistry'
import type { SceneWorkerKind } from './types'

export { freezesAvatarFromModifier } from '../../player/locomotion'

export type LocomotionClaim = {
  layerId: string
  kind: SceneWorkerKind
  priority: number
  inputModifier: unknown
  freezesAvatar: boolean
  primaryHasComponent: boolean
}

export type CameraClaim = {
  layerId: string
  kind: SceneWorkerKind
  priority: number
  system: SceneScriptSystem
  bridge: VirtualCameraBridge | null
  mainCameraBound: boolean
}

export type ForceClaim = {
  layerId: string
  kind: SceneWorkerKind
  priority: number
  force: unknown | null
  impulse: unknown | null
  impulseLamport: number
}

export type PlayerHostClaims = {
  /** Primary InputModifier only — host owns walk; PX never freezes capsule via IM. */
  locomotion: LocomotionClaim | null
  camera: CameraClaim | null
  force: ForceClaim | null
}

function cloneJson<T>(value: T): T {
  try {
    return structuredClone(value)
  } catch {
    return JSON.parse(JSON.stringify(value)) as T
  }
}

/**
 * Collect continuous claims from all layers.
 * Policy: primary IM present → primary wins locomotion; else PX wins if any.
 */
export function collectPlayerClaims(layers: readonly SceneLayer[]): PlayerHostClaims {
  let primaryLocomotion: LocomotionClaim | null = null
  let camera: CameraClaim | null = null
  let force: ForceClaim | null = null

  for (const layer of layers) {
    if (layer.kind === 'secondary') continue

    try {
      const sys = layer.system
      const playerEnt = sys.view.PlayerEntity as Entity
      const camEnt = sys.view.CameraEntity as Entity
      const { InputModifier, MainCamera, PhysicsCombinedForce, PhysicsCombinedImpulse } =
        sys.readComponents

      // Locomotion freeze: **primary only**. Host WASD always; PX never freezes the capsule.
      if (layer.kind === 'primary' && InputModifier.has(playerEnt)) {
        const mod = InputModifier.get(playerEnt)
        primaryLocomotion = {
          layerId: layer.id,
          kind: layer.kind,
          priority: layer.priority,
          inputModifier: mod,
          freezesAvatar: freezesAvatarFromModifier(mod),
          primaryHasComponent: true
        }
      }

      const main = MainCamera.getOrNull(camEnt) as { virtualCameraEntity?: number } | null
      const vcBound =
        main?.virtualCameraEntity !== undefined && main?.virtualCameraEntity !== null
      const bridge = sys.getVirtualCameraBridge()
      const bridgeActive = !!bridge && (bridge.isMainCameraVcBound() || bridge.isActive())
      if (vcBound || bridgeActive) {
        const claim: CameraClaim = {
          layerId: layer.id,
          kind: layer.kind,
          priority: layer.priority,
          system: sys,
          bridge,
          mainCameraBound: !!vcBound || bridgeActive
        }
        if (!camera) {
          camera = claim
        } else if (layer.kind === 'pe' && claim.mainCameraBound && camera.kind === 'primary') {
          const primaryBound = camera.bridge?.isMainCameraVcBound() === true
          if (!primaryBound) camera = claim
          else if (claim.priority > camera.priority) camera = claim
        } else if (claim.priority > camera.priority) {
          camera = claim
        }
      }

      // Scene-authored physics on the player (pads, thrusters) — not input.
      let f: unknown | null = null
      let imp: unknown | null = null
      let lamport = 0
      if (PhysicsCombinedForce?.has(playerEnt)) f = PhysicsCombinedForce.get(playerEnt)
      if (PhysicsCombinedImpulse?.has(playerEnt)) {
        imp = PhysicsCombinedImpulse.get(playerEnt)
        lamport = sys.getPhysicsImpulseLamport()
      }
      if (f || imp) {
        const claim: ForceClaim = {
          layerId: layer.id,
          kind: layer.kind,
          priority: layer.priority,
          force: f,
          impulse: imp,
          impulseLamport: lamport
        }
        if (
          !force ||
          claim.priority > force.priority ||
          (claim.priority === force.priority && claim.impulseLamport >= force.impulseLamport)
        ) {
          force = claim
        }
      }
    } catch {
      /* layer not ready */
    }
  }

  return { locomotion: primaryLocomotion, camera, force }
}

export type ApplyPlayerClaimsContext = {
  primary: SceneScriptSystem
  player: PlayerSystem | null
  setVirtualCameraBridge: (bridge: VirtualCameraBridge | null) => void
  primaryVirtualCameraBridge: () => VirtualCameraBridge | null
  drainPrivilegedIntents: () => void
  /** Ensure every layer receives host feet after scene-authored moves. */
  rebroadcastHostPoses: () => void
  layers: readonly SceneLayer[]
}

/**
 * Apply merged claims onto host.
 * Locomotion freeze = primary only. PX force/impulse = scene-authored motion on capsule.
 * movePlayerTo intents drain via World (host adopt + rebroadcast).
 */
export class PlayerClaimApplier {
  private forceMirrored = false
  private impulseMirrored = false
  private lastCameraLayerId = ''
  private lastLocomotionKey = ''

  apply(claims: PlayerHostClaims, ctx: ApplyPlayerClaimsContext): void {
    // Always clear any legacy PX locomotion override / layer_drive flags.
    ctx.player?.setPxLocomotionOverride(null)
    ctx.player?.setAllowSceneOwnedMotion(false)
    for (const layer of ctx.layers) {
      try {
        layer.system.setSkipHostReservedPoses(false)
      } catch {
        /* ignore */
      }
    }

    this.applyPrimaryLocomotion(claims.locomotion, ctx)
    this.applyCamera(claims.camera, ctx)
    this.applyForce(claims.force, ctx)
    // movePlayerTo / teleport / emote from PX (and primary-silent channels)
    ctx.drainPrivilegedIntents()
  }

  /** Max impulse Lamport across primary + all registered PX layers. */
  impulseLamportAcross(layers: readonly SceneLayer[], primary: SceneScriptSystem): number {
    let max = primary.getPhysicsImpulseLamport()
    for (const layer of layers) {
      if (layer.kind !== 'pe') continue
      try {
        max = Math.max(max, layer.system.getPhysicsImpulseLamport())
      } catch {
        /* ignore */
      }
    }
    return max
  }

  reset(): void {
    this.forceMirrored = false
    this.impulseMirrored = false
    this.lastCameraLayerId = ''
    this.lastLocomotionKey = ''
  }

  private applyPrimaryLocomotion(
    claim: LocomotionClaim | null,
    ctx: ApplyPlayerClaimsContext
  ): void {
    const key = claim
      ? `${claim.kind}:${claim.layerId}:${claim.freezesAvatar ? 1 : 0}`
      : ''
    if (claim?.kind === 'primary') {
      if (claim.freezesAvatar) ctx.player?.clearMoveKeys()
      if (key !== this.lastLocomotionKey) {
        this.lastLocomotionKey = key
        if (claim.freezesAvatar) {
          console.info('[layers] locomotion freeze → primary InputModifier')
        }
      }
      return
    }
    this.lastLocomotionKey = ''
  }

  private applyCamera(claim: CameraClaim | null, ctx: ApplyPlayerClaimsContext): void {
    if (claim?.bridge && claim.mainCameraBound) {
      ctx.setVirtualCameraBridge(claim.bridge)
      if (claim.layerId !== this.lastCameraLayerId) {
        this.lastCameraLayerId = claim.layerId
        console.info(
          `[layers] camera claim → layer=${claim.layerId.slice(0, 28)} kind=${claim.kind}`
        )
      }
      return
    }
    ctx.setVirtualCameraBridge(ctx.primaryVirtualCameraBridge())
    this.lastCameraLayerId = ''
  }

  private applyForce(claim: ForceClaim | null, ctx: ApplyPlayerClaimsContext): void {
    const primary = ctx.primary.readComponents
    const player = ctx.primary.view.PlayerEntity as Entity

    if (claim?.force && primary.PhysicsCombinedForce && claim.kind !== 'primary') {
      primary.PhysicsCombinedForce.createOrReplace(player, cloneJson(claim.force) as never)
      this.forceMirrored = true
    } else if (this.forceMirrored && primary.PhysicsCombinedForce) {
      if (!claim || claim.kind === 'primary' || !claim.force) {
        primary.PhysicsCombinedForce.deleteFrom(player)
        this.forceMirrored = false
      }
    }

    if (claim?.impulse && primary.PhysicsCombinedImpulse && claim.kind !== 'primary') {
      primary.PhysicsCombinedImpulse.createOrReplace(player, cloneJson(claim.impulse) as never)
      this.impulseMirrored = true
    } else if (this.impulseMirrored && primary.PhysicsCombinedImpulse) {
      if (!claim || claim.kind === 'primary' || !claim.impulse) {
        primary.PhysicsCombinedImpulse.deleteFrom(player)
        this.impulseMirrored = false
      }
    }
  }
}
