import * as THREE from 'three'
import type { Entity } from '@dcl/ecs'
import type { MirrorComponents } from '../bridge/mirrorComponents'
import type { ProjectionView } from '../bridge/ProjectionView'
import type { PhysicsColliderDesc, PhysicsColliderShapeDesc } from '../physics/PhysXWorld'
import { physxColliderDebug } from '../debug/PhysxColliderDebug'
import { ColliderLayer, hasColliderLayer } from './ColliderLayer'
import {
  gltfMeshContributesPhysics,
  isGltfInvisibleColliderMesh,
  isGltfVisibleClassMesh
} from './gltfColliderNaming'
import { gltfEntityDrawRoot } from './gltfPointerMeshes'
import {
  INSTANCE_COLLIDER_SHAPES_KEY,
  type InstanceColliderShape
} from '../rendering/SceneGltfInstancer'
import { bakeTrimeshGeometry } from '../physics/bakeTrimeshGeometry'
import { filterAndMaybeCompactGltfColliderShapes } from './compactGltfColliderShapes'
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
  /** Live GLB `_collider` meshes painted for debug — restore materials when toggle off. */
  private readonly sourceColliderBackup = new Map<
    THREE.Mesh,
    { material: THREE.Material | THREE.Material[]; visible: boolean; renderOrder: number }
  >()
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
  /** Fired when a GltfContainer extract is dropped — PhysX must removeStatic (freezeRemoval skips orphans). */
  private onRemoved: ((entity: Entity) => void) | null = null

  private static emptyFingerprint = '__empty__'

  constructor(scene: THREE.Scene) {
    this.debugRoot = new THREE.Group()
    this.debugRoot.name = 'gltf-collider-debug'
    this.debugRoot.visible = false
    scene.add(this.debugRoot)
    this.unsubscribeDebug = physxColliderDebug.subscribe(() => this.syncDebugVisibility())
  }

  setOnRemoved(callback: ((entity: Entity) => void) | null): void {
    this.onRemoved = callback
  }

  dispose(): void {
    this.onRemoved = null
    this.unsubscribeDebug()
    this.landscapeRoot = null
    this.restoreSourceColliderDebug()
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
      const instanceShapes = obj.userData[INSTANCE_COLLIDER_SHAPES_KEY] as
        | InstanceColliderShape[]
        | undefined
      const gltfMesh = resolveGltfColliderMesh(obj, entity)
      if (!gltfMesh && !instanceShapes?.length && !obj.userData.dclInstanced) continue
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

    // GPU instances: marker Group is named `__mesh_*` but has no geometry — use template
    // collider shapes. Must run before mesh-required extract (plaza lamps/pipes).
    const instanceShapes = obj.userData[INSTANCE_COLLIDER_SHAPES_KEY] as
      | InstanceColliderShape[]
      | undefined
    // DrawWorld parents `__mesh_*` under drawRoot — pose children are empty.
    // Tween / PE leave GPU instancing, so instance shapes are gone and we must
    // extract visible-mesh CL_PHYSICS from the drawn tree (late-spawn tiles).
    const gltfMesh = resolveGltfColliderMesh(obj, entity)
    // Orphan marker (promote wiped shapes but left empty Group) — not a real mesh tree.
    // Treat as not-ready so we don't cook 0 shapes and seal forever with floors≈0.
    const orphanMarker =
      !!gltfMesh?.userData.dclInstanceMarker &&
      !obj.userData.dclInstanced &&
      !(instanceShapes?.length)
    if (orphanMarker) return false
    const isInstance = !!obj.userData.dclInstanced || !!instanceShapes?.length
    if (!gltfMesh && !isInstance) return false

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
      (isInstance || state.mesh === gltfMesh) &&
      state.geomKey === prevGeom &&
      state.maskKey === maskKey
    ) {
      this.syncColliderEntityPose(entity, entityNodes)
      return true
    }

    // Animator PART needs per-mesh locals. Static rest may compact vis/inv hulls.
    const compactStatic = !ecs.Animator?.has(entity)

    // Instanced: template shapes + entity world pose. Clone: traverse __mesh_* tree.
    const desc = instanceShapes?.length
      ? this.extractColliderDescFromInstanceShapes(
          entity,
          obj,
          instanceShapes,
          hasVisiblePhysics,
          hasInvisiblePhysics,
          compactStatic
        )
      : gltfMesh
        ? this.extractColliderDesc(
            entity,
            gltfMesh,
            obj,
            hasVisiblePhysics,
            hasInvisiblePhysics,
            compactStatic
          )
        : null

    if (
      !desc &&
      !hasVisiblePhysics &&
      !hasInvisiblePhysics &&
      !instanceShapes?.length &&
      (!gltfMesh || !hasAnyInvisibleColliderMesh(gltfMesh))
    ) {
      this.removeColliderEntity(entity)
      return true
    }

    const geomKey = desc?.shapes?.length
      ? desc.shapes.map((s) => s.fingerprint).join('|')
      : GltfColliderExtractor.emptyFingerprint
    const geomChanged = prevGeom !== geomKey

    if (geomChanged && gltfMesh) {
      this.fingerprints.set(entity, geomKey)
      this.logEntityOnce(entity, gltfData.src, invisibleMask, visibleMask, desc, gltfMesh)
    } else if (geomChanged) {
      this.fingerprints.set(entity, geomKey)
    }

    if (desc) {
      const prev = this.extracted.get(entity)
      if (prev && prev !== desc) disposeCompactedColliderShapes(prev)
      this.extracted.set(entity, desc)
      this.syncState.set(entity, {
        geomKey,
        maskKey,
        mesh: gltfMesh ?? obj,
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
   * @param allowShapeMotion follow animated `_collider` child meshes (any active Animator clip —
   *   loop or one-shot). When false, only the entity-root matrix is refreshed.
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
    const gltfMesh = state?.mesh ?? resolveGltfColliderMesh(obj, entity)
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
    const fp = this.getColliderMeshWorldFingerprint(entity)
    if (!fp) return false
    const prev = this.lastColliderMeshWorldFp.get(entity)
    if (prev === fp) return false
    this.lastColliderMeshWorldFp.set(entity, fp)
    return true
  }

  /**
   * Live world-pose fingerprint of extracted `_collider` / physics meshes.
   * PART gate: digits=2 so sub-centimetre / float noise does not thrash world cooks.
   */
  getColliderMeshWorldFingerprint(entity: Entity, digits = 2): string | null {
    const state = this.syncState.get(entity)
    if (!state) return null
    return this.colliderMeshWorldFingerprint(
      state.mesh,
      state.hasVisiblePhysics,
      state.hasInvisiblePhysics,
      digits
    )
  }

  /**
   * Force rewrite shape local matrices from live mesh/bone worlds (Animator PART).
   * Returns multi-shape pose fingerprint string for change detection, or null.
   */
  forceRefreshAnimatedShapeLocals(
    entity: Entity,
    entityNodes: Map<Entity, THREE.Group>
  ): string | null {
    const stored = this.extracted.get(entity)
    const obj = entityNodes.get(entity)
    if (!stored?.shapes?.length || !obj) return null
    const state = this.syncState.get(entity)
    const gltfMesh = state?.mesh ?? resolveGltfColliderMesh(obj, entity)
    if (!gltfMesh || !state) return null
    obj.updateMatrixWorld(true)
    gltfMesh.updateMatrixWorld(true)
    this.refreshShapeLocalMatrices(
      gltfMesh,
      obj,
      stored.shapes,
      state.hasVisiblePhysics,
      state.hasInvisiblePhysics
    )
    stored.matrix.copy(obj.matrixWorld)
    const fp = gltfColliderPoseFp(stored)
    this.poseFingerprints.set(entity, fp)
    return fp
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
      // MeshRenderer primitives / GPU instances are not GltfContainer visible art.
      // Cooking them here invents CL_PHYSICS on setBox snow cells (scene never adds MeshCollider).
      if ((node as THREE.InstancedMesh).isInstancedMesh) return
      if (
        node.userData.primitiveMeshKey ||
        node.userData.dclMeshRendererInstance ||
        node.userData.dclMeshRendererInstanced
      ) {
        return
      }
      // ADR-215: inv = `*_collider` name/ancestry only. vis/unnamed never cook from
      // invisibleMeshesCollisionMask (water_cube_wrap Cube @ 126,104 vis=0 inv=3).
      if (gltfMeshContributesPhysics(node, gltfRoot, hasVisiblePhysics, hasInvisiblePhysics)) {
        colliderMeshes.push(node)
      }
    })
    return colliderMeshes
  }

  /**
   * Full world matrix fingerprint for collider child meshes.
   * Translation-only fingerprints miss hinged doors (pivot origin fixed while panel rotates).
   *
   * @param digits quantize — PART gate uses 2 (~1cm / small angle) so float noise does not
   *   re-cook every frame; diagnostics can use 3.
   */
  private colliderMeshWorldFingerprint(
    gltfRoot: THREE.Object3D,
    hasVisiblePhysics: boolean,
    hasInvisiblePhysics: boolean,
    digits = 3
  ): string | null {
    const meshes = this.collectColliderMeshes(gltfRoot, hasVisiblePhysics, hasInvisiblePhysics)
    if (!meshes.length) return null
    const parts: string[] = []
    const d = digits
    for (const mesh of meshes) {
      const e = this.colliderMeshWorldMatrix(mesh).elements
      // 12 floats of the 4x3 affine block — enough for T+R+S without full 16.
      parts.push(
        `${e[0]!.toFixed(d)},${e[1]!.toFixed(d)},${e[2]!.toFixed(d)},` +
          `${e[4]!.toFixed(d)},${e[5]!.toFixed(d)},${e[6]!.toFixed(d)},` +
          `${e[8]!.toFixed(d)},${e[9]!.toFixed(d)},${e[10]!.toFixed(d)},` +
          `${e[12]!.toFixed(d)},${e[13]!.toFixed(d)},${e[14]!.toFixed(d)}`
      )
    }
    return parts.join('|')
  }

  /**
   * World matrix for a physics mesh.
   * - Skinned `_collider` panels often leave mesh.matrixWorld fixed while bones drive the
   *   visual — use bone/parent bone world then.
   * - Rigid meshes parented under an animated Bone (curtains_1: Curtain/Pole under Bone,
   *   not SkinnedMesh) already include the bone in mesh.matrixWorld after updateMatrixWorld;
   *   we still force parent bone updates so PART cooks match the raised pose.
   */
  private colliderMeshWorldMatrix(mesh: THREE.Mesh): THREE.Matrix4 {
    // Walk up and refresh animated bones first (hierarchy can be Bone → mesh, no skin).
    let p: THREE.Object3D | null = mesh.parent
    for (let i = 0; i < 12 && p; i++) {
      if ((p as THREE.Bone).isBone || /^(bone|joint|hinge)/i.test(p.name)) {
        p.updateMatrixWorld(true)
      }
      p = p.parent
    }
    mesh.updateMatrixWorld(true)
    const sk = mesh as THREE.SkinnedMesh
    if (sk.isSkinnedMesh && sk.skeleton) {
      sk.skeleton.update()
      const parent = mesh.parent
      if (parent) {
        parent.updateMatrixWorld(true)
        // Bone-parented panel: parent (joint) carries the open/close rotation.
        if ((parent as THREE.Bone).isBone || /bone|joint|door|hinge/i.test(parent.name)) {
          return parent.matrixWorld
        }
      }
      // Fallback: first bone that moved from bind (common single-bone door skins).
      const bones = sk.skeleton.bones
      if (bones.length > 0) {
        bones[0]!.updateMatrixWorld(true)
        return bones[0]!.matrixWorld
      }
    }
    return mesh.matrixWorld
  }

  /**
   * Animator GLTF — child `_collider` / physics meshes move with clips (ice-rink doors, lifts).
   * Matches shapes by geometry.uuid from fingerprint (not fragile traverse index order).
   * Caller must have updated the GLB hierarchy matrixWorld after mixer.update.
   */
  private refreshShapeLocalMatrices(
    gltfRoot: THREE.Object3D,
    entityObj: THREE.Object3D,
    shapes: PhysicsColliderShapeDesc[],
    hasVisiblePhysics: boolean,
    hasInvisiblePhysics: boolean
  ): boolean {
    // Full hierarchy from entity root so bone-parented `_collider` children get live poses.
    entityObj.updateMatrixWorld(true)
    gltfRoot.updateMatrixWorld(true)

    const colliderMeshes = this.collectColliderMeshes(gltfRoot, hasVisiblePhysics, hasInvisiblePhysics)
    const eligible: THREE.Mesh[] = []
    const byName = new Map<string, THREE.Mesh>()
    for (const mesh of colliderMeshes) {
      const posAttr = mesh.geometry.getAttribute('position')
      if (!posAttr || posAttr.count < 3) continue
      eligible.push(mesh)
      if (mesh.name) byName.set(mesh.name, mesh)
    }
    if (!eligible.length) return false

    _entityInv.copy(entityObj.matrixWorld).invert()
    let changed = false
    for (let i = 0; i < shapes.length; i++) {
      const shape = shapes[i]!
      // fingerprint: gltf:inv|vis:entity:idx:meshName:vertCount:indexCount
      const parts = shape.fingerprint.split(':')
      // Mesh name sits between idx and the two trailing count tokens.
      const meshName = parts.length >= 7 ? parts.slice(4, -2).join(':') : ''
      const mesh =
        (meshName && byName.get(meshName)) ||
        // Index fallback: same traverse order as extract (door remount edge cases).
        (i < eligible.length ? eligible[i]! : null)
      if (!mesh) continue
      _worldMatrix.copy(this.colliderMeshWorldMatrix(mesh)).premultiply(_entityInv)
      const nextFp = colliderPoseFp(_worldMatrix)
      if (colliderPoseFp(shape.localMatrix) !== nextFp) {
        shape.localMatrix.copy(_worldMatrix)
        changed = true
      }
    }
    // Only report change when a localMatrix actually moved (doors). Returning matched>0
    // forced PhysX rewrites every frame for idle multi-shape buildings and softed plaza.
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
    disposeCompactedColliderShapes(this.extracted.get(entity))
    this.extracted.delete(entity)
    this.fingerprints.delete(entity)
    this.poseFingerprints.delete(entity)
    this.syncState.delete(entity)
    this.lastColliderMeshWorldFp.delete(entity)
    this.walkSurfaceSnapshotPos.delete(entity)
    this.frameWalkSurfaceDelta.delete(entity)
    this.onRemoved?.(entity)
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

  /**
   * Per-entity extract summary (once). Always console — mask mis-config and missed
   * ancestry `_collider` floors are otherwise silent (SpaceRunner lobby floors≈0).
   */
  private logEntityOnce(
    entity: Entity,
    src: string,
    invisibleMask: number,
    visibleMask: number,
    desc: PhysicsColliderDesc | null,
    gltfMesh: THREE.Object3D
  ): void {
    if (this.loggedEntities.has(entity)) return
    this.loggedEntities.add(entity)

    const shapeCount = desc?.shapes?.length ?? 0
    const invCount = desc?.shapes?.filter((s) => s.fingerprint.includes(':inv:')).length ?? 0
    const visCount = desc?.shapes?.filter((s) => s.fingerprint.includes(':vis:')).length ?? 0
    let meshTotal = 0
    let meshInvClass = 0
    let meshVisClass = 0
    gltfMesh.traverse((node) => {
      if (!(node instanceof THREE.Mesh)) return
      meshTotal++
      if (isGltfInvisibleColliderMesh(node, gltfMesh)) meshInvClass++
      else if (isGltfVisibleClassMesh(node, gltfMesh)) meshVisClass++
    })
    // Decorative pool VFX (disco_cell, star, drop) — inv mask set but only visible-class
    // meshes → expected shapes=0. Logging hundreds of these froze the fishing dock UI.
    if (
      shapeCount === 0 &&
      meshInvClass === 0 &&
      !hasColliderLayer(visibleMask, ColliderLayer.CL_PHYSICS)
    ) {
      return
    }
    if (!physxColliderDebug.isGltfCollidersVisible()) return
    const shortSrc = src.length > 64 ? `…${src.slice(-48)}` : src
    const msg =
      `[GltfCollider] e${entity} src="${shortSrc}" ` +
      `mask inv=${invisibleMask} vis=${visibleMask} ` +
      `meshes=${meshTotal} (invClass=${meshInvClass} visClass=${meshVisClass}) ` +
      `→ shapes=${shapeCount} (inv=${invCount} vis=${visCount})` +
      (shapeCount === 0 ? ` names=[${collectMeshNames(gltfMesh).slice(0, 12).join(', ')}]` : '')
    clientDebugLog.log('collision', msg, {
      alsoConsole: false,
      throttleKey: `gltf-collider:${entity}`
    })
  }

  private syncDebugVisibility(): void {
    if (!physxColliderDebug.isGltfCollidersVisible()) {
      this.clearDebugMeshes()
      this.restoreSourceColliderDebug()
      return
    }

    const descs = this.getPhysicsColliders()
    const solid = physxColliderDebug.isGltfColliderSolids()
    const fp =
      `${solid ? 'solid' : 'wire'}|` +
      descs
        .flatMap((desc) => debugWireframeEntries(desc).map((e) => `${e.key}:${colliderPoseFp(e.matrix)}`))
        .join('|')
    if (fp !== this.debugFingerprint || this.debugMeshes.size === 0) {
      this.debugFingerprint = fp
      this.rebuildDebugMeshes(descs, solid)
    }
    // Always re-apply source-mesh tint (GLB re-attach can restore materials).
    this.applySourceColliderDebug()
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

  /**
   * Paint live GLB `_collider` meshes (source graph) so you see authoring, not only cooked PhysX.
   * Magenta = invisible-class hulls; restores materials when debug is off.
   */
  private applySourceColliderDebug(): void {
    this.restoreSourceColliderDebug()
    if (!physxColliderDebug.isGltfCollidersVisible()) return

    let painted = 0
    for (const state of this.syncState.values()) {
      const root = state.mesh
      root.traverse((node) => {
        if (!(node instanceof THREE.Mesh)) return
        if (!isGltfInvisibleColliderMesh(node, root)) return
        if (this.sourceColliderBackup.has(node)) return
        this.sourceColliderBackup.set(node, {
          material: node.material,
          visible: node.visible,
          renderOrder: node.renderOrder
        })
        node.visible = true
        node.renderOrder = 999
        node.material = new THREE.MeshBasicMaterial({
          color: 0xff22aa,
          transparent: true,
          opacity: 0.55,
          side: THREE.DoubleSide,
          depthTest: true,
          depthWrite: false
        })
        painted++
      })
    }
    if (painted > 0) {
      console.info(
        `[GltfCollider] debug source tint — painted ${painted} live _collider mesh(es) (magenta)`
      )
    }
  }

  private restoreSourceColliderDebug(): void {
    for (const [mesh, prev] of this.sourceColliderBackup) {
      const mat = mesh.material
      mesh.material = prev.material
      mesh.visible = prev.visible
      mesh.renderOrder = prev.renderOrder
      if (mat && mat !== prev.material) {
        if (Array.isArray(mat)) mat.forEach((m) => m.dispose())
        else (mat as THREE.Material).dispose()
      }
    }
    this.sourceColliderBackup.clear()
  }

  private rebuildDebugMeshes(descs: PhysicsColliderDesc[], solid: boolean): void {
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

    // Solid filled = deeper than wireframe: volume of cooked PhysX hulls.
    // Magenta = invisible (_collider) class; cyan = visible-mask physics.
    const matFor = (fingerprint: string) => {
      const inv = fingerprint.includes(':inv:')
      return new THREE.MeshBasicMaterial({
        color: inv ? 0xff22aa : 0x00e5ff,
        wireframe: !solid,
        transparent: true,
        opacity: solid ? (inv ? 0.4 : 0.3) : inv ? 0.55 : 0.4,
        side: THREE.DoubleSide,
        depthTest: true,
        depthWrite: false
      })
    }

    for (const desc of descs) {
      for (const entry of debugWireframeEntries(desc)) {
        const geo = entry.geometry
          ? bakeTrimeshGeometry(entry.geometry, entry.matrix)
          : new THREE.BoxGeometry(1, 1, 1)
        const mesh = new THREE.Mesh(geo, matFor(entry.fingerprint))
        mesh.renderOrder = 998
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
    hasInvisiblePhysics: boolean,
    compactStatic = false
  ): PhysicsColliderDesc | null {
    // Same classification as collectColliderMeshes (ancestry-first _collider → inv).
    const colliderMeshes = this.collectColliderMeshes(
      gltfRoot,
      hasVisiblePhysics,
      hasInvisiblePhysics
    )

    if (!colliderMeshes.length) return null

    entityObj.updateMatrixWorld(true)
    gltfRoot.updateMatrixWorld(true)
    _entityInv.copy(entityObj.matrixWorld).invert()

    const shapes: PhysicsColliderShapeDesc[] = []

    for (const mesh of colliderMeshes) {
      mesh.updateMatrixWorld(true)

      const sourceGeo = mesh.geometry
      const posAttr = sourceGeo.getAttribute('position')
      if (!posAttr || posAttr.count < 3) continue

      _worldMatrix.copy(mesh.matrixWorld).premultiply(_entityInv)

      const invClass = isGltfInvisibleColliderMesh(mesh, gltfRoot)
      // Do NOT key on geometry.uuid — remount/sanitize can mint new UUIDs every frame and
      // thrash multi-shape expand (console spam + 3× load with no collider gain).
      const fp =
        `gltf:${invClass ? 'inv' : 'vis'}:${entity}:${shapes.length}:${mesh.name}:` +
        `${posAttr.count}:${sourceGeo.index?.count ?? 0}`

      // Reference shared AssetCache geometry — PhysX cook clones via bakeTrimeshGeometry.
      shapes.push({
        fingerprint: fp,
        geometry: sourceGeo,
        localMatrix: _worldMatrix.clone()
      })
    }

    const compacted = filterAndMaybeCompactGltfColliderShapes(
      entity as number,
      shapes,
      compactStatic
    )
    if (!compacted.length) return null
    if (compacted.length !== shapes.length) {
      clientDebugLog.log(
        'collision',
        `[GltfCollider] compact e${entity as number} shapes ${shapes.length} → ${compacted.length}` +
          (compactStatic ? ' (static hull)' : ' (uncookable dropped)'),
        { alsoConsole: true, throttleMs: 5000, throttleKey: `gltf-compact:${entity as number}` }
      )
    }

    const geomKey = compacted.map((s) => s.fingerprint).join('|')

    return {
      entity: GLTF_COLLIDER_ENTITY_BASE + entity,
      kind: 'gltf-multi',
      // v3 — entity-local baked geometry + relative per-shape pose slides (Animator walk surfaces).
      fingerprint: `gltf-entity:v3:${entity}:${geomKey}`,
      matrix: entityObj.matrixWorld.clone(),
      shapes: compacted
    }
  }

  /**
   * Instanced GLB path — shapes from shared template (entity-local), actor at entity world pose.
   * Same geometry fingerprint across instances so PhysX can reuse cooked trimeshes.
   */
  private extractColliderDescFromInstanceShapes(
    entity: Entity,
    entityObj: THREE.Object3D,
    instanceShapes: InstanceColliderShape[],
    hasVisiblePhysics: boolean,
    hasInvisiblePhysics: boolean,
    compactStatic = false
  ): PhysicsColliderDesc | null {
    const shapes: PhysicsColliderShapeDesc[] = []
    for (const shape of instanceShapes) {
      // Exhaustive — unknown kind must not fall through into PhysX (invented hulls).
      if (shape.kind === 'inv') {
        if (!hasInvisiblePhysics) continue
      } else if (shape.kind === 'vis' || shape.kind === 'unnamed') {
        if (!hasVisiblePhysics) continue
      } else {
        continue
      }
      shapes.push({
        fingerprint: shape.fingerprint,
        geometry: shape.geometry,
        localMatrix: shape.localMatrix
      })
    }
    const compacted = filterAndMaybeCompactGltfColliderShapes(
      entity as number,
      shapes,
      compactStatic
    )
    if (!compacted.length) return null

    entityObj.updateMatrixWorld(true)
    const geomKey = compacted.map((s) => s.fingerprint).join('|')
    return {
      entity: GLTF_COLLIDER_ENTITY_BASE + entity,
      kind: 'gltf-multi',
      // Shared geom key (no entity id) — cook cache reuses trimeshes across instances.
      fingerprint: `gltf-entity:v3-inst:${geomKey}`,
      matrix: entityObj.matrixWorld.clone(),
      shapes: compacted
    }
  }
}

function disposeCompactedColliderShapes(desc: PhysicsColliderDesc | undefined): void {
  if (!desc?.shapes) return
  for (const shape of desc.shapes) {
    if (!shape.fingerprint.includes(':compact:')) continue
    shape.geometry?.dispose()
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

/** Pose node or DrawWorld visual — Tweened GLBs have no `__mesh_*` under the pose group. */
function resolveGltfColliderMesh(obj: THREE.Object3D, entity: Entity): THREE.Object3D | undefined {
  const drawn = gltfEntityDrawRoot(obj, entity)
  if (drawn) return drawn
  return obj.children.find((c) => c.name.startsWith('__mesh_'))
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
