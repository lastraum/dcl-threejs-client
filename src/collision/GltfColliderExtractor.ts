import * as THREE from 'three'
import type { Entity } from '@dcl/ecs'
import type { MirrorComponents } from '../bridge/mirrorComponents'
import type { ProjectionView } from '../bridge/ProjectionView'
import type { PhysicsColliderDesc, PhysicsColliderShapeDesc } from '../physics/PhysXWorld'
import { physxColliderDebug } from '../debug/PhysxColliderDebug'
import { ColliderLayer, hasColliderLayer } from './ColliderLayer'
import { isGltfInvisibleColliderMesh, isGltfVisibleClassMesh } from './gltfColliderNaming'
import { bakeTrimeshGeometry } from '../physics/bakeTrimeshGeometry'
import { clientDebugLog } from '../client/debug/ClientDebugLog'
import {
  isSignificantPlatformDelta,
  STAND_SURFACE_CONTACT_TOLERANCE,
  STAND_SURFACE_MAX_BELOW_TREAD,
  STAND_SURFACE_MAX_VERT_GAP
} from '../physics/platformMotion'

export const LANDSCAPE_COLLIDER_ENTITY_BASE = 19_000_000
/** Synthetic PhysX entity id — one actor per GltfContainer ECS entity (avoids MeshCollider id clash). */
export const GLTF_COLLIDER_ENTITY_BASE = 20_000_000

export function gltfPhysicsEntityId(entity: Entity): number {
  return GLTF_COLLIDER_ENTITY_BASE + entity
}

const _entityInv = new THREE.Matrix4()
const _worldMatrix = new THREE.Matrix4()

/**
 * Extracts physics colliders from GLTF meshes.
 * DCL convention: invisible physics meshes named `_collider…` or `…_collider` (see `gltfColliderNaming.ts`).
 * One static PhysX actor per GltfContainer entity — geometry in mesh-local space, actor at entity world pose.
 */
export class GltfColliderExtractor {
  private readonly extracted = new Map<Entity, PhysicsColliderDesc>()
  private readonly fingerprints = new Map<Entity, string>()
  private readonly poseFingerprints = new Map<Entity, string>()
  /** Live `_collider` mesh world poses — catches Animator motion without root Transform drift. */
  private readonly lastColliderMeshWorldFp = new Map<Entity, string>()
  /** Frame-start walk surface point — bbox-top center of highest CL_PHYSICS collider mesh. */
  private readonly walkSurfaceSnapshotPos = new Map<Entity, THREE.Vector3>()
  private readonly frameWalkSurfaceDelta = new Map<Entity, THREE.Vector3>()
  private readonly frameWalkSurfacePos = new Map<Entity, THREE.Vector3>()
  private readonly _walkSurfacePos = new THREE.Vector3()
  private readonly _walkSurfaceBox = new THREE.Box3()
  /** Stable geometry + mask + mesh child — skip trimesh re-extract when unchanged. */
  private readonly syncState = new Map<
    Entity,
    {
      geomKey: string
      maskKey: string
      mesh: THREE.Object3D
      hasVisiblePhysics: boolean
      hasInvisiblePhysics: boolean
    }
  >()
  private readonly debugRoot: THREE.Group
  private readonly debugMeshes = new Map<string, THREE.Mesh>()
  private debugFingerprint = ''
  private readonly unsubscribeDebug: () => void
  private loggedSyncSummary = false
  /** Dedupe per-entity diagnostics — avoids thousands of repeats on hydration / prewarm passes. */
  private loggedEntities = new Set<Entity>()
  private landscapeRoot: THREE.Object3D | null = null
  private landscapeColliders: PhysicsColliderDesc[] = []
  private landscapeCollidersReady = false
  /** When false, open island beach uses the infinite ground plane only (no parcel GLB _collider boxes). */
  private landscapePhysicsEnabled = true
  private physicsBatchFingerprint = ''

  private static emptyFingerprint = '__empty__'

  constructor(scene: THREE.Scene) {
    this.debugRoot = new THREE.Group()
    this.debugRoot.name = 'gltf-collider-debug'
    this.debugRoot.visible = false
    scene.add(this.debugRoot)
    this.unsubscribeDebug = physxColliderDebug.subscribe(() => this.syncDebugVisibility())
  }

  dispose(): void {
    this.unsubscribeDebug()
    this.landscapeRoot = null
    for (const mesh of this.debugMeshes.values()) {
      mesh.geometry.dispose()
      ;(mesh.material as THREE.Material).dispose()
    }
    this.debugMeshes.clear()
    this.debugRoot.removeFromParent()
  }

