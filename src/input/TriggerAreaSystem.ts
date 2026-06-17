import type { Entity } from '@dcl/ecs'
import * as THREE from 'three'
import type { PBTriggerArea } from '@dcl/ecs/dist/components/generated/pb/decentraland/sdk/components/trigger_area.gen'
import type { ProjectionView } from '../bridge/ProjectionView'
import type { MirrorComponents } from '../bridge/mirrorComponents'
import { ColliderLayer } from '../collision/ColliderLayer'
import { clientDebugLog } from '../client/debug/ClientDebugLog'
import type { PhysXWorld, TriggerVolumeDesc } from '../physics/PhysXWorld'
import {
  isTriggerAreaParityMode,
  isTriggerAreaVerbose,
  resolveTriggerAreaBackend,
  type TriggerAreaBackend
} from './triggerAreaConfig'
import {
  appendTriggerAreaResult,
  buildTriggerAreaResult,
  LOCAL_PLAYER_LAYERS,
  TAET_ENTER,
  TAET_EXIT
} from './triggerAreaEmit'
import {
  composeTriggerWorldMatrixDcl,
  isPlayerInsideTriggerDcl,
  TRIGGER_MESH_SPHERE
} from './triggerAreaMath'

type TriggerDeps = {
  ecs: MirrorComponents
  view: ProjectionView
  getEntityNodes: () => Map<Entity, THREE.Group>
  getPlayerWorldPosition: () => THREE.Vector3 | null
  getPhysics?: () => PhysXWorld | null
  recordAppend?: (componentId: number, entity: Entity, value: unknown) => void
}

type TriggerVolume = {
  entity: Entity
  mesh: number
  collisionMask: number
}

/** Default when `collisionMask` omitted — matches SDK docs (`ColliderLayer.CL_PLAYER`). */
const DEFAULT_TRIGGER_MASK = ColliderLayer.CL_PLAYER

/**
 * Renderer-side TriggerArea enter/exit detection — appends grow-only TriggerAreaResult
 * for the scene worker `triggerAreaEventsSystem` (onTriggerEnter / onTriggerExit).
 *
 * Tier A (default): analytic point-in-volume via Three.js matrixWorld.
 * Tier B (`?triggerPhysx`): PhysX trigger actors + player capsule overlap query.
 * Parity (`?triggerParity`): run both backends, log set mismatches (math remains authoritative).
 */
export class TriggerAreaSystem {
  private deps: TriggerDeps | null = null
  private volumes: TriggerVolume[] = []
  private cacheDirty = true
  private physxVolumesDirty = true
  /** trigger entity → whether local player is inside (active backend state). */
  private readonly insideLocalPlayer = new Set<Entity>()
  private timestamp = 1
  private readonly backend: TriggerAreaBackend = resolveTriggerAreaBackend()
  private readonly parityMode = isTriggerAreaParityMode()
  private readonly verbose = isTriggerAreaVerbose()
  private readonly _worldMatrix = new THREE.Matrix4()
  private readonly _insideMath = new Set<Entity>()
  private readonly _insidePhysx = new Set<Entity>()
  private backendLogged = false
  private lastVerboseProbeAt = 0

  bind(deps: TriggerDeps): void {
    this.deps = deps
    this.invalidateCache()
    if (!this.backendLogged) {
      this.backendLogged = true
      const label =
        this.backend === 'physx'
          ? `physx${this.parityMode ? ' + parity' : ''}`
          : `math${this.parityMode ? ' + parity' : ''}`
      clientDebugLog.log('input', `TriggerArea backend: ${label}`, { level: 'info' })
    }
  }

  dispose(): void {
    this.deps?.getPhysics?.()?.syncTriggerVolumes([])
    this.deps = null
    this.volumes.length = 0
    this.insideLocalPlayer.clear()
    this._insideMath.clear()
    this._insidePhysx.clear()
  }

  invalidateCache(): void {
    this.cacheDirty = true
    this.physxVolumesDirty = true
  }

