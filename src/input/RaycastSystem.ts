import type { Entity } from '@dcl/ecs'
import * as THREE from 'three'
import type { PBRaycast } from '@dcl/ecs/dist/components/generated/pb/decentraland/sdk/components/raycast.gen'
import type { RaycastHit } from '@dcl/ecs/dist/components/generated/pb/decentraland/sdk/components/common/raycast_hit.gen'
import type { ProjectionView } from '../bridge/ProjectionView'
import type { MirrorComponents } from '../bridge/mirrorComponents'
import type { CollisionSystem, ColliderHit } from '../collision/CollisionSystem'
import { ColliderLayer, resolveCollisionMask } from '../collision/ColliderLayer'
import {
  collectGltfLayerTargetMeshes,
  gltfEntityDrawRoot,
  gltfInvisibleMeshLayerEnabled,
  gltfVisibleMeshLayerEnabled
} from '../collision/gltfPointerMeshes'
import { clientDebugLog } from '../client/debug/ClientDebugLog'
import { buildRaycastResult, hitFromCollider, putRaycastResult } from './raycastEmit'
import { buildSceneRay, raycastRequestKey, type SceneRay } from './raycastMath'
import { isRaycastVerbose } from './raycastConfig'
import type { EntityWorldTransformDeps } from '../transform/entityWorldTransform'

type RaycastDeps = {
  ecs: MirrorComponents
  view: ProjectionView
  collision: CollisionSystem
  getEntityNodes: () => Map<Entity, THREE.Group>
  getWorldTransformDeps: () => EntityWorldTransformDeps | null
  recordLww?: (componentId: number, entity: Entity, value: unknown) => void
  /** GPU InstancedMesh leaves for Gltf/MeshRenderer (pointer already has this path). */
  getInstanceMeshesFor?: (entities: Iterable<Entity>) => THREE.Object3D[]
  resolveInstanceEntity?: (mesh: THREE.Object3D, instanceId: number) => Entity | null
}

const _ray = new THREE.Ray()

/** Matches `RaycastQueryType` — numeric literals avoid const-enum isolatedModules issues. */
const RQT_QUERY_ALL = 1
const RQT_NONE = 2

/**
 * Renderer-side scene `Raycast` execution — writes LWW `RaycastResult` for the worker
 * `raycastSystem` callbacks (`registerLocalDirectionRaycast`, etc.).
 */
export class RaycastSystem {
  private deps: RaycastDeps | null = null
  private readonly verbose = isRaycastVerbose()
  private readonly raycaster = new THREE.Raycaster()
  /** One-shot requests already answered (keyed by entity → last request signature). */
  private readonly handledOneShot = new Map<Entity, string>()
  /** Last delivered continuous result (excludes tickNumber) — skip identical LWW PUTs. */
  private readonly lastContinuousSig = new Map<Entity, string>()

  bind(deps: RaycastDeps): void {
    this.deps = deps
    if (this.verbose) {
      clientDebugLog.log('input', 'Raycast backend: CollisionSystem', { level: 'info' })
    }
  }

  dispose(): void {
    this.deps = null
    this.handledOneShot.clear()
    this.lastContinuousSig.clear()
  }

