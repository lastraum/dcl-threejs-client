import type { Entity } from '@dcl/ecs'
import * as THREE from 'three'
import { sampleAvatarAttachAnchor } from '../avatar/avatarAttachAnchors'
import {
  anchorWorldToRelativeTransform,
  applyWorldDclTransformToObject,
  composeAvatarAttachedWorldTransform
} from '../avatar/avatarAttachMath'
import type { AvatarAttachTargetResolver } from '../avatar/AvatarAttachTargets'
import { applyDclLocalTransform, type DclTransformValues } from './dclTransform'
import type { CrdtProjection } from './CrdtProjection'
import type { MirrorComponents } from './mirrorComponents'
import type { ProjectionView } from './ProjectionView'

export type PbAvatarAttach = {
  avatarId?: string
  anchorPointId: number
}

export type AvatarAttachWorkerEntry = {
  entity: number
  position: { x: number; y: number; z: number }
  rotation: { x: number; y: number; z: number; w: number }
  scale: { x: number; y: number; z: number }
  /** PlayerEntity (or remote player) — worker Transform parent for world pose parity. */
  parent?: number
}

type CachedBone = {
  avatarId: string | undefined
  anchorPointId: number
}

/**
 * DCL-parity AvatarAttach — writes avatar-relative Transform (projection + worker batch)
 * and applies composed world pose to EntityStore groups.
 */
export class AvatarAttachBridge {
  private readonly attached = new Set<Entity>()
  private readonly cache = new Map<Entity, CachedBone>()
  private targets: AvatarAttachTargetResolver | null = null
  private lastWorkerBatch: AvatarAttachWorkerEntry[] = []

  constructor(
    private readonly ecs: MirrorComponents,
    private readonly projection: CrdtProjection,
    private readonly getNodes: () => Map<Entity, THREE.Group> | undefined,
    /** Scene EntityStore root — attach meshes stay here (Godot-style global pose). */
    private readonly getSceneRoot?: () => THREE.Object3D | null | undefined
  ) {}

  setTargets(resolver: AvatarAttachTargetResolver | null): void {
    this.targets = resolver
  }

  isAttachDriven(entity: Entity): boolean {
    return this.attached.has(entity)
  }

  /** Entries from the latest update — post to worker via SceneScriptSystem. */
  consumeWorkerBatch(): AvatarAttachWorkerEntry[] {
    const batch = this.lastWorkerBatch
    this.lastWorkerBatch = []
    return batch
  }

  update(view: ProjectionView): void {
    const nodes = this.getNodes()
    const resolver = this.targets
    if (!nodes || !resolver) return

    const { AvatarAttach, Transform } = this.ecs
    const active = new Set<Entity>()
    const workerBatch: AvatarAttachWorkerEntry[] = []

    for (const [entity, attach] of view.getEntitiesWith(AvatarAttach)) {
      const spec = attach as PbAvatarAttach
      active.add(entity)
      this.attached.add(entity)

      const ownerId = this.resolveAttachOwnerId(entity, spec.avatarId, resolver, view)
      const playerTransform = resolver.getPlayerTransformDcl(ownerId)
      if (!playerTransform) continue

      const skeleton = this.resolveSkeleton(entity, ownerId, resolver, view)
      if (!skeleton) continue

      const anchorPose = sampleAvatarAttachAnchor(
        skeleton.model,
        spec.anchorPointId ?? 0,
        skeleton.nameTagAnchor
      )
      if (!anchorPose) continue

      const existing = Transform.has(entity)
        ? (Transform.get(entity) as DclTransformValues)
        : undefined

      // Platform law (docs + Tier B): AvatarAttach overwrites Transform with
      // avatar-relative pose (playerWorld * relative ≈ boneWorld). Parent PE so
      // getWorldPosition walks PE × relative. Never PE chest +0.88 reparent on mesh.
      const relative = anchorWorldToRelativeTransform(
        playerTransform,
        anchorPose.position,
        anchorPose.quaternion,
        existing
      )
      const ownerEntity =
        this.resolveAttachOwnerEntity(ownerId, resolver, view) ??
        (existing?.parent && existing.parent !== 0 ? existing.parent : view.PlayerEntity)
      const relativeWithParent: DclTransformValues = {
        ...relative,
        parent: ownerEntity as DclTransformValues['parent']
      }

      this.projection.setRenderer(Transform.componentId, entity, relativeWithParent)

      // Socket-only attach (plaza YI / p_ have no mesh) still needs a Group so
      // Transform children (catch GLB, rod) can parent under the bone pose.
      const node = nodes.get(entity)
      if (node) {
        const sceneRoot = this.getSceneRoot?.()
        if (sceneRoot && node.parent !== sceneRoot) {
          sceneRoot.add(node)
        }
        const world = composeAvatarAttachedWorldTransform(playerTransform, relativeWithParent)
        const scale = relativeWithParent.scale
        applyWorldDclTransformToObject(node, world)
        node.scale.set(scale.x, scale.y, scale.z)
        // Frozen attach sockets (matrixAutoUpdate=false) must bake world so
        // Transform children (catch GLB) compose PE × local this frame.
        node.updateMatrixWorld(true)
        // Plaza f7e: z0 (catch root) + n0 (GLB) are Transform children of YI.
        // Attach owns the socket world pose; children keep ECS local TRS.
        this.syncAttachSubtreeLocals(entity, node, nodes)
        node.updateMatrixWorld(true)
      }

      workerBatch.push({
        entity: entity as number,
        position: relativeWithParent.position,
        rotation: relativeWithParent.rotation,
        scale: relativeWithParent.scale,
        parent: relativeWithParent.parent as number | undefined
      })

      this.cache.set(entity, {
        avatarId: ownerId,
        anchorPointId: spec.anchorPointId ?? 0
      })

      // GP fishing: rod GLB is Transform-child of AvatarAttach root; Visibility toggles on
      // the child (y_/K6e). Re-apply each frame so leave-pond hide is not stuck visible.
      this.syncAttachChildVisibility(entity, nodes)
    }

    for (const entity of this.attached) {
      if (!active.has(entity)) {
        this.attached.delete(entity)
        this.cache.delete(entity)
      }
    }

    this.lastWorkerBatch = workerBatch
  }