  /** Full GltfContainer walk — hydration / force-recook only. */
  sync(
    view: ProjectionView,
    ecs: MirrorComponents,
    entityNodes: Map<Entity, THREE.Group>
  ): void {
    const { Transform, GltfContainer } = ecs
    const active = new Set<Entity>()

    for (const [entity] of view.getEntitiesWith(GltfContainer, Transform)) {
      if (this.isReserved(entity, view)) continue
      const obj = entityNodes.get(entity)
      if (!obj) continue
      const gltfMesh = obj.children.find((c) => c.name.startsWith('__mesh_'))
      if (!gltfMesh) continue
      active.add(entity)
      this.syncColliderEntity(entity, view, ecs, entityNodes)
    }

    if (!this.loggedSyncSummary && active.size > 0) {
      const debugVisible = physxColliderDebug.isGltfCollidersVisible()
      clientDebugLog.log(
        'collision',
        `[GltfCollider] sync complete — ${active.size} entities, ${this.totalShapeCount()} shape(s) in ${this.extracted.size} actor(s)`,
        { alsoConsole: debugVisible, throttleMs: debugVisible ? undefined : 60_000 }
      )
      this.loggedSyncSummary = true
    }

    for (const entity of this.extracted.keys()) {
      if (active.has(entity)) continue
      // GLB mesh children can detach briefly during re-attach — keep last-known colliders.
      if (entityNodes.has(entity) && GltfContainer.has(entity)) continue
      this.removeColliderEntity(entity)
    }

    this.finalizeColliderSync()
  }

  /**
   * Extract or update GLTF colliders for one GltfContainer entity (GLB tree traverse).
   * @returns `true` when handled; `false` when the GLB mesh is not attached yet (retry later).
   */
  syncColliderEntity(
    entity: Entity,
    view: ProjectionView,
    ecs: MirrorComponents,
    entityNodes: Map<Entity, THREE.Group>
  ): boolean {
    const { Transform, GltfContainer } = ecs

    if (this.isReserved(entity, view) || !GltfContainer.has(entity) || !Transform.has(entity)) {
      this.removeColliderEntity(entity)
      return true
    }

    const obj = entityNodes.get(entity)
    if (!obj) return false

    const gltfMesh = obj.children.find((c) => c.name.startsWith('__mesh_'))
    if (!gltfMesh) return false

    const gltfData = GltfContainer.get(entity)
    const invisibleMask = gltfData.invisibleMeshesCollisionMask ?? (ColliderLayer.CL_POINTER | ColliderLayer.CL_PHYSICS)
    const visibleMask = gltfData.visibleMeshesCollisionMask ?? 0

    const hasVisiblePhysics = hasColliderLayer(visibleMask, ColliderLayer.CL_PHYSICS)
    const hasInvisiblePhysics = hasColliderLayer(invisibleMask, ColliderLayer.CL_PHYSICS)
    const maskKey = `${invisibleMask}|${visibleMask}`
    const prevGeom = this.fingerprints.get(entity)
    const state = this.syncState.get(entity)
    const stored = this.extracted.get(entity)

    // Fast path: geometry unchanged — pose-only (runtime tweens / Transform updates).
    // Skipped when syncState was cleared (boot cook / invalidateEntitySyncCache).
    if (
      state &&
      stored &&
      prevGeom &&
      prevGeom !== GltfColliderExtractor.emptyFingerprint &&
      state.mesh === gltfMesh &&
      state.geomKey === prevGeom &&
      state.maskKey === maskKey
    ) {
      this.syncColliderEntityPose(entity, entityNodes)
      return true
    }

    const desc = this.extractColliderDesc(entity, gltfMesh, obj, hasVisiblePhysics, hasInvisiblePhysics)

    if (!desc && !hasVisiblePhysics && !hasInvisiblePhysics && !hasAnyInvisibleColliderMesh(gltfMesh)) {
      this.removeColliderEntity(entity)
      return true
    }

    const geomKey = desc?.shapes?.length
      ? desc.shapes.map((s) => s.fingerprint).join('|')
      : GltfColliderExtractor.emptyFingerprint
    const geomChanged = prevGeom !== geomKey

    if (geomChanged) {
      this.fingerprints.set(entity, geomKey)
      this.logEntityOnce(entity, gltfData.src, invisibleMask, visibleMask, desc, gltfMesh)
    }

    if (desc) {
      this.extracted.set(entity, desc)
      this.syncState.set(entity, {
        geomKey,
        maskKey,
        mesh: gltfMesh,
        hasVisiblePhysics,
        hasInvisiblePhysics
      })
      this.poseFingerprints.set(entity, gltfColliderPoseFp(desc))
    } else {
      this.removeColliderEntity(entity)
    }
    return true
  }

  /**
   * Pose-only update for one GLTF collider actor.
   * @param allowShapeMotion follow animated `_collider` child meshes — only when grounded on this
   *   entity or ECS transform drives the platform; decorative animators stay at rest pose.
   */
  syncColliderEntityPose(
    entity: Entity,
    entityNodes: Map<Entity, THREE.Group>,
    allowShapeMotion = false
  ): boolean {
    const stored = this.extracted.get(entity)
    const obj = entityNodes.get(entity)
    if (!stored || !obj) return false
    obj.updateMatrixWorld(true)
    const state = this.syncState.get(entity)
    const gltfMesh = state?.mesh ?? obj.children.find((c) => c.name.startsWith('__mesh_'))
    let shapesChanged = false
    if (allowShapeMotion && stored.shapes?.length && gltfMesh && state) {
      shapesChanged = this.refreshShapeLocalMatrices(
        gltfMesh,
        obj,
        stored.shapes,
        state.hasVisiblePhysics,
        state.hasInvisiblePhysics
      )
    }
    stored.matrix.copy(obj.matrixWorld)
    const poseFp = allowShapeMotion
      ? gltfColliderPoseFp(stored)
      : colliderPoseFp(stored.matrix)
    if (!shapesChanged && this.poseFingerprints.get(entity) === poseFp) return false
    this.poseFingerprints.set(entity, poseFp)
    return true
  }

