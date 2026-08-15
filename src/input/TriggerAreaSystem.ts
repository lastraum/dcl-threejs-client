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
  composeTriggerWorldMatrix,
  composeTriggerWorldMatrixDcl,
  isPlayerInsideTriggerDcl,
  TRIGGER_MESH_SPHERE
} from './triggerAreaMath'
import type { EntityWorldTransformDeps } from '../transform/entityWorldTransform'

type TriggerDeps = {
  ecs: MirrorComponents
  view: ProjectionView
  getEntityNodes: () => Map<Entity, THREE.Group>
  getWorldTransformDeps: () => EntityWorldTransformDeps | null
  getPlayerWorldPosition: () => THREE.Vector3 | null
  getPhysics?: () => PhysXWorld | null
  recordAppend?: (componentId: number, entity: Entity, value: unknown) => void
  /** Host VFX — local player entered a scene-authored TriggerArea. */
  onTriggerEnter?: (entity: Entity) => void
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
 * Default (**math**): analytic **player CCT capsule** vs box/sphere volumes (Explorer overlap —
 * one capsule, the same dimensions as the character controller; no second body).
 * Optional (`?triggerPhysx`): PhysX `scene.overlap` with a query geometry matching the CCT
 * (CCT actor shapes are simulation-only and cannot be used as scene-query volumes).
 */
export class TriggerAreaSystem {
  private deps: TriggerDeps | null = null
  private volumes: TriggerVolume[] = []
  private cacheDirty = true
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
  private lastFeetDiagAt = 0
  private readonly _feetDcl = { x: 0, y: 0, z: 0 }

  bind(deps: TriggerDeps): void {
    this.deps = deps
    this.invalidateCache()
    if (!this.backendLogged) {
      this.backendLogged = true
      const label =
        this.backend === 'physx'
          ? `physx-query${this.parityMode ? ' + parity' : ''}`
          : `cct-capsule${this.parityMode ? ' + parity' : ''}`
      clientDebugLog.log('input', `TriggerArea backend: ${label}`, {
        level: 'info'
      })
      clientDebugLog.consoleOnly(
        'info',
        `[input] TriggerArea backend: ${label} (Explorer = avatar/CCT volume overlap, one capsule)`
      )
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
  }

  private rebuildCacheIfNeeded(): void {
    if (!this.cacheDirty || !this.deps) return
    this.cacheDirty = false
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
      // setBox() omits collisionMask; some CRDT paths materialize 0 — treat as default CL_PLAYER.
      const rawMask = area.collisionMask
      const collisionMask =
        rawMask == null || rawMask === 0 ? DEFAULT_TRIGGER_MASK : rawMask
      this.volumes.push({
        entity,
        mesh,
        collisionMask
      })
    }
    const msg =
      `TriggerArea cache — ${this.volumes.length} volume(s)` +
      (this.volumes.length
        ? ` mesh=${this.volumes.filter((v) => v.mesh === TRIGGER_MESH_SPHERE).length}sphere/` +
          `${this.volumes.filter((v) => v.mesh !== TRIGGER_MESH_SPHERE).length}box`
        : '')
    clientDebugLog.log('input', msg, { level: 'info', throttleMs: 5000 })
  }

  /**
   * Keep PhysX trigger actors aligned with live poses (Three display space — same as CCT).
   * Prefer CRDT world matrix (space: three); fall back to scene-graph node.
   * Re-run every frame so parent motion / late Transform puts cannot leave stale volumes.
   */
  private syncPhysxVolumesIfNeeded(nodes: Map<Entity, THREE.Group>): PhysXWorld | null {
    const physics = this.deps?.getPhysics?.() ?? null
    if (!physics) return null
    if (this.backend !== 'physx' && !this.parityMode) return physics

    const worldDeps = this.deps?.getWorldTransformDeps() ?? null
    const descs: TriggerVolumeDesc[] = []
    for (const vol of this.volumes) {
      if ((vol.collisionMask & LOCAL_PLAYER_LAYERS) === 0) continue

      let matrix: THREE.Matrix4 | null = null
      if (worldDeps && composeTriggerWorldMatrix(vol.entity, worldDeps, this._worldMatrix)) {
        matrix = this._worldMatrix
      } else {
        const node = nodes.get(vol.entity)
        if (!node) continue
        node.updateWorldMatrix(true, false)
        matrix = this._worldMatrix.copy(node.matrixWorld)
      }

      descs.push({
        entity: vol.entity,
        mesh: vol.mesh,
        matrix: matrix.clone()
      })
    }
    physics.syncTriggerVolumes(descs)
    return physics
  }

  /**
   * CCT feet in DCL scene space — authoritative for volume tests.
   * PE Transform is also feet; physics root is capsule feet (Three display → DCL).
   */
  private sampleFeetDcl(): { x: number; y: number; z: number } | null {
    const feetThree = this.deps?.getPlayerWorldPosition() ?? null
    if (!feetThree || !Number.isFinite(feetThree.x)) return null
    // Display → DCL: negate X (same as threeToDclPos).
    this._feetDcl.x = -feetThree.x
    this._feetDcl.y = feetThree.y
    this._feetDcl.z = feetThree.z
    return this._feetDcl
  }

  /**
   * Overlap test — same world pose as every other entity:
   * ECS Transform parent chain in DCL space ({@link composeTriggerWorldMatrixDcl}) × CCT feet.
   * Hierarchy correctness lives in applySceneDiff (ancestor expansion), not here.
   */
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
    const worldDeps = this.deps.getWorldTransformDeps()
    if (!worldDeps) {
      if (this.verbose) {
        clientDebugLog.log('input', 'TriggerArea math skipped — world transform deps null', {
          level: 'warn',
          alsoConsole: true
        })
      }
      return
    }
    const feetDcl = this.sampleFeetDcl()
    out.clear()
    const feet = feetDcl
    const KEEP_M2 = 48 * 48
    for (const vol of this.volumes) {
      if ((vol.collisionMask & LOCAL_PLAYER_LAYERS) === 0) continue
      if (!composeTriggerWorldMatrixDcl(vol.entity, worldDeps, this._worldMatrix)) {
        continue
      }
      if (feet) {
        const e = this._worldMatrix.elements
        const dx = e[12]! - feet.x
        const dy = e[13]! - feet.y
        const dz = e[14]! - feet.z
        if (dx * dx + dy * dy + dz * dz > KEEP_M2) continue
      }
      if (isPlayerInsideTriggerDcl(playerTransform, this._worldMatrix, vol.mesh, undefined, feetDcl)) {
        out.add(vol.entity)
      }
    }
    this.logVerboseProbe(playerTransform, nodes, out, feetDcl)
  }

  /** Throttled: PE / CCT feet vs nearest volume (ECS world matrix). */
  private logFeetDiag(
    playerTransform: { position: { x: number; y: number; z: number } },
    feetDcl: { x: number; y: number; z: number } | null,
    insideCount: number
  ): void {
    const now = performance.now()
    if (now - this.lastFeetDiagAt < 2_500) return
    this.lastFeetDiagAt = now
    const pe = playerTransform.position
    const fx = feetDcl?.x ?? pe.x
    const fy = feetDcl?.y ?? pe.y
    const fz = feetDcl?.z ?? pe.z
    let nearest = 'none'
    let nearestD = Number.POSITIVE_INFINITY
    let skippedMatrix = 0
    let nearHits = 0
    const worldDeps = this.deps?.getWorldTransformDeps()
    if (worldDeps) {
      for (const vol of this.volumes) {
        if (!composeTriggerWorldMatrixDcl(vol.entity, worldDeps, this._worldMatrix)) {
          skippedMatrix++
          continue
        }
        const e = this._worldMatrix.elements
        const cx = e[12]!
        const cy = e[13]!
        const cz = e[14]!
        const d = Math.hypot(fx - cx, fy - cy, fz - cz)
        const t = this.deps?.ecs.Transform.getOrNull(vol.entity)
        const parent = t?.parent ?? 0
        if (d < nearestD) {
          nearestD = d
          nearest =
            `e${vol.entity} d=${d.toFixed(1)} @(${cx.toFixed(0)},${cy.toFixed(1)},${cz.toFixed(0)}) ` +
            `mesh=${vol.mesh} parent=${parent}`
        }
        if (d < 12) nearHits++
      }
    }
    const msg =
      `TriggerArea cct — pe=(${pe.x.toFixed(1)},${pe.y.toFixed(2)},${pe.z.toFixed(1)}) ` +
      `feet=(${fx.toFixed(1)},${fy.toFixed(2)},${fz.toFixed(1)}) ` +
      `vols=${this.volumes.length} inside=${insideCount} skipMat=${skippedMatrix} ` +
      `near12m=${nearHits} nearest=${nearest}`
    if (this.verbose) {
      clientDebugLog.log('input', msg, { level: 'info', throttleMs: 2500 })
    }
  }

  private logVerboseProbe(
    playerTransform: {
      position: { x: number; y: number; z: number }
    },
    nodes: Map<Entity, THREE.Group>,
    inside: Set<Entity>,
    feetDcl: { x: number; y: number; z: number } | null
  ): void {
    if (!this.verbose || !this.deps) return
    const worldDeps = this.deps.getWorldTransformDeps()
    if (!worldDeps) return
    const now = performance.now()
    if (now - this.lastVerboseProbeAt < 3_000) return
    this.lastVerboseProbeAt = now
    const { ecs } = this.deps
    const p = playerTransform.position
    const f = feetDcl
    const parts: string[] = []
    for (const vol of this.volumes) {
      const t = ecs.Transform.getOrNull(vol.entity)
      const pos = t?.position
      const hasNode = nodes.has(vol.entity)
      const hasMatrix = composeTriggerWorldMatrixDcl(vol.entity, worldDeps, this._worldMatrix)
      parts.push(
        `e${vol.entity} mask=${vol.collisionMask} mesh=${vol.mesh} ` +
          `@${pos ? `${pos.x.toFixed(1)},${pos.y.toFixed(1)},${pos.z.toFixed(1)}` : 'no-t'} ` +
          `node=${hasNode} matrix=${hasMatrix} inside=${inside.has(vol.entity)}`
      )
    }
    clientDebugLog.log(
      'input',
      `TriggerArea probe — pe ${p.x.toFixed(1)},${p.y.toFixed(1)},${p.z.toFixed(1)} ` +
        `feet ${f ? `${f.x.toFixed(1)},${f.y.toFixed(1)},${f.z.toFixed(1)}` : 'n/a'} · ${parts.join(' · ')}`,
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
      clientDebugLog.log('input', 'TriggerArea sync — PlayerEntity Transform missing', {
        level: 'warn',
        alsoConsole: true,
        throttleMs: 3_000,
        throttleKey: 'trigger-no-pe'
      })
      return
    }

    const nodes = this.deps.getEntityNodes()
    // Always analytic CCT capsule (one body) — Explorer overlap semantics.
    this.collectMathInside(playerTransform, nodes, this._insideMath)

    let activeInside = this._insideMath
    if (this.backend === 'physx' || this.parityMode) {
      const physics = this.syncPhysxVolumesIfNeeded(nodes)
      if (physics?.playerController) {
        this.collectPhysxInside(physics, this._insidePhysx)
        if (this.backend === 'physx') {
          // Union: either path counts as inside (robust if query filter flakes).
          for (const e of this._insideMath) this._insidePhysx.add(e)
          activeInside = this._insidePhysx
        }
        if (this.parityMode) {
          this.logParityMismatch(this._insideMath, this._insidePhysx)
        }
      }
    }

    const feetDcl = this.sampleFeetDcl()
    this.logFeetDiag(playerTransform, feetDcl, activeInside.size)
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
    if (eventType === TAET_ENTER) this.deps.onTriggerEnter?.(triggerEntity)
    const label = eventType === TAET_ENTER ? 'enter' : 'exit'
    const areaPos = areaTransform?.position
    // Always console — pad/trampoline debugging; enter/exit are infrequent.
    clientDebugLog.log(
      'input',
      `TriggerArea ${label} — entity ${triggerEntity}` +
        (areaPos
          ? ` @(${areaPos.x.toFixed(1)},${areaPos.y.toFixed(1)},${areaPos.z.toFixed(1)})`
          : '') +
        ` player=${playerEntity}` +
        ` pe=(${playerTransform.position.x.toFixed(1)},${playerTransform.position.y.toFixed(1)},${playerTransform.position.z.toFixed(1)})`,
      { level: 'info', alsoConsole: true }
    )
  }
}