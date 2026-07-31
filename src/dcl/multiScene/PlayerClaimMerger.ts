/**
 * Phase B — continuous player claims from scene layers (PX + primary).
 * Secondary never wins locomotion / camera / poseDrive.
 * @see docs/PORTABLE_EXPERIENCE_COD.md · docs/SCENE_LAYERS_PLAN.md
 */
import type { Entity } from '@dcl/ecs'
import type { VirtualCameraBridge } from '../../camera/VirtualCameraBridge'
import type { SceneScriptSystem } from '../../core/systems/SceneScriptSystem'
import type { PlayerSystem } from '../../player/PlayerSystem'
import {
  freezesAvatarFromModifier,
  locomotionConfigFromInputModifier
} from '../../player/locomotion'
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
 * Policy: primary IM present → primary wins locomotion; else PX wins if any.
 */
export function collectPlayerClaims(layers: readonly SceneLayer[]): PlayerHostClaims {
  let primaryLocomotion: LocomotionClaim | null = null
  let pxLocomotion: LocomotionClaim | null = null
  let camera: CameraClaim | null = null
  let poseDrive: PoseDriveClaim | null = null
  let force: ForceClaim | null = null

  for (const layer of layers) {
    if (layer.kind === 'secondary') continue

    try {
      const sys = layer.system
      const playerEnt = sys.view.PlayerEntity as Entity
      const camEnt = sys.view.CameraEntity as Entity
      const { InputModifier, MainCamera, PhysicsCombinedForce, PhysicsCombinedImpulse } =
        sys.readComponents

      if (InputModifier.has(playerEnt)) {
        const mod = InputModifier.get(playerEnt)
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
        } else if (
          !pxLocomotion ||
          (freezes && !pxLocomotion.freezesAvatar) ||
          (freezes === pxLocomotion.freezesAvatar && claim.priority > pxLocomotion.priority)
        ) {
          pxLocomotion = claim
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

  const locomotion = primaryLocomotion ?? pxLocomotion

  // poseDrive (COD free-flight): PX wins locomotion + disableAll-style full freeze
  // (not mode-only sit freeze). Explicit transitional signal until scenes publish poseDrive.
  if (locomotion?.kind === 'pe' && locomotion.freezesAvatar) {
    const cfg = locomotionConfigFromInputModifier(locomotion.inputModifier)
    if (cfg.disableAll) {
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
  }

  return { locomotion, camera, poseDrive, force }
}

export type ApplyPlayerClaimsContext = {
  primary: SceneScriptSystem
  player: PlayerSystem | null
  setVirtualCameraBridge: (bridge: VirtualCameraBridge | null) => void
  primaryVirtualCameraBridge: () => VirtualCameraBridge | null
  drainPrivilegedIntents: () => void
  /** All registered layers — used to clear skipHostReservedPoses on non-drive layers. */
  layers: readonly SceneLayer[]
}

/**
 * Apply merged claims onto host. Does not write PX InputModifier onto primary ECS
 * when primary has no IM (uses PlayerSystem override instead).
 */
export class PlayerClaimApplier {
  private pxOverrideActive = false
  private forceMirrored = false
  private impulseMirrored = false
  private lastCameraLayerId = ''
  private lastPoseDriveId = ''
  private lastLocomotionKey = ''
  private lastPoseMode = ''

  apply(claims: PlayerHostClaims, ctx: ApplyPlayerClaimsContext): void {
    this.applyLocomotion(claims.locomotion, ctx)
    this.applyCamera(claims.camera, ctx)
    this.applyPoseDrive(claims.poseDrive, ctx)
    this.applyForce(claims.force, ctx)
    ctx.drainPrivilegedIntents()
  }

  /** Max impulse Lamport across primary + all registered PE layers. */
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
    this.pxOverrideActive = false
    this.forceMirrored = false
    this.impulseMirrored = false
    this.lastCameraLayerId = ''
    this.lastPoseDriveId = ''
    this.lastLocomotionKey = ''
    this.lastPoseMode = ''
  }

  private applyLocomotion(claim: LocomotionClaim | null, ctx: ApplyPlayerClaimsContext): void {
    const key = claim
      ? `${claim.kind}:${claim.layerId}:${claim.freezesAvatar ? 1 : 0}`
      : ''

    if (claim?.kind === 'primary') {
      if (this.pxOverrideActive) {
        ctx.player?.setPxLocomotionOverride(null)
        this.pxOverrideActive = false
        console.info('[layers] locomotion → primary InputModifier (overrides PX)')
      }
      if (claim.freezesAvatar) ctx.player?.clearMoveKeys()
      this.lastLocomotionKey = key
      return
    }

    if (claim?.kind === 'pe') {
      const config = locomotionConfigFromInputModifier(claim.inputModifier)
      ctx.player?.setPxLocomotionOverride(config)
      if (!this.pxOverrideActive || key !== this.lastLocomotionKey) {
        this.pxOverrideActive = true
        console.info(
          `[layers] locomotion → PX InputModifier layer=${claim.layerId.slice(0, 28)} freeze=${claim.freezesAvatar ? 1 : 0}`
        )
      }
      this.lastLocomotionKey = key
      if (claim.freezesAvatar) ctx.player?.clearMoveKeys()
      return
    }

    if (this.pxOverrideActive) {
      ctx.player?.setPxLocomotionOverride(null)
      this.pxOverrideActive = false
      console.info('[layers] locomotion claim cleared — no primary/PX InputModifier')
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
    // COD layer_drive: only the winning PX layer skips host reserved pose stomp.
    for (const layer of ctx.layers) {
      const skip = drive && claim !== null && layer.id === claim.layerId
      try {
        layer.system.setSkipHostReservedPoses(skip)
      } catch {
        /* ignore */
      }
    }
    const mode = drive ? 'layer_drive' : 'host_feet'
    if (mode !== this.lastPoseMode) {
      this.lastPoseMode = mode
      console.info(`[layers] HostPoseMode → ${mode}`)
    }
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