  /** Snapshot walk-surface baselines for motion emitter candidates only (pre-bridge). */
  snapshotWalkSurfaceForEntities(
    entityNodes: Map<Entity, THREE.Group>,
    entities: ReadonlySet<Entity>,
    feet?: THREE.Vector3
  ): void {
    for (const entity of entities) {
      if (!this.extracted.has(entity)) continue
      const surface = this.colliderWalkSurfacePos(entity, entityNodes, feet)
      if (surface) this.walkSurfaceSnapshotPos.set(entity, surface.clone())
      else this.walkSurfaceSnapshotPos.delete(entity)
    }
  }

  /**
   * Per-frame walk-surface Δ for entities that moved this frame (motion emitter union).
   * Fed into CCT platform velocity transfer (capsule += Δ before controller.move).
   */
  computeWalkSurfaceDeltasForEntities(
    entityNodes: Map<Entity, THREE.Group>,
    entities: ReadonlySet<Entity>,
    feet?: THREE.Vector3,
    priorityEntities: Entity[] = []
  ): Entity[] {
    this.frameWalkSurfaceDelta.clear()
    this.frameWalkSurfacePos.clear()
    const changed: Entity[] = []
    const priority = new Set(priorityEntities)
    for (const entity of priorityEntities) {
      if (this.recordWalkSurfaceDelta(entity, entityNodes, feet, changed, true)) {
        // recorded
      }
    }
    for (const entity of entities) {
      if (priority.has(entity)) continue
      if (!this.extracted.has(entity)) continue
      this.recordWalkSurfaceDelta(entity, entityNodes, feet, changed, false)
    }
    return changed
  }

  /**
   * Animator emitter — true when collider child mesh world positions changed since last probe.
   */
  probeColliderMeshMotion(entity: Entity, _entityNodes: Map<Entity, THREE.Group>): boolean {
    const state = this.syncState.get(entity)
    if (!state) return false
    const fp = this.colliderMeshWorldFingerprint(
      state.mesh,
      state.hasVisiblePhysics,
      state.hasInvisiblePhysics
    )
    if (!fp) return false
    const prev = this.lastColliderMeshWorldFp.get(entity)
    if (prev === fp) return false
    this.lastColliderMeshWorldFp.set(entity, fp)
    return true
  }

  private recordWalkSurfaceDelta(
    entity: Entity,
    entityNodes: Map<Entity, THREE.Group>,
    feet: THREE.Vector3 | undefined,
    changed: Entity[],
    requireSnapshot: boolean
  ): boolean {
    const state = this.syncState.get(entity)
    if (!state) return false
    const surface = this.colliderWalkSurfacePos(entity, entityNodes, feet)
    const snapshot = this.walkSurfaceSnapshotPos.get(entity)
    if (!surface || (requireSnapshot && !snapshot)) return false
    if (!snapshot) {
      this.walkSurfaceSnapshotPos.set(entity, surface.clone())
      return false
    }

    this.frameWalkSurfacePos.set(entity, surface.clone())
    this._walkSurfacePos.subVectors(surface, snapshot)
    if (isSignificantPlatformDelta(this._walkSurfacePos)) {
      this.frameWalkSurfaceDelta.set(entity, this._walkSurfacePos.clone())
      changed.push(entity)
    }
    return true
  }

  /** Current-frame walk-surface positions — platform transfer proximity (not entity pivots). */
  consumeFrameWalkSurfacePositionsPhys(): Map<number, THREE.Vector3> {
    const out = new Map<number, THREE.Vector3>()
    for (const [entity, pos] of this.frameWalkSurfacePos) {
      out.set(GLTF_COLLIDER_ENTITY_BASE + entity, pos.clone())
    }
    return out
  }

  /** PhysX entity id → walk-surface Δ this frame (GLTF_COLLIDER_ENTITY_BASE + ecs entity). */
  consumeFrameWalkSurfaceDeltasPhys(): Map<number, THREE.Vector3> {
    const out = new Map<number, THREE.Vector3>()
    for (const [entity, delta] of this.frameWalkSurfaceDelta) {
      out.set(GLTF_COLLIDER_ENTITY_BASE + entity, delta)
    }
    return out
  }

