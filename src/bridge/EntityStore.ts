import * as THREE from 'three'
import type { Entity } from '@dcl/ecs'
import { disposeOwnedObject3D } from '../rendering/sharedAsset'

/** Who owns an entity record — scene CRDT, avatar manager, or renderer-reserved. */
export type EntityOwner = 'scene' | 'avatar' | 'renderer'

/** Scene entity between DELETE_ENTITY and the next revive PUT (sprite pool recycle). */
export type EntityLifecycle = 'active' | 'suspended'

export type EntityFlags = {
  /** Plane + animated MeshRenderer UVs, non-interactive — DCL sprite pool pattern. */
  spritePool: boolean
  /** ECS Billboard component — camera-facing rotation hot path. */
  billboard: boolean
  /** Active TweenBridge runtime entry — transform refresh hot path. */
  tween: boolean
}

const DEFAULT_FLAGS = (): EntityFlags => ({
  spritePool: false,
  billboard: false,
  tween: false
})

/** Synthetic entity ids for comms-driven avatars (outside scene CRDT id space). */
const AVATAR_ENTITY_BASE = 0x8000_0000

/** Stable synthetic `Entity` for a remote peer wallet address. */
export function avatarEntityFromAddress(address: string): Entity {
  const key = address.trim().toLowerCase()
  let hash = 2_166_136_261
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i)
    hash = Math.imul(hash, 1_677_7619)
  }
  return (AVATAR_ENTITY_BASE | (hash >>> 0)) as Entity
}

export type EntityStoreChangeKind = 'create' | 'destroy' | 'put' | 'delete'

export type EntityStoreChange = {
  entity: Entity
  componentId?: number
  kind: EntityStoreChangeKind
}

type EntityMeta = {
  owner: EntityOwner
  lifecycle: EntityLifecycle
  flags: EntityFlags
}

/**
 * Phase 4 — unified Three.js-backed entity store (REARCHITECTURE_PLAN.md §5A).
 *
 * Each entity's `THREE.Group` is the authoritative scene-graph node. CRDT-driven
 * Transform / visibility / light patches go through `applySceneDiff` in
 * `entityStoreApply.ts`; mesh attach remains in `ThreeBridge` (notifies store
 * when GLB/primitive/material land). Remote peers register via `upsertAvatar`.
 * Animator/AvatarShape async bridges subscribe to the same change notifications.
 */
export class EntityStore {
  readonly root: THREE.Group
  /** entity → scene-graph node (authoritative for renderer-side entity visuals). */
  readonly nodes = new Map<Entity, THREE.Group>()
  private readonly meta = new Map<Entity, EntityMeta>()
  private readonly listeners = new Set<(change: EntityStoreChange) => void>()

  constructor(parent: THREE.Object3D, rootName = 'entity-store') {
    this.root = new THREE.Group()
    this.root.name = rootName
    parent.add(this.root)
  }

