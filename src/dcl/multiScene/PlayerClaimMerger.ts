/**
 * Continuous player claims from scene layers (PX + primary).
 *
 * Product law:
 * - Host owns WASD when **not** frozen by a layer.
 * - Primary InputModifier freeze locks host (plaza load gates).
 * - PE InputModifier freeze also locks host (Neurolink drone sit/lock) via pxLocomotionOverride
 *   when PE freezes and primary does not.
 * - Scene-authored moves (movePlayerTo, force/impulse) apply on host then rebroadcast.
 *
 * @see docs/PORTABLE_EXPERIENCE_COD.md
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

export type ForceClaim = {
  layerId: string
  kind: SceneWorkerKind
  priority: number
  force: unknown | null
  impulse: unknown | null
  impulseLamport: number
}

export type PlayerHostClaims = {
  /** Primary IM freeze wins; else PE freeze if any (drone / vehicle lock). */
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
 * Locomotion: primary freeze wins; else PE freeze; else primary IM (if any).
 */
export function collectPlayerClaims(layers: readonly SceneLayer[]): PlayerHostClaims {
  let primaryLocomotion: LocomotionClaim | null = null
  let peFreeze: LocomotionClaim | null = null
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

      // PE freeze (drone / vehicle) — host must lock when PE freezes and primary does not.
      if (layer.kind === 'pe' && InputModifier.has(playerEnt)) {
        const mod = InputModifier.get(playerEnt)
        if (freezesAvatarFromModifier(mod)) {
          if (!peFreeze || layer.priority >= peFreeze.priority) {
            peFreeze = {
              layerId: layer.id,
              kind: layer.kind,
              priority: layer.priority,
              inputModifier: mod,
              freezesAvatar: true,
              primaryHasComponent: false
            }
          }
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

  // Primary freeze wins; else PE freeze (Neurolink drone lock); else primary IM if present.
  const locomotion =
    primaryLocomotion?.freezesAvatar === true
      ? primaryLocomotion
      : peFreeze ?? primaryLocomotion

  return { locomotion, camera, force }
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
 * Locomotion: primary freeze via primary IM; PE freeze via pxLocomotionOverride.
 * PX force/impulse = scene-authored motion on capsule.
 * movePlayerTo intents drain via World (host adopt + rebroadcast).
 */
export class PlayerClaimApplier {
  private forceMirrored = false
  private impulseMirrored = false
  private lastCameraLayerId = ''
  private lastLocomotionKey = ''

  apply(claims: PlayerHostClaims, ctx: ApplyPlayerClaimsContext): void {
    // Default: host injects Player/Camera into every layer.
    // PE free-flight (below) opts that PE out of host stomps so scene can author pilot pose.
    for (const layer of ctx.layers) {
      try {
        layer.system.setSkipHostReservedPoses(false)
      } catch {
        /* ignore */
      }
    }

    this.applyLocomotion(claims.locomotion, ctx)
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

  private applyLocomotion(claim: LocomotionClaim | null, ctx: ApplyPlayerClaimsContext): void {
    const key = claim
      ? `${claim.kind}:${claim.layerId}:${claim.freezesAvatar ? 1 : 0}`
      : ''

    if (!claim) {
      ctx.player?.setPxLocomotionOverride(null)
      ctx.player?.setAllowSceneOwnedMotion(false)
      this.lastLocomotionKey = ''
      return
    }

    if (claim.kind === 'primary') {
      // Host reads primary MirrorComponents InputModifier — no PX override.
      ctx.player?.setPxLocomotionOverride(null)
      ctx.player?.setAllowSceneOwnedMotion(false)
      if (claim.freezesAvatar) ctx.player?.clearMoveKeys()
      if (key !== this.lastLocomotionKey) {
        this.lastLocomotionKey = key
        if (claim.freezesAvatar) {
          console.info('[layers] locomotion freeze → primary InputModifier')
        }
      }
      return
    }

    // PE freeze — primary does not freeze (collectPlayerClaims prefers primary freeze first).
    // Neurolink drone: block host WASD; keys still fan out to PE worker; no foot pin.
    // COD: host still injects feet to all workers after ride (no layer_drive / skip inject).
    // Capsule rides PE MeshColliders via host PhysX ROOT+transfer — same as a scene platform.
    if (claim.freezesAvatar) {
      const config = locomotionConfigFromInputModifier(claim.inputModifier)
      ctx.player?.setPxLocomotionOverride(config)
      ctx.player?.setAllowSceneOwnedMotion(true)
      ctx.player?.clearMoveKeys()
      // Host inject stays ON for all layers (COD rebroadcast host_feet after ride).
      if (key !== this.lastLocomotionKey) {
        this.lastLocomotionKey = key
        console.info(
          `[layers] locomotion freeze → PE free-flight (WASD block, host ride PE solids) layer=${claim.layerId.slice(0, 28)}`
        )
      }
      return
    }

    ctx.player?.setPxLocomotionOverride(null)
    ctx.player?.setAllowSceneOwnedMotion(false)
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