  /**
   * Keep ECS-local children (and grandchildren) under the posed attach socket.
   * Plaza catch: YI (LEFT_HAND) → z0 → n0 GLB. Skip would leave the fish at root.
   */
  private syncAttachSubtreeLocals(
    parentEntity: Entity,
    parentNode: THREE.Group,
    nodes: Map<Entity, THREE.Group>,
    depth = 0
  ): void {
    if (depth > 6) return
    const { Transform } = this.ecs
    if (!Transform) return
    for (const [child, node] of nodes) {
      if (child === parentEntity) continue
      if (!Transform.has(child)) continue
      const parent = Transform.get(child).parent as Entity | undefined
      if (parent !== parentEntity) continue
      if (node.parent !== parentNode) parentNode.add(node)
      applyDclLocalTransform(node, Transform.get(child) as DclTransformValues)
      node.matrixAutoUpdate = true
      this.syncAttachSubtreeLocals(child, node, nodes, depth + 1)
    }
  }

  /** Honor VisibilityComponent on Transform children of an AvatarAttach root (rod GLB). */
  private syncAttachChildVisibility(
    attachRoot: Entity,
    nodes: Map<Entity, THREE.Group>
  ): void {
    const { Transform, VisibilityComponent, GltfContainer } = this.ecs
    if (!Transform || !VisibilityComponent) return
    for (const [child, node] of nodes) {
      if (child === attachRoot) continue
      if (!Transform.has(child)) continue
      const parent = Transform.get(child).parent as Entity | undefined
      if (parent !== attachRoot) continue
      if (!VisibilityComponent.has(child)) continue
      const visible = VisibilityComponent.get(child).visible !== false
      node.visible = visible
      if (GltfContainer?.has(child)) {
        node.traverse((o) => {
          if (o !== node && (o as THREE.Mesh).isMesh) o.visible = visible
        })
      }
    }
  }

  /**
   * Owner of an AvatarAttach.
   * Explorer: empty avatarId = local player (plaza `p_` rod / `YI` catch).
   * Remotes always set avatarId (or parent = that player's entity). Empty+no-parent
   * must not skip — that left the won fish unposed while z0 parented to YI.
   */
  private resolveAttachOwnerId(
    entity: Entity,
    avatarId: string | undefined,
    resolver: AvatarAttachTargetResolver,
    view: ProjectionView
  ): string | undefined {
    const id = avatarId?.trim().toLowerCase()
    if (id) return id

    const { Transform, PlayerIdentityData } = this.ecs
    if (Transform?.has(entity)) {
      const parent = Transform.get(entity).parent as Entity | undefined
      if (parent != null && parent !== 0) {
        if (parent === view.PlayerEntity) return resolver.getLocalWallet()?.toLowerCase()
        if (PlayerIdentityData?.has(parent)) {
          const address = (PlayerIdentityData.get(parent) as { address?: string }).address
          if (address) return address.toLowerCase()
        }
      }
    }
    return resolver.getLocalWallet()?.toLowerCase()
  }

  private resolveAttachOwnerEntity(
    ownerId: string | undefined,
    resolver: AvatarAttachTargetResolver,
    view: ProjectionView
  ): Entity | undefined {
    const localWallet = resolver.getLocalWallet()?.toLowerCase()
    const id = ownerId?.trim().toLowerCase()
    if (!id || (localWallet && id === localWallet)) return view.PlayerEntity
    const { PlayerIdentityData } = this.ecs
    if (!PlayerIdentityData) return undefined
    for (const [playerEntity, identity] of view.getEntitiesWith(PlayerIdentityData)) {
      const address = (identity as { address?: string }).address?.toLowerCase()
      if (address === id) return playerEntity
    }
    return undefined
  }

  private resolveSkeleton(
    _entity: Entity,
    avatarId: string | undefined,
    resolver: AvatarAttachTargetResolver,
    view: ProjectionView
  ) {
    const localWallet = resolver.getLocalWallet()?.toLowerCase()
    const id = avatarId?.trim().toLowerCase()

    if (!id || (localWallet && id === localWallet)) {
      return resolver.getLocalSkeleton()
    }

    const remote = resolver.getRemoteSkeleton(id)
    if (remote) return remote

    const { PlayerIdentityData } = this.ecs
    for (const [playerEntity, identity] of view.getEntitiesWith(PlayerIdentityData)) {
      const address = (identity as { address?: string }).address?.toLowerCase()
      if (address !== id) continue
      const npc = resolver.getNpcSkeleton(playerEntity)
      if (npc) return npc
    }

    return resolver.getRemoteSkeleton(id)
  }

  dispose(): void {
    this.attached.clear()
    this.cache.clear()
    this.lastWorkerBatch = []
    this.targets = null
  }
}