  subscribe(listener: (change: EntityStoreChange) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit(change: EntityStoreChange): void {
    for (const listener of this.listeners) {
      listener(change)
    }
  }

  private ensureMeta(entity: Entity, owner: EntityOwner): EntityMeta {
    let record = this.meta.get(entity)
    if (!record) {
      record = { owner, lifecycle: 'active', flags: DEFAULT_FLAGS() }
      this.meta.set(entity, record)
    }
    return record
  }

  /** Flag-only meta for entities whose node may land later (billboard/tween diff). */
  private ensureFlagMeta(entity: Entity): EntityMeta {
    return this.ensureMeta(entity, this.getOwner(entity) ?? 'scene')
  }

  getOwner(entity: Entity): EntityOwner | undefined {
    return this.meta.get(entity)?.owner
  }

  isSceneOwned(entity: Entity): boolean {
    return this.meta.get(entity)?.owner === 'scene'
  }

  isSuspended(entity: Entity): boolean {
    return this.meta.get(entity)?.lifecycle === 'suspended'
  }

  isSpritePool(entity: Entity): boolean {
    return this.meta.get(entity)?.flags.spritePool === true
  }

  /**
   * Sprite pool slots may receive MeshRenderer/Material PUTs without Transform
   * only after DELETE_ENTITY suspend — not for active scene entities.
   */
  allowTransformless(entity: Entity): boolean {
    if (!this.isSceneOwned(entity) || !this.nodes.has(entity)) return false
    return this.isSpritePool(entity) && this.isSuspended(entity)
  }

  setSpritePool(entity: Entity, enabled: boolean): void {
    if (!this.nodes.has(entity)) return
    const record = this.ensureMeta(entity, this.getOwner(entity) ?? 'scene')
    record.flags.spritePool = enabled
    if (!enabled && record.lifecycle === 'suspended') record.lifecycle = 'active'
  }

  setBillboard(entity: Entity, enabled: boolean): void {
    this.ensureFlagMeta(entity).flags.billboard = enabled
  }

  setTween(entity: Entity, enabled: boolean): void {
    this.ensureFlagMeta(entity).flags.tween = enabled
  }

  /** Hide-and-keep-node recycle — no destroy notification (sprite pool). */
  suspendSceneEntity(entity: Entity): void {
    if (!this.isSceneOwned(entity)) return
    const record = this.ensureMeta(entity, 'scene')
    record.lifecycle = 'suspended'
  }

  reviveSceneEntity(entity: Entity): void {
    const record = this.meta.get(entity)
    if (!record || record.owner !== 'scene') return
    record.lifecycle = 'active'
  }

  getBillboardEntities(): Entity[] {
    const out: Entity[] = []
    for (const [entity, record] of this.meta) {
      if (record.flags.billboard && this.nodes.has(entity)) out.push(entity)
    }
    return out
  }

  forEachSpritePool(fn: (entity: Entity, group: THREE.Group) => void): void {
    for (const [entity, group] of this.nodes) {
      if (this.meta.get(entity)?.flags.spritePool) fn(entity, group)
    }
  }

  /** Iterate scene CRDT entities (excludes avatar + reserved store records). */
  forEachSceneEntity(fn: (entity: Entity, group: THREE.Group) => void): void {
    for (const [entity, group] of this.nodes) {
      if (this.isSceneOwned(entity)) fn(entity, group)
    }
  }

  getOrCreateNode(entity: Entity, owner: EntityOwner = 'scene'): THREE.Group {
    let group = this.nodes.get(entity)
    if (!group) {
      group = new THREE.Group()
      group.name = `entity:${entity}`
      this.root.add(group)
      this.nodes.set(entity, group)
      this.ensureMeta(entity, owner)
      this.emit({ entity, kind: 'create' })
    } else {
      this.ensureMeta(entity, owner)
    }
    return group
  }

  getNode(entity: Entity): THREE.Group | undefined {
    return this.nodes.get(entity)
  }

  has(entity: Entity): boolean {
    return this.nodes.has(entity)
  }

  /** Register or fetch the scene-graph node for a comms/profile avatar (owner `'avatar'`). */
  upsertAvatar(entity: Entity): THREE.Group {
    return this.getOrCreateNode(entity, 'avatar')
  }

  removeAvatar(entity: Entity): void {
    if (this.getOwner(entity) !== 'avatar') return
    this.deleteEntity(entity)
  }

  deleteEntity(entity: Entity): void {
    const group = this.nodes.get(entity)
    if (!group) return
    disposeOwnedObject3D(group)
    group.removeFromParent()
    this.nodes.delete(entity)
    this.meta.delete(entity)
    this.emit({ entity, kind: 'destroy' })
  }

  /** Notify secondary systems (collision, pointer targets, hydration) of a component patch. */
  notifyComponentChange(entity: Entity, componentId: number, kind: 'put' | 'delete'): void {
    this.emit({ entity, componentId, kind })
  }

  dispose(): void {
    for (const group of this.nodes.values()) {
      disposeOwnedObject3D(group)
      group.removeFromParent()
    }
    this.nodes.clear()
    this.meta.clear()
    this.listeners.clear()
    this.root.removeFromParent()
  }
}