  /** Run once per guest tick before encoder flush / worker deliver. */
  sync(tickNumber: number): void {
    if (!this.deps) return
    const { ecs, view, collision } = this.deps
    const worldDeps = this.deps.getWorldTransformDeps()
    if (!worldDeps) return

    for (const [entity, spec] of view.getEntitiesWith(ecs.Raycast)) {
      const raycast = spec as PBRaycast
      const continuous = raycast.continuous === true
      const requestKey = raycastRequestKey(raycast)

      if (!continuous && this.handledOneShot.get(entity) === requestKey) {
        continue
      }

      const ray = buildSceneRay(entity, raycast, worldDeps)
      let hits: RaycastHit[] = []
      if (raycast.queryType !== RQT_NONE && ray) {
        hits = this.castRay(collision, ray, raycast)
      }

      const result = buildRaycastResult(raycast, ray ?? emptyRay(), hits, tickNumber)
      // Continuous raycasts rewrite tickNumber every frame. Delivering that LWW
      // every frame requests a plaza eng.update (~100ms) and starves pointer edges.
      // Explorer only notifies when the query payload changes; tickNumber stays local.
      const sig = continuousResultSignature(result)
      const unchanged = continuous && this.lastContinuousSig.get(entity) === sig
      putRaycastResult(ecs, entity, result, unchanged ? undefined : this.deps.recordLww)
      if (continuous) this.lastContinuousSig.set(entity, sig)

      if (!continuous) {
        this.handledOneShot.set(entity, requestKey)
        this.lastContinuousSig.delete(entity)
      }

      if (this.verbose) {
        const hitLabel =
          hits.length === 0
            ? 'miss'
            : hits.map((h) => `e${h.entityId ?? '?'}@${h.length.toFixed(2)}m`).join(', ')
        clientDebugLog.log(
          'input',
          `Raycast e${entity} — ${hitLabel} (continuous=${continuous})`,
          { level: 'info', alsoConsole: true }
        )
      }
    }

    for (const entity of [...this.handledOneShot.keys()]) {
      if (!ecs.Raycast.has(entity)) {
        this.handledOneShot.delete(entity)
      }
    }
    for (const entity of [...this.lastContinuousSig.keys()]) {
      if (!ecs.Raycast.has(entity)) this.lastContinuousSig.delete(entity)
    }
  }

  private castRay(collision: CollisionSystem, ray: SceneRay, raycast: PBRaycast): RaycastHit[] {
    const maxDistance = Math.max(0, raycast.maxDistance ?? 16)
    const mask = resolveCollisionMask(raycast.collisionMask ?? ColliderLayer.CL_PHYSICS)

    _ray.origin.copy(ray.originThree)
    _ray.direction.copy(ray.directionThree)

    const raw = this.mergeHits(
      this.mergeHits(collision.raycast(_ray, mask), this.castGltfLayers(_ray, mask)),
      this.castInstanceLayers(_ray, mask)
    )
    const within = raw.filter((h) => h.distance <= maxDistance + 1e-4)
    if (!within.length) return []

    if (raycast.queryType === RQT_QUERY_ALL) {
      return within.map((h) =>
        hitFromCollider(h.entity, h.point, h.normal, h.distance, ray, h.meshName)
      )
    }

    const first = within[0]
    return [hitFromCollider(first.entity, first.point, first.normal, first.distance, ray, first.meshName)]
  }

  /**
   * Query Gltf visible/invisible hulls by the requested layer mask.
   * Explorer PhysX filter-shader equivalent — CUSTOM* is query-only (not a walk surface).
   */
  private castGltfLayers(ray: THREE.Ray, layerMask: number): ColliderHit[] {
    const deps = this.deps
    if (!deps) return []
    const { ecs, view } = deps
    const nodes = deps.getEntityNodes()
    const targets: THREE.Object3D[] = []

    for (const [entity] of view.getEntitiesWith(ecs.GltfContainer)) {
      const gltfData = ecs.GltfContainer.get(entity)
      if (
        !gltfVisibleMeshLayerEnabled(gltfData, layerMask) &&
        !gltfInvisibleMeshLayerEnabled(gltfData, layerMask)
      ) {
        continue
      }
      const root = gltfEntityDrawRoot(nodes.get(entity), entity)
      if (!root) continue
      collectGltfLayerTargetMeshes(root, gltfData, entity, layerMask, targets)
    }
    if (!targets.length) return []

    const visibilityRestore: { obj: THREE.Object3D; visible: boolean }[] = []
    for (const obj of targets) {
      if (obj.visible === false) {
        visibilityRestore.push({ obj, visible: false })
        obj.visible = true
      }
      let p: THREE.Object3D | null = obj.parent
      while (p) {
        if (p.visible === false) {
          visibilityRestore.push({ obj: p, visible: false })
          p.visible = true
        }
        p = p.parent
      }
    }

    try {
      this.raycaster.layers.set(0)
      this.raycaster.set(ray.origin, ray.direction)
      const hits = this.raycaster.intersectObjects(targets, false)
      const out: ColliderHit[] = []
      for (const hit of hits) {
        const entity = hit.object.userData.entity as Entity | undefined
        if (entity === undefined) continue
        out.push({
          entity,
          point: hit.point.clone(),
          distance: hit.distance,
          normal: (hit.face?.normal ?? new THREE.Vector3(0, 1, 0)).clone(),
          meshName: hit.object.name || undefined
        })
      }
      return out
    } finally {
      for (const { obj, visible } of visibilityRestore) obj.visible = visible
    }
  }