  /**
   * Bbox-top center for platform transfer.
   * With `feet` — highest collider tread in the XZ column under the capsule (not global entity maxY).
   */
  private colliderWalkSurfacePos(
    entity: Entity,
    entityNodes: Map<Entity, THREE.Group>,
    feet?: THREE.Vector3
  ): THREE.Vector3 | null {
    const state = this.syncState.get(entity)
    const obj = entityNodes.get(entity)
    if (!state || !obj) return null
    const meshes = this.collectColliderMeshes(
      state.mesh,
      state.hasVisiblePhysics,
      state.hasInvisiblePhysics
    )
    if (!meshes.length) return null

    const columnMargin = 1.5
    let columnMaxY = Number.NEGATIVE_INFINITY
    let columnBest: THREE.Vector3 | null = null
    let globalMaxY = Number.NEGATIVE_INFINITY
    let globalBest: THREE.Vector3 | null = null

    for (const mesh of meshes) {
      mesh.updateMatrixWorld(true)
      this._walkSurfaceBox.setFromObject(mesh)
      if (!Number.isFinite(this._walkSurfaceBox.max.y)) continue

      const top = this._walkSurfacePos.set(
        (this._walkSurfaceBox.min.x + this._walkSurfaceBox.max.x) * 0.5,
        this._walkSurfaceBox.max.y,
        (this._walkSurfaceBox.min.z + this._walkSurfaceBox.max.z) * 0.5
      )

      if (this._walkSurfaceBox.max.y >= globalMaxY) {
        globalMaxY = this._walkSurfaceBox.max.y
        globalBest = top
      }

      if (feet) {
        if (feet.x < this._walkSurfaceBox.min.x - columnMargin) continue
        if (feet.x > this._walkSurfaceBox.max.x + columnMargin) continue
        if (feet.z < this._walkSurfaceBox.min.z - columnMargin) continue
        if (feet.z > this._walkSurfaceBox.max.z + columnMargin) continue
        if (this._walkSurfaceBox.max.y >= columnMaxY) {
          columnMaxY = this._walkSurfaceBox.max.y
          columnBest = top
        }
      }
    }

    // With `feet`, only tread under the capsule column — no global bbox fallback (animated props
    // like SnoopCar would otherwise register platform Δ 96m away and bounce distant avatars).
    const best = feet ? columnBest : globalBest
    return best ? best.clone() : null
  }

  private collectColliderMeshes(
    gltfRoot: THREE.Object3D,
    hasVisiblePhysics: boolean,
    hasInvisiblePhysics: boolean
  ): THREE.Mesh[] {
    const colliderMeshes: THREE.Mesh[] = []
    gltfRoot.traverse((node) => {
      if (!(node instanceof THREE.Mesh)) return
      if ((node as THREE.SkinnedMesh).isSkinnedMesh) return
      if (isGltfVisibleClassMesh(node)) {
        if (hasVisiblePhysics) colliderMeshes.push(node)
        return
      }
      if (isGltfInvisibleColliderMesh(node, gltfRoot)) {
        if (hasInvisiblePhysics) colliderMeshes.push(node)
        return
      }
      if (hasVisiblePhysics) colliderMeshes.push(node)
    })
    return colliderMeshes
  }

  private colliderMeshWorldFingerprint(
    gltfRoot: THREE.Object3D,
    hasVisiblePhysics: boolean,
    hasInvisiblePhysics: boolean
  ): string | null {
    const meshes = this.collectColliderMeshes(gltfRoot, hasVisiblePhysics, hasInvisiblePhysics)
    if (!meshes.length) return null
    const parts: string[] = []
    for (const mesh of meshes) {
      mesh.updateMatrixWorld(true)
      const e = mesh.matrixWorld.elements
      parts.push(`${e[12]!.toFixed(3)},${e[13]!.toFixed(3)},${e[14]!.toFixed(3)}`)
    }
    return parts.join('|')
  }

  /** Animator / skinned GLTF — child `_collider` meshes move without entity-root Transform changes. */
  private refreshShapeLocalMatrices(
    gltfRoot: THREE.Object3D,
    entityObj: THREE.Object3D,
    shapes: PhysicsColliderShapeDesc[],
    hasVisiblePhysics: boolean,
    hasInvisiblePhysics: boolean
  ): boolean {
    const colliderMeshes = this.collectColliderMeshes(gltfRoot, hasVisiblePhysics, hasInvisiblePhysics)
    const eligibleMeshes = colliderMeshes.filter((mesh) => {
      const posAttr = mesh.geometry.getAttribute('position')
      return posAttr && posAttr.count >= 3
    })
    if (!eligibleMeshes.length || eligibleMeshes.length !== shapes.length) return false

    _entityInv.copy(entityObj.matrixWorld).invert()
    let changed = false
    for (let i = 0; i < shapes.length; i++) {
      const mesh = eligibleMeshes[i]!
      mesh.updateMatrixWorld(true)
      _worldMatrix.copy(mesh.matrixWorld).premultiply(_entityInv)
      const nextFp = colliderPoseFp(_worldMatrix)
      if (colliderPoseFp(shapes[i]!.localMatrix) !== nextFp) {
        shapes[i]!.localMatrix.copy(_worldMatrix)
        changed = true
      }
    }
    return changed
  }

  /** Drop geom-skip cache for one entity — next sync re-traverses its GLB with live matrixWorld. */
  invalidateEntitySyncCache(entity: Entity): void {
    this.syncState.delete(entity)
  }

