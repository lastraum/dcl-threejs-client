import * as THREE from 'three'
import type { Entity } from '@dcl/ecs'
import { disposeOwnedObject3D } from '../rendering/sharedAsset'

/** Who owns an entity record — scene CRDT, avatar manager, or renderer-reserved. */
export type EntityOwner = 'scene' | 'avatar' | 'renderer'

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

export type EntityRecord = {
  entity: Entity
  owner: EntityOwner
  group: THREE.Group
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
  private readonly owners = new Map<Entity, EntityOwner>()
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

  getOwner(entity: Entity): EntityOwner | undefined {
    return this.owners.get(entity)
  }

  isSceneOwned(entity: Entity): boolean {
    return this.owners.get(entity) === 'scene'
  }

  /** Iterate scene CRDT entities (excludes avatar + reserved store records). */
  forEachSceneEntity(fn: (entity: Entity, group: THREE.Group) => void): void {
    for (const [entity, group] of this.nodes) {
      if (this.owners.get(entity) === 'scene') fn(entity, group)
    }
  }

  getOrCreateNode(entity: Entity, owner: EntityOwner = 'scene'): THREE.Group {
    let group = this.nodes.get(entity)
    if (!group) {
      group = new THREE.Group()
      group.name = `entity:${entity}`
      this.root.add(group)
      this.nodes.set(entity, group)
      this.owners.set(entity, owner)
      this.emit({ entity, kind: 'create' })
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
    if (this.owners.get(entity) !== 'avatar') return
    this.deleteEntity(entity)
  }

  deleteEntity(entity: Entity): void {
    const group = this.nodes.get(entity)
    if (!group) return
    disposeOwnedObject3D(group)
    group.removeFromParent()
    this.nodes.delete(entity)
    this.owners.delete(entity)
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
    this.owners.clear()
    this.listeners.clear()
    this.root.removeFromParent()
  }
}
