import type { Entity } from '@dcl/ecs'
import type { EntityStore } from './EntityStore'
import type { MirrorComponents } from './mirrorComponents'
import type { ProjectionChangeKind } from './CrdtProjection'
import type { ProjectionView } from './ProjectionView'
import {
  applyDclLocalTransform,
  resolveTransformParent,
  sortEntitiesByTransformDepth
} from './dclTransform'
import { syncLightSource, removeLightSource } from './LightSourceSync'

function lightKey(entity: Entity): string {
  return `__light_${entity}`
}

function isReserved(entity: Entity, view: ProjectionView): boolean {
  return (
    entity === view.RootEntity || entity === view.PlayerEntity || entity === view.CameraEntity
  )
}

export type ApplySceneDiffResult = {
  /** Entities whose Transform / visibility / light were patched in the store. */
  upserts: Entity[]
  /** Entities whose Transform was removed — caller tears down meshes/materials. */
  removals: Entity[]
  /** Entities needing a mesh/material attach pass (GltfContainer, MeshRenderer, …). */
  meshDirty: Entity[]
}

const MESH_COMPONENT_NAMES = ['GltfContainer', 'MeshRenderer', 'TextShape', 'Material'] as const

/** Components whose CRDT diff should notify collision / pointer subscribers. */
const SECONDARY_NOTIFY_NAMES = [
  ...MESH_COMPONENT_NAMES,
  'MeshCollider',
  'PointerEvents'
] as const

/** Async bridge sync (Animator / AvatarShape) — notify via store, no in-place apply. */
const BRIDGE_NOTIFY_NAMES = ['Animator', 'AvatarShape'] as const

export type ApplySceneDiffOptions = {
  /** When false, skip secondary/bridge notifications (hydration full-walk sets dirty flags explicitly). */
  notifySecondary?: boolean
  /** AvatarAttach-driven entities — renderer owns world pose; skip inbound Transform apply. */
  skipTransformApply?: (entity: Entity) => boolean
  /** Frozen static props — skip Transform apply until thawed (e10). */
  skipFrozenTransform?: (entity: Entity) => boolean
  /** Skip collision/pointer/bridge store notifications (campfire sprite pool — no colliders). */
  skipSecondaryNotify?: (entity: Entity) => boolean
}

function notifyKind(kind: ProjectionChangeKind): 'put' | 'delete' {
  return kind === 'delete' ? 'delete' : 'put'
}

/**
 * Phase 4 — apply renderer-driving CRDT diff directly on EntityStore nodes.
 * Transform, VisibilityComponent, and LightSource mutate `THREE.Group` in place.
 * Mesh/collider/pointer diffs emit store notifications for secondary systems.
 */
export function applySceneDiff(
  store: EntityStore,
  diff: Map<Entity, Map<number, ProjectionChangeKind>>,
  view: ProjectionView,
  components: MirrorComponents,
  tweenRefresh: Entity[] = [],
  options: ApplySceneDiffOptions = {}
): ApplySceneDiffResult {
  const notifySecondary = options.notifySecondary !== false
  const skipTransformApply = options.skipTransformApply
  const skipFrozenTransform = options.skipFrozenTransform
  const skipSecondaryNotify = options.skipSecondaryNotify
  const shouldNotify = (entity: Entity): boolean =>
    notifySecondary && !skipSecondaryNotify?.(entity)
  const { Transform, VisibilityComponent, LightSource } = components
  const meshComponentIds = new Set<number>(
    MESH_COMPONENT_NAMES.map((name) => components[name].componentId)
  )
  const secondaryNotifyIds = new Set<number>(
    SECONDARY_NOTIFY_NAMES.map((name) => components[name].componentId)
  )
  const bridgeNotifyIds = new Set<number>(
    BRIDGE_NOTIFY_NAMES.map((name) => components[name].componentId)
  )

  const upsertSet = new Set<Entity>()
  const diffEntities = new Set<Entity>()
  const removals: Entity[] = []
  const meshDirty = new Set<Entity>()

  for (const [entity, comps] of diff) {
    if (isReserved(entity, view)) continue

    if (!Transform.has(entity)) {
      if (store.has(entity) && store.isSceneOwned(entity)) removals.push(entity)
      continue
    }

    store.getOrCreateNode(entity)
    upsertSet.add(entity)
    diffEntities.add(entity)

    for (const [componentId, kind] of comps) {
      if (meshComponentIds.has(componentId)) meshDirty.add(entity)
      if (!shouldNotify(entity)) continue
      if (secondaryNotifyIds.has(componentId) || bridgeNotifyIds.has(componentId)) {
        store.notifyComponentChange(entity, componentId, notifyKind(kind))
      }
    }
  }

  for (const entity of tweenRefresh) {
    if (isReserved(entity, view) || !store.has(entity)) continue
    if (!Transform.has(entity)) continue
    upsertSet.add(entity)
    diffEntities.add(entity)
  }

  const sorted = sortEntitiesByTransformDepth([...upsertSet], Transform)
  for (const entity of sorted) {
    const obj = store.getNode(entity)
    if (!obj) continue

    const t = Transform.get(entity)
    const desiredParent = resolveTransformParent(t.parent, view, store.nodes, store.root)
    if (obj.parent !== desiredParent) desiredParent.add(obj)
    if (!skipTransformApply?.(entity) && !skipFrozenTransform?.(entity)) {
      applyDclLocalTransform(obj, t)
    }

    obj.visible = VisibilityComponent.has(entity)
      ? VisibilityComponent.get(entity).visible !== false
      : true

    const lk = lightKey(entity)
    if (LightSource.has(entity)) {
      syncLightSource(obj, lk, LightSource.get(entity))
    } else {
      removeLightSource(obj, lk)
    }

    // Tween refresh mutates matrixWorld in place — mark colliderPoseDirty via Transform notify.
    if (shouldNotify(entity) && diffEntities.has(entity)) {
      store.notifyComponentChange(entity, Transform.componentId, 'put')
    }
  }

  if (notifySecondary) {
    for (const entity of removals) {
      if (!shouldNotify(entity)) continue
      store.notifyComponentChange(entity, Transform.componentId, 'delete')
    }
  }

  return {
    upserts: sorted,
    removals,
    meshDirty: [...meshDirty]
  }
}
