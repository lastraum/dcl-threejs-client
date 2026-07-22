/**
 * Phase B — continuous player claims from scene layers.
 *
 * InputModifier priority (host policy):
 *   1. Primary has InputModifier component → primary wins (PE ignored for locomotion).
 *   2. Primary has no InputModifier, PE has one → PE wins (applied as PlayerSystem override,
 *      never written onto primary’s component — that caused freeze/clear thrash).
 *
 * @see docs/SCENE_LAYERS_PLAN.md
 */
import type { Entity } from '@dcl/ecs'
import type { SceneScriptSystem } from '../../core/systems/SceneScriptSystem'
import type { PlayerSystem } from '../../player/PlayerSystem'
import type { VirtualCameraBridge } from '../../camera/VirtualCameraBridge'
import {
  freezesAvatarFromModifier,
  locomotionConfigFromInputModifier
} from '../../player/locomotion'
import type { SceneLayer } from './SceneLayerRegistry'
import type { SceneWorkerKind } from './types'

// Re-export for callers that imported freezesAvatarFromModifier from here.
export { freezesAvatarFromModifier } from '../../player/locomotion'

export type LocomotionClaim = {
  layerId: string
  kind: SceneWorkerKind
  priority: number
  inputModifier: unknown
  freezesAvatar: boolean
  /** True when primary layer has InputModifier (component present). */
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

export type PoseDriveClaim = {
  layerId: string
  kind: SceneWorkerKind
  priority: number
  system: SceneScriptSystem
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
  locomotion: LocomotionClaim | null
  camera: CameraClaim | null
  poseDrive: PoseDriveClaim | null
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
 * Secondary never wins locomotion / camera / poseDrive.
 */
export function collectPlayerClaims(layers: readonly SceneLayer[]): PlayerHostClaims {
  let primaryLocomotion: LocomotionClaim | null = null
  let peLocomotion: LocomotionClaim | null = null
  let camera: CameraClaim | null = null
  let poseDrive: PoseDriveClaim | null = null
  let force: ForceClaim | null = null

  for (const layer of layers) {
    if (layer.kind === 'secondary') continue

    try {
      const sys = layer.system
      const pe = sys.view.PlayerEntity as Entity
      const camEnt = sys.view.CameraEntity as Entity
      const { InputModifier, MainCamera, PhysicsCombinedForce, PhysicsCombinedImpulse } =
        sys.readComponents

      // --- locomotion ---
      // Read each layer’s own projection only (primary system = primary scene worker IM;
      // PE system = PE worker IM). Never treat a host-side mirror as primary.
      if (InputModifier.has(pe)) {
        const mod = InputModifier.get(pe)
        const freezes = freezesAvatarFromModifier(mod)
        const claim: LocomotionClaim = {
          layerId: layer.id,
          kind: layer.kind,
          priority: layer.priority,
          inputModifier: mod,
          freezesAvatar: freezes,
          primaryHasComponent: layer.kind === 'primary'
        }
        if (layer.kind === 'primary') {
          primaryLocomotion = claim
        } else {
          // Any PE with IM; prefer freeze, then higher priority among PEs
          if (
            !peLocomotion ||
            (freezes && !peLocomotion.freezesAvatar) ||
            (freezes === peLocomotion.freezesAvatar && claim.priority > peLocomotion.priority)
          ) {
            peLocomotion = claim
          }
        }
      }

      // --- camera ---
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
          mainCameraBound: true
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

      // --- force / impulse ---
      let f: unknown | null = null
      let imp: unknown | null = null
      let lamport = 0
      if (PhysicsCombinedForce?.has(pe)) f = PhysicsCombinedForce.get(pe)
      if (PhysicsCombinedImpulse?.has(pe)) {
        imp = PhysicsCombinedImpulse.get(pe)
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

  // Policy: primary IM component present → primary wins; else PE wins if any.
  const locomotion = primaryLocomotion ?? peLocomotion

  // poseDrive only when PE actually wins locomotion and freezes (free-flight).
  if (locomotion?.kind === 'pe' && locomotion.freezesAvatar) {
    for (const layer of layers) {
      if (layer.id !== locomotion.layerId) continue
      poseDrive = {
        layerId: layer.id,
        kind: 'pe',
        priority: layer.priority,
        system: layer.system
      }
      break
    }
  }

  return { locomotion, camera, poseDrive, force }
}

export type ApplyPlayerClaimsContext = {
  primary: SceneScriptSystem
  player: PlayerSystem | null
  setVirtualCameraBridge: (bridge: VirtualCameraBridge | null) => void
  primaryVirtualCameraBridge: () => VirtualCameraBridge | null
}

/**
 * Apply merged claims onto host (PlayerSystem override / VC / forces).
 * Does **not** write PE InputModifier onto primary’s ECS component.
 */
export class PlayerClaimApplier {
  private peOverrideActive = false
  private forceMirrored = false
  private impulseMirrored = false
  private lastCameraLayerId = ''
  private lastPoseDriveId = ''
  private lastLocomotionKey = ''

  apply(claims: PlayerHostClaims, ctx: ApplyPlayerClaimsContext): void {
    this.applyLocomotion(claims.locomotion, ctx)
    this.applyCamera(claims.camera, ctx)
    this.applyPoseDrive(claims.poseDrive, ctx)
    this.applyForce(claims.force, ctx)
  }

  reset(): void {
    this.peOverrideActive = false
    this.forceMirrored = false
    this.impulseMirrored = false
    this.lastCameraLayerId = ''
    this.lastPoseDriveId = ''
    this.lastLocomotionKey = ''
  }

  private applyLocomotion(claim: LocomotionClaim | null, ctx: ApplyPlayerClaimsContext): void {
    const key = claim
      ? `${claim.kind}:${claim.layerId}:${claim.freezesAvatar ? 1 : 0}`
      : ''

    // Primary has InputModifier → use primary ECS only; clear any PE override.
    if (claim?.kind === 'primary') {
      if (this.peOverrideActive) {
        ctx.player?.setPeLocomotionOverride(null)
        this.peOverrideActive = false
        console.info('[layers] locomotion → primary InputModifier (overrides PE)')
      }
      if (claim.freezesAvatar) ctx.player?.clearMoveKeys()
      this.lastLocomotionKey = key
      // Primary native IM — no retain-mirror needed on primary projection.
      return
    }

    // PE wins only when primary has no InputModifier component.
    if (claim?.kind === 'pe') {
      const config = locomotionConfigFromInputModifier(claim.inputModifier)
      ctx.player?.setPeLocomotionOverride(config)
      if (!this.peOverrideActive || key !== this.lastLocomotionKey) {
        this.peOverrideActive = true
        console.info(
          `[layers] locomotion → PE InputModifier layer=${claim.layerId.slice(0, 28)} freeze=${claim.freezesAvatar ? 1 : 0}`
        )
      }
      this.lastLocomotionKey = key
      if (claim.freezesAvatar) ctx.player?.clearMoveKeys()
      return
    }

    // No IM on primary or PE.
    if (this.peOverrideActive) {
      ctx.player?.setPeLocomotionOverride(null)
      this.peOverrideActive = false
      console.info('[layers] locomotion claim cleared — no primary/PE InputModifier')
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

  private applyPoseDrive(claim: PoseDriveClaim | null, ctx: ApplyPlayerClaimsContext): void {
    const drive = claim?.kind === 'pe'
    ctx.player?.setAllowSceneOwnedMotion(!!drive)
    if (drive && claim && claim.layerId !== this.lastPoseDriveId) {
      this.lastPoseDriveId = claim.layerId
      console.info(`[layers] poseDrive → layer=${claim.layerId.slice(0, 28)}`)
    } else if (!drive) {
      this.lastPoseDriveId = ''
    }
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
