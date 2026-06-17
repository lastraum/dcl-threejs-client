import type { Entity } from '@dcl/ecs'
import * as THREE from 'three'
import { sampleAvatarAttachAnchor } from '../avatar/avatarAttachAnchors'
import {
  anchorWorldToRelativeTransform,
  applyWorldDclTransformToObject,
  composeAvatarAttachedWorldTransform
} from '../avatar/avatarAttachMath'
import type { AvatarAttachTargetResolver } from '../avatar/AvatarAttachTargets'
import type { DclTransformValues } from './dclTransform'
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
    private readonly getNodes: () => Map<Entity, THREE.Group> | undefined
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

      const node = nodes.get(entity)
      if (!node) continue

      const playerTransform = resolver.getPlayerTransformDcl(spec.avatarId)
      if (!playerTransform) continue

      const skeleton = this.resolveSkeleton(entity, spec.avatarId, resolver, view)
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

      const relative = anchorWorldToRelativeTransform(
        playerTransform,
        anchorPose.position,
        anchorPose.quaternion,
        existing
      )

      this.projection.setRenderer(Transform.componentId, entity, relative)

      const world = composeAvatarAttachedWorldTransform(playerTransform, relative)
      applyWorldDclTransformToObject(node, world)

      workerBatch.push({
        entity: entity as number,
        position: relative.position,
        rotation: relative.rotation,
        scale: relative.scale
      })

      this.cache.set(entity, {
        avatarId: spec.avatarId,
        anchorPointId: spec.anchorPointId ?? 0
      })
    }

    for (const entity of this.attached) {
      if (!active.has(entity)) {
        this.attached.delete(entity)
        this.cache.delete(entity)
      }
    }

    this.lastWorkerBatch = workerBatch
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