  /** Drop all geom-skip caches — use once before boot PhysX cook (after final renderer sync). */
  invalidateColliderSyncCache(): void {
    this.syncState.clear()
  }

  removeColliderEntity(entity: Entity): boolean {
    if (!this.extracted.has(entity) && !this.fingerprints.has(entity)) return false
    this.extracted.delete(entity)
    this.fingerprints.delete(entity)
    this.poseFingerprints.delete(entity)
    this.syncState.delete(entity)
    this.lastColliderMeshWorldFp.delete(entity)
    this.walkSurfaceSnapshotPos.delete(entity)
    this.frameWalkSurfaceDelta.delete(entity)
    return true
  }

  /** Recompute PhysX batch fingerprint + debug wireframes after per-entity structure syncs. */
  finalizeColliderSync(): void {
    this.recomputePhysicsBatchFingerprint()
    this.syncDebugVisibility()
  }

  /** Pose-only pass for tweened entities — skips full GLTF mesh traversal. */
  syncPoses(
    entityNodes: Map<Entity, THREE.Group>,
    shapeMotionEntities?: ReadonlySet<Entity>
  ): void {
    if (!this.extracted.size) return
    let changed = false
    for (const entity of this.extracted.keys()) {
      const allowShapes = shapeMotionEntities?.has(entity) ?? false
      if (this.syncColliderEntityPose(entity, entityNodes, allowShapes)) changed = true
    }
    if (changed) this.recomputePhysicsBatchFingerprint()
  }

  syncPosesForEntities(
    entityNodes: Map<Entity, THREE.Group>,
    entities: readonly Entity[],
    shapeMotion?: ReadonlySet<Entity>
  ): void {
    let changed = false
    for (const entity of entities) {
      if (!this.extracted.has(entity)) continue
      const allowShapes = shapeMotion?.has(entity) ?? false
      if (this.syncColliderEntityPose(entity, entityNodes, allowShapes)) changed = true
    }
    if (changed) this.recomputePhysicsBatchFingerprint()
  }

  setLandscapeRoot(
    root: THREE.Object3D | null,
    options?: { physicsColliders?: boolean }
  ): void {
    this.landscapeRoot = root
    this.landscapePhysicsEnabled = options?.physicsColliders !== false
    this.landscapeCollidersReady = false
    this.landscapeColliders = []
    this.recomputePhysicsBatchFingerprint()
    this.syncDebugVisibility()
  }

  /** Cheap stable hash — skip PhysX cook when geometry + poses are unchanged. */
  getPhysicsBatchFingerprint(): string {
    return this.physicsBatchFingerprint
  }

  getPhysicsColliders(): PhysicsColliderDesc[] {
    // Scene walkable surfaces come from ECS GltfContainer / MeshCollider — not parcel
    // landscape GLBs (padding is out of bounds; deployed scenes bring their own floor).
    return this.collectPhysicsColliders()
  }

  hasExtractedCollider(entity: Entity): boolean {
    return this.extracted.has(entity)
  }

  /**
   * Highest Animator GLTF tread under the capsule column — proactive stand surface before CCT
   * has registered grounding (avoids fall-through on bobbing props like SnoopCar).
   * Works at any world Y (e.g. car on a 3rd floor): contact is relative to the animated tread.
   */
  /**
   * Highest static GLTF tread near feet — only when CCT reports infinite ground.
   * Horiz-culled extracted scan (not a per-frame walk-surface pass).
   */
  findStaticStandSurfaceNearFeet(
    entityNodes: Map<Entity, THREE.Group>,
    feet: THREE.Vector3,
    maxHoriz = 24
  ): Entity | null {
    let bestEntity: Entity | null = null
    let bestScore = Number.POSITIVE_INFINITY
    const maxHorizSq = maxHoriz * maxHoriz

    for (const entity of this.extracted.keys()) {
      const obj = entityNodes.get(entity)
      if (!obj) continue
      obj.updateMatrixWorld(true)
      const dx = obj.matrixWorld.elements[12]! - feet.x
      const dz = obj.matrixWorld.elements[14]! - feet.z
      if (dx * dx + dz * dz > maxHorizSq) continue

      const surface = this.colliderWalkSurfacePos(entity, entityNodes, feet)
      if (!surface) continue
      const gap = Math.abs(feet.y - surface.y)
      if (gap > STAND_SURFACE_MAX_VERT_GAP + 2) continue
      const horizSq =
        (feet.x - surface.x) * (feet.x - surface.x) +
        (feet.z - surface.z) * (feet.z - surface.z)
      const score = gap + horizSq * 0.08
      if (score < bestScore) {
        bestScore = score
        bestEntity = entity
      }
    }
    return bestEntity
  }