  /**
   * GPU InstancedMesh path — clones expose `__mesh_*` leaves; instances only have a
   * marker Group. Pointer already raycasts these; scene Raycast (plaza aim CL_CUSTOM8)
   * must too or water_surface hits never reach registerLocalDirectionRaycast.
   */
  private castInstanceLayers(ray: THREE.Ray, layerMask: number): ColliderHit[] {
    const deps = this.deps
    if (!deps?.getInstanceMeshesFor || !deps.resolveInstanceEntity) return []
    const { ecs, view } = deps
    const allowed = new Set<Entity>()
    for (const [entity] of view.getEntitiesWith(ecs.GltfContainer)) {
      const gltfData = ecs.GltfContainer.get(entity)
      if (
        gltfVisibleMeshLayerEnabled(gltfData, layerMask) ||
        gltfInvisibleMeshLayerEnabled(gltfData, layerMask)
      ) {
        allowed.add(entity)
      }
    }
    if (!allowed.size) return []
    const meshes = deps.getInstanceMeshesFor(allowed)
    if (!meshes.length) return []

    this.raycaster.layers.set(0)
    this.raycaster.set(ray.origin, ray.direction)
    const hits = this.raycaster.intersectObjects(meshes, false)
    const out: ColliderHit[] = []
    for (const hit of hits) {
      const instanceId = hit.instanceId ?? -1
      const entity =
        instanceId >= 0
          ? deps.resolveInstanceEntity(hit.object, instanceId)
          : (hit.object.userData.entity as Entity | undefined)
      if (entity === undefined || entity === null || !allowed.has(entity)) continue
      out.push({
        entity,
        point: hit.point.clone(),
        distance: hit.distance,
        normal: (hit.face?.normal ?? new THREE.Vector3(0, 1, 0)).clone(),
        meshName: hit.object.name || undefined
      })
    }
    return out
  }

  private mergeHits(a: ColliderHit[], b: ColliderHit[]): ColliderHit[] {
    if (!b.length) return a
    if (!a.length) return b
    return a.concat(b).sort((x, y) => x.distance - y.distance)
  }
}

/** Stable payload key — omit tickNumber so idle continuous rays do not dirty CRDT. */
function continuousResultSignature(result: {
  timestamp?: number
  globalOrigin?: { x?: number; y?: number; z?: number }
  direction?: { x?: number; y?: number; z?: number }
  hits?: Array<{ entityId?: number; length?: number }>
}): string {
  const o = result.globalOrigin
  const d = result.direction
  const hits = (result.hits ?? [])
    .map((h) => `${h.entityId ?? 0}:${(h.length ?? 0).toFixed(2)}`)
    .join(',')
  return `${result.timestamp ?? 0}|${(o?.x ?? 0).toFixed(2)},${(o?.y ?? 0).toFixed(2)},${(o?.z ?? 0).toFixed(2)}|${(d?.x ?? 0).toFixed(2)},${(d?.y ?? 0).toFixed(2)},${(d?.z ?? 0).toFixed(2)}|${hits}`
}

function emptyRay(): SceneRay {
  return {
    originThree: new THREE.Vector3(),
    directionThree: new THREE.Vector3(0, 0, 1),
    originDcl: new THREE.Vector3(),
    directionDcl: new THREE.Vector3(0, 0, 1)
  }
}