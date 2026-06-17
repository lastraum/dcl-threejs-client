import * as THREE from 'three'
import type { Entity } from '@dcl/ecs'
import { buildPrimitiveGeometry, primitiveKind, type PrimitiveMeshSpec } from '../bridge/primitiveShapes'
import type { MirrorComponents } from '../bridge/mirrorComponents'
import type { ProjectionView } from '../bridge/ProjectionView'
import { physxColliderDebug } from '../debug/PhysxColliderDebug'
import { ColliderLayer, hasColliderLayer, resolveCollisionMask } from './ColliderLayer'
import type { PhysicsColliderDesc } from '../physics/PhysXWorld'
import { colliderPoseFp } from './GltfColliderExtractor'

const colliderGeometryCache = new Map<string, THREE.BufferGeometry>()

export type ColliderHit = {
  entity: Entity
  point: THREE.Vector3
  distance: number
  normal: THREE.Vector3
}

type ColliderRecord = {
  root: THREE.Object3D
  mesh: THREE.Mesh
  collisionMask: number
}

/**
 * Syncs `MeshCollider` primitives into Three.js objects for raycasts (CL_POINTER)
 * and future physics (CL_PHYSICS). Shapes mirror MeshRenderer units; entity Transform
 * (position/rotation/scale + parent) defines world placement — same as Explorer.
 */
export class CollisionSystem {
  private readonly root = new THREE.Group()
  private readonly colliders = new Map<Entity, ColliderRecord>()
  private readonly poseFingerprints = new Map<Entity, string>()
  private physicsBatchFingerprint = ''
  private readonly raycaster = new THREE.Raycaster()
  private readonly unsubscribeDebug: () => void

  constructor(parent: THREE.Scene) {
    this.root.name = 'scene-colliders'
    parent.add(this.root)
    this.unsubscribeDebug = physxColliderDebug.subscribe(() => this.refreshDebugVisibility())
  }

  dispose(): void {
    this.unsubscribeDebug()
  }

  sync(
    view: ProjectionView,
    ecs: MirrorComponents,
    entityNodes: Map<Entity, THREE.Group>
  ): void {
    const { Transform, MeshCollider } = ecs
    const active = new Set<Entity>()

    for (const [entity] of view.getEntitiesWith(MeshCollider, Transform)) {
      if (entity === view.RootEntity || entity === view.PlayerEntity || entity === view.CameraEntity) {
        continue
      }

      const visual = entityNodes.get(entity)
      if (!visual) continue

      active.add(entity)
      const spec = MeshCollider.get(entity)
      const collisionMask = resolveCollisionMask(spec.collisionMask)
      if (collisionMask === ColliderLayer.CL_NONE) continue

      const kind = primitiveKind(spec as PrimitiveMeshSpec)
      let record = this.colliders.get(entity)

      if (!record || record.mesh.userData.colliderKind !== kind) {
        if (record) {
          record.root.remove(record.mesh)
        }

        let geometry = colliderGeometryCache.get(kind)
        if (!geometry) {
          geometry = buildPrimitiveGeometry(spec as PrimitiveMeshSpec)
          colliderGeometryCache.set(kind, geometry)
        }

        const mesh = new THREE.Mesh(
          geometry,
          this.createDebugMaterial(collisionMask, physxColliderDebug.isSceneMeshCollidersVisible())
        )
        mesh.name = `collider:${entity}`
        mesh.userData.colliderKind = kind
        mesh.userData.entity = entity
        mesh.userData.collisionMask = collisionMask

        const root = new THREE.Object3D()
        root.name = `collider-root:${entity}`
        root.add(mesh)
        this.root.add(root)

        record = { root, mesh, collisionMask }
        this.colliders.set(entity, record)
      } else if (record.collisionMask !== collisionMask) {
        record.collisionMask = collisionMask
        record.mesh.userData.collisionMask = collisionMask
        this.applyDebugMaterial(record.mesh, collisionMask, physxColliderDebug.isSceneMeshCollidersVisible())
      }

      visual.updateMatrixWorld(true)
      const poseFp = colliderPoseFp(visual.matrixWorld)
      if (this.poseFingerprints.get(entity) !== poseFp) {
        this.poseFingerprints.set(entity, poseFp)
        record.root.matrix.copy(visual.matrixWorld)
        record.root.matrixAutoUpdate = false
        record.root.updateMatrixWorld(true)
      }
      record.mesh.userData.collisionMask = collisionMask
    }

    for (const [entity, record] of this.colliders) {
      if (active.has(entity)) continue
      record.root.remove(record.mesh)
      this.root.remove(record.root)
      this.colliders.delete(entity)
      this.poseFingerprints.delete(entity)
    }

    this.recomputePhysicsBatchFingerprint()
  }