  /** Stand-surface hint among active animator candidates only — not a full extracted scan. */
  findAnimatedStandSurfaceAmong(
    entityNodes: Map<Entity, THREE.Group>,
    feet: THREE.Vector3,
    candidates: readonly Entity[],
    isAnimatedCollider: (entity: Entity) => boolean
  ): Entity | null {
    let bestEntity: Entity | null = null
    let bestScore = Number.POSITIVE_INFINITY

    for (const entity of candidates) {
      if (!this.extracted.has(entity) || !isAnimatedCollider(entity)) continue
      const surface = this.animatedColliderContactSurface(entity, entityNodes, feet)
      if (!surface) continue
      const gap = Math.abs(feet.y - surface.y)
      const horizSq =
        (feet.x - surface.x) * (feet.x - surface.x) +
        (feet.z - surface.z) * (feet.z - surface.z)
      const score = gap + horizSq * 0.08
      if (score < bestScore) {
        bestScore = score
        bestEntity = entity
      }
    }
    return bestEntity
  }

  hasAnimatedStandContact(
    entity: Entity,
    entityNodes: Map<Entity, THREE.Group>,
    feet: THREE.Vector3
  ): boolean {
    return this.animatedColliderContactSurface(entity, entityNodes, feet) !== null
  }

  /**
   * Highest animated collider tread contacting the capsule — on tread top or just below a rising
   * bobbing surface (height-agnostic; no ground-level assumption).
   */
  private animatedColliderContactSurface(
    entity: Entity,
    entityNodes: Map<Entity, THREE.Group>,
    feet: THREE.Vector3
  ): THREE.Vector3 | null {
    const state = this.syncState.get(entity)
    const obj = entityNodes.get(entity)
    if (!state || !obj) return null
    const meshes = this.collectColliderMeshes(
      state.mesh,
      state.hasVisiblePhysics,
      state.hasInvisiblePhysics
    )
    if (!meshes.length) return null

    const columnMargin = 1.5
    let bestTreadY = Number.NEGATIVE_INFINITY
    let best: THREE.Vector3 | null = null

    for (const mesh of meshes) {
      mesh.updateMatrixWorld(true)
      this._walkSurfaceBox.setFromObject(mesh)
      if (!Number.isFinite(this._walkSurfaceBox.max.y)) continue

      if (feet.x < this._walkSurfaceBox.min.x - columnMargin) continue
      if (feet.x > this._walkSurfaceBox.max.x + columnMargin) continue
      if (feet.z < this._walkSurfaceBox.min.z - columnMargin) continue
      if (feet.z > this._walkSurfaceBox.max.z + columnMargin) continue

      const gap = feet.y - this._walkSurfaceBox.max.y
      const onTop =
        gap >= -STAND_SURFACE_CONTACT_TOLERANCE && gap <= STAND_SURFACE_MAX_VERT_GAP
      const belowRising =
        gap < -STAND_SURFACE_CONTACT_TOLERANCE && gap >= -STAND_SURFACE_MAX_BELOW_TREAD
      if (!onTop && !belowRising) continue

      const top = this._walkSurfacePos.set(
        (this._walkSurfaceBox.min.x + this._walkSurfaceBox.max.x) * 0.5,
        this._walkSurfaceBox.max.y,
        (this._walkSurfaceBox.min.z + this._walkSurfaceBox.max.z) * 0.5
      )
      if (top.y > bestTreadY) {
        bestTreadY = top.y
        best = top.clone()
      }
    }
    return best
  }

  getPhysicsColliderForEntity(entity: Entity): PhysicsColliderDesc | null {
    return this.extracted.get(entity) ?? null
  }

  /** GltfContainer entities with cookable physics trimeshes (excludes landscape root). */
  getGltfEntityColliderCount(): number {
    return this.extracted.size
  }

  /** Shape counts by GLTF mesh category — for spawn diagnostics (`?collidersphys`). */
  getPhysicsExtractionStats(): { entities: number; invisibleShapes: number; visibleShapes: number } {
    let invisibleShapes = 0
    let visibleShapes = 0
    for (const desc of this.extracted.values()) {
      for (const shape of desc.shapes ?? []) {
        if (shape.fingerprint.includes(':inv:')) invisibleShapes++
        else if (shape.fingerprint.includes(':vis:')) visibleShapes++
      }
    }
    return { entities: this.extracted.size, invisibleShapes, visibleShapes }
  }

  getLandscapeColliderCount(): number {
    return this.ensureLandscapeColliders().length
  }

  private ensureLandscapeColliders(): PhysicsColliderDesc[] {
    if (!this.landscapeRoot || !this.landscapePhysicsEnabled) return []
    if (!this.landscapeCollidersReady) {
      this.landscapeColliders = this.buildLandscapeColliderDescs()
      this.landscapeCollidersReady = true
    } else {
      this.refreshLandscapeColliderPoses()
    }
    return this.landscapeColliders
  }

  private buildLandscapeColliderDescs(): PhysicsColliderDesc[] {
    if (!this.landscapeRoot) return []
    this.landscapeRoot.updateMatrixWorld(true)
    return buildColliderDescs(this.landscapeRoot, this.landscapeRoot, 'landscape')
  }

