import type { Entity } from '@dcl/ecs'
import type { EntityStore } from './EntityStore'
import type { MirrorComponents } from './mirrorComponents'
import type { ProjectionChangeKind } from './CrdtProjection'
import type { ProjectionView } from './ProjectionView'
import {
  applyDclLocalTransform,
  expandTransformAncestors,
  isSceneRootParent,
  resolveTransformParent,
  sortEntitiesByTransformDepth,
  type ReservedTransformAnchors
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

const MESH_COMPONENT_NAMES = [
  'GltfContainer',
  'MeshRenderer',
  'TextShape',
  'Material',
  'NftShape',
  'GltfNodeModifiers'
] as const

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
  /** Skip collision/pointer/bridge store notifications (campfire sprite pool — no colliders). */
  skipSecondaryNotify?: (entity: Entity) => boolean
  /**
   * Sprite pool recycle — process MeshRenderer/Material PUTs while Transform is absent;
   * only treat as removal on delete-only batches.
   */
  allowTransformless?: (entity: Entity) => boolean
  /** Live player/camera roots for Transform.parent = PlayerEntity / CameraEntity. */
  reservedAnchors?: ReservedTransformAnchors | null
  /** Track entities parented to reserved anchors (tiny set for cheap later sync). */
  onReservedParent?: (entity: Entity, parent: Entity | undefined, view: ProjectionView) => void
  /** Extract GPU objects onto drawRoot (pose Groups are not in the scene). */
  bindDrawVisual?: (pose: import('three').Object3D, visual: import('three').Object3D) => void
  unbindDrawVisual?: (pose: import('three').Object3D) => void
}

function notifyKind(kind: ProjectionChangeKind): 'put' | 'delete' {
  return kind === 'delete' ? 'delete' : 'put'
}

/**
 * Attach `entity` under its ECS Transform.parent and write local TRS.
 * Ancestors must already exist in `store.nodes` (see expandTransformAncestors + depth sort).
 */
function applyEntityLocalTransform(
  store: EntityStore,
  entity: Entity,
  view: ProjectionView,
  Transform: MirrorComponents['Transform'],
  reservedAnchors: ReservedTransformAnchors | null,
  skipLocal: boolean
): void {
  const obj = store.getOrCreateNode(entity)
  // AvatarAttach (and similar) owns world pose on the renderer. Do not reparent under
  // PlayerEntity→chest attach (+0.88m) or overwrite TRS — that parks bone-world coords as
  // local under the elevated root (plaza fishing rod / line huge offset).
  if (skipLocal) return

  const t = Transform.get(entity)
  const parentId = t.parent as Entity | undefined
  const desiredParent = resolveTransformParent(
    parentId,
    view,
    store.nodes,
    store.root,
    reservedAnchors
  )
  if (obj.parent !== desiredParent) desiredParent.add(obj)
  applyDclLocalTransform(obj, t)
}

/**
 * Phase 4 — apply renderer-driving CRDT diff directly on EntityStore nodes.
 * Transform, VisibilityComponent, and LightSource mutate `THREE.Group` in place.
 * Mesh/collider/pointer diffs emit store notifications for secondary systems.
 *
 * Transform hierarchy is authoritative ECS → scene graph:
 * 1. Expand partial batches with all Transform ancestors (parent before child).
 * 2. Depth-sort and apply parent + local TRS (same path for meshes, lights, TriggerAreas).
 * 3. Re-link any existing store children whose parent was in this batch.
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
  const skipSecondaryNotify = options.skipSecondaryNotify
  const allowTransformless = options.allowTransformless
  const reservedAnchors = options.reservedAnchors ?? null
  const onReservedParent = options.onReservedParent
  const shouldNotify = (entity: Entity): boolean =>
    notifySecondary && !skipSecondaryNotify?.(entity)
  const { Transform, VisibilityComponent, LightSource, Name } = components
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
      if (allowTransformless?.(entity)) {
        const hasPut = [...comps.values()].some((kind) => kind !== 'delete')
        if (!hasPut && store.has(entity) && store.isSceneOwned(entity)) {
          removals.push(entity)
          continue
        }
        store.getOrCreateNode(entity)
        diffEntities.add(entity)
        const obj = store.getNode(entity)
        if (obj) {
          const vis = VisibilityComponent.has(entity)
            ? VisibilityComponent.get(entity).visible !== false
            : true
          obj.visible = vis
          const drawn = obj.userData.dclDrawVisual as { visible: boolean } | undefined
          if (drawn) drawn.visible = vis
        }
        for (const [componentId, kind] of comps) {
          if (meshComponentIds.has(componentId)) meshDirty.add(entity)
          if (!shouldNotify(entity)) continue
          if (secondaryNotifyIds.has(componentId) || bridgeNotifyIds.has(componentId)) {
            store.notifyComponentChange(entity, componentId, notifyKind(kind))
          }
        }
        continue
      }
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

  // Partial CRDT: child-only puts must still create/update parents first so
  // resolveTransformParent finds the parent Group (not sceneRoot + local coords).
  expandTransformAncestors(upsertSet, Transform, view)
  for (const entity of upsertSet) {
    if (isReserved(entity, view)) continue
    if (!Transform.has(entity)) continue
    store.getOrCreateNode(entity)
  }

  const sorted = sortEntitiesByTransformDepth([...upsertSet], Transform)
  for (const entity of sorted) {
    if (isReserved(entity, view)) continue
    if (!Transform.has(entity)) continue

    const t = Transform.get(entity)
    const parentId = t.parent as Entity | undefined
    onReservedParent?.(entity, parentId, view)
    applyEntityLocalTransform(
      store,
      entity,
      view,
      Transform,
      reservedAnchors,
      skipTransformApply?.(entity) === true
    )

    const obj = store.getNode(entity)
    if (!obj) continue

    const vis = VisibilityComponent.has(entity)
      ? VisibilityComponent.get(entity).visible !== false
      : true
    obj.visible = vis
    const drawn = obj.userData.dclDrawVisual as { visible: boolean } | undefined
    if (drawn) drawn.visible = vis

    // core-schema::Name — debug / tooling label on the Three.js group (Explorer entity name).
    if (Name.has(entity)) {
      const n = Name.get(entity).value?.trim()
      if (n) obj.name = n
    }

    const lk = lightKey(entity)
    if (LightSource.has(entity)) {
      syncLightSource(obj, lk, LightSource.get(entity), options.bindDrawVisual)
    } else {
      removeLightSource(obj, lk, options.unbindDrawVisual)
    }

    // Tween refresh entities — notify Transform so collider pose dirty propagates on-change.
    if (shouldNotify(entity) && diffEntities.has(entity)) {
      store.notifyComponentChange(entity, Transform.componentId, 'put')
    }
  }

  // Parent pose/structure changed: re-link every existing child whose ECS parent is in this batch.
  // Children not in the batch keep their local TRS; only the Three parent pointer is fixed.
  if (upsertSet.size > 0) {
    for (const [entity, obj] of store.nodes) {
      if (isReserved(entity, view)) continue
      if (!Transform.has(entity)) continue
      if (skipTransformApply?.(entity)) continue
      const t = Transform.get(entity)
      const parentId = t.parent as Entity | undefined
      if (isSceneRootParent(parentId, view)) continue
      if (!upsertSet.has(parentId as Entity)) continue
      const desiredParent = resolveTransformParent(
        parentId,
        view,
        store.nodes,
        store.root,
        reservedAnchors
      )
      if (obj.parent !== desiredParent) desiredParent.add(obj)
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