  /** Update poses for existing MeshColliders without scanning all ECS entities. */
  syncPoses(entityNodes: Map<Entity, THREE.Group>): void {
    if (!this.colliders.size) return
    let changed = false
    for (const [entity, record] of this.colliders) {
      const visual = entityNodes.get(entity)
      if (!visual) continue
      visual.updateMatrixWorld(true)
      const poseFp = colliderPoseFp(visual.matrixWorld)
      if (this.poseFingerprints.get(entity) === poseFp) continue
      this.poseFingerprints.set(entity, poseFp)
      record.root.matrix.copy(visual.matrixWorld)
      record.root.matrixAutoUpdate = false
      record.root.updateMatrixWorld(true)
      changed = true
    }
    if (changed) this.recomputePhysicsBatchFingerprint()
  }

  /** Cheap stable hash — skip PhysX cook when primitive poses are unchanged. */
  getPhysicsBatchFingerprint(): string {
    return this.physicsBatchFingerprint
  }

  private recomputePhysicsBatchFingerprint(): void {
    const parts: string[] = []
    for (const [entity, record] of this.colliders) {
      if (!hasColliderLayer(record.collisionMask, ColliderLayer.CL_PHYSICS)) continue
      const kind = String(record.mesh.userData.colliderKind ?? 'box')
      parts.push(`${entity}:${kind}:${record.collisionMask}:${colliderPoseFp(record.root.matrixWorld)}`)
    }
    this.physicsBatchFingerprint = parts.join('|')
  }

  getColliderMesh(entity: Entity): THREE.Mesh | null {
    return this.colliders.get(entity)?.mesh ?? null
  }

  /** Raycast scene colliders with a DCL layer mask (default CL_POINTER). */
  raycast(ray: THREE.Ray, layerMask = ColliderLayer.CL_POINTER): ColliderHit[] {
    const targets: THREE.Object3D[] = []
    for (const { mesh } of this.colliders.values()) {
      if (hasColliderLayer(mesh.userData.collisionMask as number, layerMask)) {
        targets.push(mesh)
      }
    }
    if (!targets.length) return []

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
        normal: (hit.face?.normal ?? new THREE.Vector3(0, 1, 0)).clone()
      })
    }

    return out
  }

  get colliderCount(): number {
    return this.colliders.size
  }

  /** Colliders with CL_PHYSICS for PhysX static actors. */
  getPhysicsColliders(): PhysicsColliderDesc[] {
    const out: PhysicsColliderDesc[] = []
    for (const [entity, record] of this.colliders) {
      if (!hasColliderLayer(record.collisionMask, ColliderLayer.CL_PHYSICS)) continue
      record.root.updateMatrixWorld(true)
      const kind = String(record.mesh.userData.colliderKind ?? 'box')
      out.push({
        entity,
        kind,
        fingerprint: `${kind}:${record.collisionMask}:${colliderPoseFp(record.root.matrixWorld)}`,
        matrix: record.root.matrixWorld.clone()
      })
    }
    return out
  }

  private createDebugMaterial(collisionMask: number, visible: boolean): THREE.MeshBasicMaterial {
    return new THREE.MeshBasicMaterial({
      color: hasColliderLayer(collisionMask, ColliderLayer.CL_PHYSICS) ? 0x00ff88 : 0xff8800,
      wireframe: true,
      transparent: true,
      opacity: visible ? 0.35 : 0,
      depthTest: false,
      depthWrite: false
    })
  }

  private applyDebugMaterial(mesh: THREE.Mesh, collisionMask: number, visible: boolean): void {
    const prev = mesh.material as THREE.Material
    prev.dispose()
    mesh.material = this.createDebugMaterial(collisionMask, visible)
  }

  private refreshDebugVisibility(): void {
    const visible = physxColliderDebug.isSceneMeshCollidersVisible()
    for (const { mesh, collisionMask } of this.colliders.values()) {
      this.applyDebugMaterial(mesh, collisionMask, visible)
    }
  }
}