  private rebuildCacheIfNeeded(): void {
    if (!this.cacheDirty || !this.deps) return
    this.cacheDirty = false
    this.physxVolumesDirty = true
    this.volumes.length = 0
    const { ecs, view } = this.deps
    for (const [entity, spec] of view.getEntitiesWith(ecs.TriggerArea)) {
      if (
        entity === view.RootEntity ||
        entity === view.PlayerEntity ||
        entity === view.CameraEntity
      ) {
        continue
      }
      const area = spec as PBTriggerArea
      const mesh = area.mesh === TRIGGER_MESH_SPHERE ? TRIGGER_MESH_SPHERE : 0
      this.volumes.push({
        entity,
        mesh,
        collisionMask: area.collisionMask ?? DEFAULT_TRIGGER_MASK
      })
    }
  }

  private syncPhysxVolumesIfNeeded(nodes: Map<Entity, THREE.Group>): PhysXWorld | null {
    const physics = this.deps?.getPhysics?.() ?? null
    if (!physics || (!this.physxVolumesDirty && this.backend !== 'physx' && !this.parityMode)) {
      return physics
    }
    if (!this.physxVolumesDirty) return physics

    this.physxVolumesDirty = false
    const descs: TriggerVolumeDesc[] = []
    for (const vol of this.volumes) {
      if ((vol.collisionMask & LOCAL_PLAYER_LAYERS) === 0) continue
      const node = nodes.get(vol.entity)
      if (!node) continue
      node.updateWorldMatrix(true, false)
      descs.push({
        entity: vol.entity,
        mesh: vol.mesh,
        matrix: this._worldMatrix.copy(node.matrixWorld)
      })
    }
    physics.syncTriggerVolumes(descs)
    return physics
  }

  private collectMathInside(
    playerTransform: {
      position: { x: number; y: number; z: number }
      rotation: { x: number; y: number; z: number; w: number }
      scale: { x: number; y: number; z: number }
    },
    nodes: Map<Entity, THREE.Group>,
    out: Set<Entity>
  ): void {
    if (!this.deps) return
    const { ecs, view } = this.deps
    out.clear()
    for (const vol of this.volumes) {
      if ((vol.collisionMask & LOCAL_PLAYER_LAYERS) === 0) continue
      if (!composeTriggerWorldMatrixDcl(vol.entity, ecs.Transform, view, this._worldMatrix)) {
        continue
      }
      if (isPlayerInsideTriggerDcl(playerTransform, this._worldMatrix, vol.mesh)) {
        out.add(vol.entity)
      }
    }
    this.logVerboseProbe(playerTransform, nodes, out)
  }

  private logVerboseProbe(
    playerTransform: {
      position: { x: number; y: number; z: number }
    },
    nodes: Map<Entity, THREE.Group>,
    inside: Set<Entity>
  ): void {
    if (!this.verbose || !this.deps) return
    const now = performance.now()
    if (now - this.lastVerboseProbeAt < 3_000) return
    this.lastVerboseProbeAt = now
    const { ecs, view } = this.deps
    const p = playerTransform.position
    const parts: string[] = []
    for (const vol of this.volumes) {
      const t = ecs.Transform.getOrNull(vol.entity)
      const pos = t?.position
      const hasNode = nodes.has(vol.entity)
      const hasMatrix = composeTriggerWorldMatrixDcl(vol.entity, ecs.Transform, view, this._worldMatrix)
      parts.push(
        `e${vol.entity} mask=${vol.collisionMask} ` +
          `@${pos ? `${pos.x.toFixed(1)},${pos.y.toFixed(1)},${pos.z.toFixed(1)}` : 'no-t'} ` +
          `node=${hasNode} matrix=${hasMatrix} inside=${inside.has(vol.entity)}`
      )
    }
    clientDebugLog.log(
      'input',
      `TriggerArea probe — player ${p.x.toFixed(1)},${p.y.toFixed(1)},${p.z.toFixed(1)} · ${parts.join(' · ')}`,
      { level: 'info', alsoConsole: true }
    )
  }