  /** World-baked trimeshes — refresh node matrixWorld before PhysX cook / pose checks. */
  refreshLandscapeColliderPoses(): void {
    if (!this.landscapeRoot || !this.landscapeColliders.length) return
    const fresh = this.buildLandscapeColliderDescs()
    for (let i = 0; i < this.landscapeColliders.length; i++) {
      const live = fresh[i]
      if (!live) continue
      this.landscapeColliders[i]!.matrix.copy(live.matrix)
    }
    this.recomputePhysicsBatchFingerprint()
  }

  private recomputePhysicsBatchFingerprint(): void {
    const parts: string[] = []
    for (const [entity, desc] of this.extracted) {
      parts.push(`${entity}:${desc.fingerprint}:${colliderPoseFp(desc.matrix)}`)
    }
    for (const desc of this.landscapeColliders) {
      parts.push(`L:${desc.fingerprint}:${colliderPoseFp(desc.matrix)}`)
    }
    this.physicsBatchFingerprint = parts.join('|')
  }

  private isReserved(entity: Entity, view: ProjectionView): boolean {
    return (
      entity === view.RootEntity || entity === view.PlayerEntity || entity === view.CameraEntity
    )
  }

  private collectPhysicsColliders(): PhysicsColliderDesc[] {
    return [...this.extracted.values()]
  }

  private totalShapeCount(): number {
    let n = 0
    for (const desc of this.extracted.values()) {
      n += desc.shapes?.length ?? 0
    }
    return n
  }

  /** Verbose per-entity lines only with `?colliders`; each entity logged at most once per session. */
  private logEntityOnce(
    entity: Entity,
    src: string,
    invisibleMask: number,
    visibleMask: number,
    desc: PhysicsColliderDesc | null,
    gltfMesh: THREE.Object3D
  ): void {
    if (!physxColliderDebug.isGltfCollidersVisible()) return
    if (this.loggedEntities.has(entity)) return
    this.loggedEntities.add(entity)

    const shapeCount = desc?.shapes?.length ?? 0
    const meshNames = collectMeshNames(gltfMesh)
    const invCount = desc?.shapes?.filter((s) => s.fingerprint.includes(':inv:')).length ?? 0
    clientDebugLog.log(
      'collision',
      `[GltfCollider] e${entity} src="${src}" invisibleMask=${invisibleMask} visibleMask=${visibleMask} → ${shapeCount} trimesh (${invCount} invisible _collider)${shapeCount === 0 ? ` meshes=[${meshNames.join(', ')}]` : ''}`,
      { alsoConsole: true, throttleKey: `gltf-collider:${entity}` }
    )
  }

  private syncDebugVisibility(): void {
    if (!physxColliderDebug.isGltfCollidersVisible()) {
      this.clearDebugMeshes()
      return
    }

    const descs = this.getPhysicsColliders()
    const fp = descs
      .flatMap((desc) => debugWireframeEntries(desc).map((e) => `${e.key}:${colliderPoseFp(e.matrix)}`))
      .join('|')
    if (fp === this.debugFingerprint && this.debugMeshes.size > 0) return

    this.debugFingerprint = fp
    this.rebuildDebugMeshes(descs)
  }

  private clearDebugMeshes(): void {
    for (const mesh of this.debugMeshes.values()) {
      mesh.geometry.dispose()
      ;(mesh.material as THREE.Material).dispose()
      this.debugRoot.remove(mesh)
    }
    this.debugMeshes.clear()
    this.debugRoot.visible = false
    this.debugFingerprint = ''
  }

  private rebuildDebugMeshes(descs: PhysicsColliderDesc[]): void {
    for (const mesh of this.debugMeshes.values()) {
      mesh.geometry.dispose()
      ;(mesh.material as THREE.Material).dispose()
      this.debugRoot.remove(mesh)
    }
    this.debugMeshes.clear()

    if (!physxColliderDebug.isGltfCollidersVisible() || descs.length === 0) {
      this.debugRoot.visible = false
      return
    }

    const matFor = (fingerprint: string) =>
      new THREE.MeshBasicMaterial({
        color: fingerprint.includes(':inv:') ? 0xff44ff : 0x00ffff,
        wireframe: true,
        transparent: true,
        opacity: fingerprint.includes(':inv:') ? 0.35 : 0.25,
        depthTest: false,
        depthWrite: false
      })

    for (const desc of descs) {
      for (const entry of debugWireframeEntries(desc)) {
        const geo = entry.geometry
          ? bakeTrimeshGeometry(entry.geometry, entry.matrix)
          : new THREE.BoxGeometry(1, 1, 1)
        const mesh = new THREE.Mesh(geo, matFor(entry.fingerprint))
        this.debugRoot.add(mesh)
        this.debugMeshes.set(entry.key, mesh)
      }
    }
    this.debugRoot.visible = true
  }