  private collectPhysxInside(physics: PhysXWorld, out: Set<Entity>): void {
    physics.queryTriggerVolumesOverlappingPlayer(out)
    if (out.size === 0) return
    const masked = [...out]
    out.clear()
    for (const entity of masked) {
      const vol = this.volumes.find((v) => v.entity === entity)
      if (vol && (vol.collisionMask & LOCAL_PLAYER_LAYERS) !== 0) {
        out.add(entity)
      }
    }
  }

  private logParityMismatch(mathInside: Set<Entity>, physxInside: Set<Entity>): void {
    const onlyMath: number[] = []
    const onlyPhysx: number[] = []
    for (const entity of mathInside) {
      if (!physxInside.has(entity)) onlyMath.push(entity)
    }
    for (const entity of physxInside) {
      if (!mathInside.has(entity)) onlyPhysx.push(entity)
    }
    if (onlyMath.length === 0 && onlyPhysx.length === 0) return
    clientDebugLog.log(
      'input',
      `TriggerArea parity mismatch — math-only [${onlyMath.join(', ')}] physx-only [${onlyPhysx.join(', ')}]`,
      { level: 'warn' }
    )
  }

  private applyTransitions(inside: Set<Entity>): void {
    if (!this.deps) return
    const { ecs, view } = this.deps
    const playerEntity = view.PlayerEntity
    const playerTransform = ecs.Transform.getOrNull(playerEntity)
    if (!playerTransform) return

    for (const entity of inside) {
      if (!this.insideLocalPlayer.has(entity)) {
        this.insideLocalPlayer.add(entity)
        this.emitResult(entity, playerEntity, playerTransform, TAET_ENTER)
      }
    }
    for (const entity of [...this.insideLocalPlayer]) {
      if (!inside.has(entity)) {
        this.insideLocalPlayer.delete(entity)
        this.emitResult(entity, playerEntity, playerTransform, TAET_EXIT)
      }
    }
  }

  /** Run each frame (and on CRDT round-trips) before encoder flush. */
  sync(): void {
    if (!this.deps) return
    this.rebuildCacheIfNeeded()
    if (!this.volumes.length) return

    const { ecs, view } = this.deps
    const playerTransform = ecs.Transform.getOrNull(view.PlayerEntity)
    if (!playerTransform) {
      if (this.verbose) {
        clientDebugLog.log('input', 'TriggerArea sync — PlayerEntity Transform missing', {
          level: 'warn',
          alsoConsole: true
        })
      }
      return
    }

    const nodes = this.deps.getEntityNodes()
    const usePhysx = this.backend === 'physx' || this.parityMode
    const physics = usePhysx ? this.syncPhysxVolumesIfNeeded(nodes) : null

    this.collectMathInside(playerTransform, nodes, this._insideMath)

    let activeInside = this._insideMath
    if (this.backend === 'physx') {
      if (physics?.playerController) {
        this.collectPhysxInside(physics, this._insidePhysx)
        activeInside = this._insidePhysx
      } else {
        activeInside = this._insideMath
      }
    }

    if (this.parityMode && physics?.playerController) {
      this.collectPhysxInside(physics, this._insidePhysx)
      this.logParityMismatch(this._insideMath, this._insidePhysx)
    }

    this.applyTransitions(activeInside)
  }

  private emitResult(
    triggerEntity: Entity,
    playerEntity: Entity,
    playerTransform: {
      position: { x: number; y: number; z: number }
      rotation: { x: number; y: number; z: number; w: number }
      scale: { x: number; y: number; z: number }
    },
    eventType: number
  ): void {
    if (!this.deps) return
    const areaTransform = this.deps.ecs.Transform.getOrNull(triggerEntity)
    const result = buildTriggerAreaResult(
      triggerEntity,
      playerEntity,
      playerTransform,
      areaTransform,
      eventType,
      this.timestamp++
    )
    appendTriggerAreaResult(this.deps.ecs, triggerEntity, result, this.deps.recordAppend)
    if (this.verbose) {
      const label = eventType === TAET_ENTER ? 'enter' : 'exit'
      clientDebugLog.log(
        'input',
        `TriggerArea ${label} — entity ${triggerEntity} player ${playerEntity}`,
        { level: 'info', alsoConsole: true }
      )
    }
  }
}