  private extractColliderDesc(
    entity: Entity,
    gltfRoot: THREE.Object3D,
    entityObj: THREE.Object3D,
    hasVisiblePhysics: boolean,
    hasInvisiblePhysics: boolean
  ): PhysicsColliderDesc | null {
    const colliderMeshes: THREE.Mesh[] = []
    gltfRoot.traverse((node) => {
      if (!(node instanceof THREE.Mesh)) return
      if ((node as THREE.SkinnedMesh).isSkinnedMesh) return
      // Named visible-class meshes (RickRoll Cube) — honor visible mask only, not _collider ancestry.
      if (isGltfVisibleClassMesh(node)) {
        if (hasVisiblePhysics) colliderMeshes.push(node)
        return
      }
      if (isGltfInvisibleColliderMesh(node, gltfRoot)) {
        if (hasInvisiblePhysics) colliderMeshes.push(node)
        return
      }
      // Unnamed visible-category meshes (common in plaza GLBs) — need explicit CL_PHYSICS on visible mask.
      if (hasVisiblePhysics) colliderMeshes.push(node)
    })

    if (!colliderMeshes.length) return null

    entityObj.updateMatrixWorld(true)
    _entityInv.copy(entityObj.matrixWorld).invert()

    const shapes: PhysicsColliderShapeDesc[] = []

    for (const mesh of colliderMeshes) {
      mesh.updateMatrixWorld(true)

      const sourceGeo = mesh.geometry
      const posAttr = sourceGeo.getAttribute('position')
      if (!posAttr || posAttr.count < 3) continue

      _worldMatrix.copy(mesh.matrixWorld).premultiply(_entityInv)

      const fp = `gltf:${isGltfInvisibleColliderMesh(mesh, gltfRoot) ? 'inv' : 'vis'}:${entity}:${shapes.length}:${mesh.name}:${sourceGeo.uuid}`

      // Reference shared AssetCache geometry — PhysX cook clones via bakeTrimeshGeometry.
      shapes.push({
        fingerprint: fp,
        geometry: sourceGeo,
        localMatrix: _worldMatrix.clone()
      })
    }

    if (!shapes.length) return null

    const geomKey = shapes.map((s) => s.fingerprint).join('|')

    return {
      entity: GLTF_COLLIDER_ENTITY_BASE + entity,
      kind: 'gltf-multi',
      // v3 — entity-local baked geometry + relative per-shape pose slides (Animator walk surfaces).
      fingerprint: `gltf-entity:v3:${entity}:${geomKey}`,
      matrix: entityObj.matrixWorld.clone(),
      shapes
    }
  }
}

function buildColliderDescs(
  searchRoot: THREE.Object3D,
  stopBefore: THREE.Object3D,
  fpPrefix: string
): PhysicsColliderDesc[] {
  const descs: PhysicsColliderDesc[] = []
  searchRoot.traverse((node) => {
    if (!(node instanceof THREE.Mesh)) return
    if (!isGltfInvisibleColliderMesh(node, stopBefore)) return

    node.updateMatrixWorld(true)

    const geometry = node.geometry
    const posAttr = geometry.getAttribute('position')
    if (!posAttr || posAttr.count < 3) return

    const idx = descs.length
    descs.push({
      entity: LANDSCAPE_COLLIDER_ENTITY_BASE + idx,
      kind: 'geometry',
      fingerprint: `${fpPrefix}:inv:collider:${idx}:${node.name}:${geometry.uuid}`,
      matrix: node.matrixWorld.clone(),
      geometry
    })
  })
  return descs
}

type DebugWireframeEntry = {
  key: string
  fingerprint: string
  matrix: THREE.Matrix4
  geometry?: THREE.BufferGeometry
}

function debugWireframeEntries(desc: PhysicsColliderDesc): DebugWireframeEntry[] {
  if (desc.shapes?.length) {
    return desc.shapes.map((shape, i) => {
      _worldMatrix.copy(desc.matrix).multiply(shape.localMatrix)
      return {
        key: `${desc.entity}:${shape.fingerprint}:${i}`,
        fingerprint: shape.fingerprint,
        matrix: _worldMatrix.clone(),
        geometry: shape.geometry
      }
    })
  }

  return [
    {
      key: desc.fingerprint,
      fingerprint: desc.fingerprint,
      matrix: desc.matrix,
      geometry: desc.geometry
    }
  ]
}

function colliderPoseFp(matrix: THREE.Matrix4): string {
  return matrix.elements.map((n) => n.toFixed(3)).join(',')
}

function gltfColliderPoseFp(desc: PhysicsColliderDesc): string {
  if (desc.shapes?.length) {
    const parts = [colliderPoseFp(desc.matrix)]
    for (const shape of desc.shapes) parts.push(colliderPoseFp(shape.localMatrix))
    return parts.join('|')
  }
  return colliderPoseFp(desc.matrix)
}

export { colliderPoseFp }

function hasAnyInvisibleColliderMesh(gltfRoot: THREE.Object3D): boolean {
  let found = false
  gltfRoot.traverse((node) => {
    if (found || !(node instanceof THREE.Mesh)) return
    if (isGltfInvisibleColliderMesh(node, gltfRoot)) found = true
  })
  return found
}

function collectMeshNames(root: THREE.Object3D): string[] {
  const names: string[] = []
  root.traverse((node) => {
    if (node instanceof THREE.Mesh) names.push(node.name || '(unnamed)')
  })
  return names.slice(0, 24)
}
