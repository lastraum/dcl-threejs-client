import type { Entity, IEngine } from '@dcl/ecs'
import { ReadWriteByteBuffer } from '@dcl/ecs/dist/serialization/ByteBuffer'
import { readMessage } from '@dcl/ecs/dist/serialization/crdt/message'
import { PutComponentOperation } from '@dcl/ecs/dist/serialization/crdt/putComponent'
import { AppendValueOperation } from '@dcl/ecs/dist/serialization/crdt/appendValue'
import { CrdtMessageType } from '@dcl/ecs/dist/serialization/crdt/types'
import type { CrdtMessage } from '@dcl/ecs/dist/serialization/crdt/types'
import { fixTransformParent } from '@dcl/ecs/dist/serialization/crdt/network/utils'
import type { MirrorComponents } from './mirrorComponents'

/** Network identity stored on a local entity (`NetworkEntity` / `NetworkParent` value). */
export type NetworkIdentityValue = {
  networkId: number
  entityId: number
}

/** Minimal schema surface for NetworkEntity / NetworkParent (accepts @dcl/ecs LWW defs). */
type NetworkSchema = {
  deserialize: (reader: ReadWriteByteBuffer) => unknown
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  serialize: (value: any, writer: ReadWriteByteBuffer) => void
}

/** Component defs the projection needs to replicate the engine's network-entity handling. */
export interface ProjectionNetworkDefs {
  /** `core-schema::Network-Entity` — typed schema for parent graph resolution (P3). */
  networkEntity: { componentId: number; schema: NetworkSchema }
  /** `core-schema::Network-Parent` — typed schema for parent graph resolution (P3). */
  networkParent: { componentId: number; schema: NetworkSchema }
}

/**
 * Worker-owned scene UI LWW ids — mount snapshot may force-apply over stale timestamps.
 * Includes PointerEvents only for UI-entity rows in the structured snapshot (entities that
 * also have UiTransform). World PE without UiTransform never appears in that snapshot and
 * continues to use normal CRDT only (not stripped with scene UI).
 */
export const WORKER_OWNED_UI_COMPONENT_IDS = new Set([
  1050, // UiTransform
  1052, // UiText
  1053, // UiBackground
  1093, // UiInput
  1094, // UiDropdown
  1062 // PointerEvents (UI mount snapshot rows only)
])

/** UiBackground / UiText — ensure color.a is a concrete number (0 must not become "missing"). */
function normalizeUiColorFields(componentId: number, value: unknown): unknown {
  if (componentId !== 1052 && componentId !== 1053) return value
  if (value == null || typeof value !== 'object') return value
  const v = value as Record<string, unknown>
  const color = v.color
  if (color == null || typeof color !== 'object') return value
  const c = color as { r?: number; g?: number; b?: number; a?: number }
  const a =
    typeof c.a === 'number' && Number.isFinite(c.a)
      ? c.a
      : Object.prototype.hasOwnProperty.call(c, 'a')
        ? Number(c.a)
        : undefined
  // Only rewrite when we have a finite a (incl. 0) or need to fill a missing a with 1.
  const nextA = typeof a === 'number' && Number.isFinite(a) ? a : 1
  return {
    ...v,
    color: {
      r: typeof c.r === 'number' ? c.r : 0,
      g: typeof c.g === 'number' ? c.g : 0,
      b: typeof c.b === 'number' ? c.b : 0,
      a: nextA
    }
  }
}

/** Commit MainCamera.virtualCameraEntity only once target VC is hydrated on projection. */
export type VirtualCameraProjectionGate = {
  cameraEntity: Entity
  mainCameraComponentId: number
  virtualCameraComponentId: number
}

type PendingMainCameraBind = {
  entity: Entity
  componentId: number
  timestamp: number
  value: unknown
}

/**
 * Phase 1 typed CRDT projection (REARCHITECTURE_PLAN.md §5.1).
 *
 * Decodes the same `crdt-send` bytes the `CrdtMirror` engine consumes, straight
 * into typed `Map`s — no second `@dcl/ecs` `Engine()`, no `engine.update()`. It
 * reuses the SDK's component **schemas** (`deserialize`) and the CRDT wire
 * reader (`readMessage`), so the decode is byte-identical to the engine's.
 *
 * In Phase 1 this runs in **shadow mode** next to the mirror and its output is
 * compared against the engine (`checkProjectionParity`). In later phases this
 * decoder becomes the write path of the unified `EntityStore`.
 */

/** `ComponentType.GrowOnlyValueSet` — `const enum` in @dcl/ecs, inlined here to avoid the value import. */
const COMPONENT_TYPE_GROW_ONLY = 1

export type ProjectionChangeKind = 'put' | 'delete'

export interface ProjectionChange {
  entity: Entity
  componentId: number
  kind: ProjectionChangeKind
}

interface ComponentMeta {
  id: number
  name: string
  growOnly: boolean
  deserialize: (reader: ReadWriteByteBuffer) => unknown
  /** Re-encode a decoded value to wire bytes (boot snapshot). Absent for presence-only passthrough defs. */
  serialize?: (value: unknown, writer: ReadWriteByteBuffer) => void
}

/** Live VC pose lane — outranks async worker CRDT during MOVE CAMERA flight. */
const VC_LIVE_TS_BASE = 10_000_000_000

export class CrdtProjection {
  /** componentId → (entity → latest decoded value). */
  readonly components = new Map<number, Map<Entity, unknown>>()
  /** componentId → (entity → last applied Lamport timestamp). */
  private readonly timestamps = new Map<number, Map<Entity, number>>()
  private vcLiveSeq = 0
  /** Entities holding live Transform priority (bound VC + lookAt/parent follow rig). */
  private readonly vcLiveEntities = new Set<Entity>()
  private readonly meta = new Map<number, ComponentMeta>()
  private readonly deletedEntities = new Set<Entity>()
  /** Change set for the most recent `applyIncoming` (cleared on each call). */
  readonly changes: ProjectionChange[] = []

  private readonly transformId: number
  /** Network-entity book-keeping component ids (so we replicate `fixTransformParent`). */
  private readonly networkEntityId: number | null
  private readonly networkParentId: number | null
  /** Renderer-owned entities — inbound worker Transform must not overwrite (spawn snap). */
  private readonly reservedEntities: ReadonlySet<Entity>
  private readonly virtualCameraGate: VirtualCameraProjectionGate | null
  private pendingMainCameraBind: PendingMainCameraBind | null = null
  /** Pointer uiEntities batch — recycled entity ids must not lose to pre-clear stale LWW rows. */
  private forceWorkerUiPuts = false

  constructor(
    components: MirrorComponents,
    network?: ProjectionNetworkDefs,
    reservedEntities?: ReadonlySet<Entity>,
    virtualCameraGate?: VirtualCameraProjectionGate
  ) {
  for (const def of Object.values(components)) {
    if (!def?.componentId) continue
    const id = def.componentId
      this.meta.set(id, {
        id,
        name: def.componentName,
        growOnly: def.componentType === COMPONENT_TYPE_GROW_ONLY,
        deserialize: (reader) => def.schema.deserialize(reader),
        serialize: (value, writer) => def.schema.serialize(value as never, writer)
      })
      this.components.set(id, new Map())
      this.timestamps.set(id, new Map())
    }
    this.transformId = components.Transform.componentId
    this.networkEntityId = network?.networkEntity?.componentId ?? null
    this.networkParentId = network?.networkParent?.componentId ?? null
    this.reservedEntities = reservedEntities ?? new Set()
    this.virtualCameraGate = virtualCameraGate ?? null
    // Typed NetworkEntity / NetworkParent (P3) — presence + values for parent resolution.
    if (network?.networkEntity && !this.meta.has(network.networkEntity.componentId)) {
      const def = network.networkEntity
      this.meta.set(def.componentId, {
        id: def.componentId,
        name: 'core-schema::Network-Entity',
        growOnly: false,
        deserialize: (reader) => def.schema.deserialize(reader),
        serialize: (value, writer) => def.schema.serialize(value, writer)
      })
      this.components.set(def.componentId, new Map())
      this.timestamps.set(def.componentId, new Map())
    }
    if (network?.networkParent && !this.meta.has(network.networkParent.componentId)) {
      const def = network.networkParent
      this.meta.set(def.componentId, {
        id: def.componentId,
        name: 'core-schema::Network-Parent',
        growOnly: false,
        deserialize: (reader) => def.schema.deserialize(reader),
        serialize: (value, writer) => def.schema.serialize(value, writer)
      })
      this.components.set(def.componentId, new Map())
      this.timestamps.set(def.componentId, new Map())
    }
  }

  /** Decode one `crdt-send` payload into the typed maps; records `changes`. */
  applyIncoming(data: Uint8Array): void {
    this.changes.length = 0
    const buf = new ReadWriteByteBuffer(data)
    let msg = readMessage(buf)
    while (msg) {
      this.applyMessage(msg)
      msg = readMessage(buf)
    }
    this.flushPendingMainCameraBindInternal()
  }

  /** Pointer atomic UI chunk — ignore stale LWW timestamps for worker-owned Ui* PUTs. */
  beginForceWorkerUiPuts(): void {
    this.forceWorkerUiPuts = true
  }

  endForceWorkerUiPuts(): void {
    this.forceWorkerUiPuts = false
  }

  /**
   * Pointer phase 4 / cooperative dirty snapshot — store decoded values directly.
   * Call under beginForceWorkerUiPuts; records changes for foldProjectionChanges.
   *
   * PE (1062) is put when present on a UI entity. Main must clear PE before re-seed
   * (SceneScriptSystem clearLwwSlotsForEntities includes 1062) so a missing PE row
   * after splash click actually drops the catcher — snapshot is PUT-only, not a full
   * component replace of the entity.
   */
  applyWorkerUiMountSnapshot(
    rows: readonly { entity: Entity; componentId: number; value: unknown }[]
  ): void {
    const tsBase = 1_000_000
    let seq = 0
    const POINTER_EVENTS_ID = 1062
    const UI_TRANSFORM_ID = 1050
    const entitiesWithTransform = new Set<Entity>()
    const entitiesWithPe = new Set<Entity>()
    for (const row of rows) {
      if (!WORKER_OWNED_UI_COMPONENT_IDS.has(row.componentId)) continue
      if (!this.meta.has(row.componentId)) continue
      this.deletedEntities.delete(row.entity)
      if (row.componentId === UI_TRANSFORM_ID) entitiesWithTransform.add(row.entity)
      if (row.componentId === POINTER_EVENTS_ID) entitiesWithPe.add(row.entity)
      // UiBackground (1053) / UiText (1052): force numeric color.a so transparent
      // textures (blood_frame a=0) stay hidden after omit-zero serialization.
      const value = normalizeUiColorFields(row.componentId, row.value)
      this.storeComponentPut(row.entity, row.componentId, tsBase + ++seq, value)
    }
    // Belt-and-suspenders: if clearLww skipped PE, drop PE on snapshot UI entities
    // that no longer ship a PE row (scene removed PointerEvents, entity still mounted).
    const peMap = this.components.get(POINTER_EVENTS_ID)
    const peTs = this.timestamps.get(POINTER_EVENTS_ID)
    if (peMap) {
      for (const entity of entitiesWithTransform) {
        if (entitiesWithPe.has(entity)) continue
        if (!peMap.has(entity)) continue
        peMap.delete(entity)
        peTs?.delete(entity)
        this.changes.push({ entity, componentId: POINTER_EVENTS_ID, kind: 'delete' })
      }
    }
  }

  private applyMessage(msg: CrdtMessage): void {
    switch (msg.type) {
      case CrdtMessageType.PUT_COMPONENT:
      case CrdtMessageType.PUT_COMPONENT_NETWORK:
        this.putComponent(msg.entityId, msg.componentId, msg.timestamp, msg.data)
        return
      case CrdtMessageType.APPEND_VALUE:
        // Grow-only set append — keep the latest decoded value (Phase 1 does not
        // drive rendering from grow-only sets; excluded from parity).
        this.putComponent(msg.entityId, msg.componentId, msg.timestamp, msg.data)
        return
      case CrdtMessageType.DELETE_COMPONENT:
      case CrdtMessageType.DELETE_COMPONENT_NETWORK:
        this.deleteComponent(msg.entityId, msg.componentId, msg.timestamp)
        return
      case CrdtMessageType.DELETE_ENTITY:
      case CrdtMessageType.DELETE_ENTITY_NETWORK:
        this.deleteEntity(msg.entityId)
        return
      default:
        return
    }
  }

  private putComponent(entity: Entity, componentId: number, timestamp: number, data: Uint8Array): void {
    // DCL recycles entity ids after DELETE_ENTITY — next PUT revives the slot (campfire sprite pool, etc.).
    this.deletedEntities.delete(entity)
    if (componentId === this.transformId && this.reservedEntities.has(entity)) return
    if (this.shouldRejectStaleInboundVcTransform(entity, componentId, timestamp)) return
    const meta = this.meta.get(componentId)
    if (!meta) return

    const tsMap = this.timestamps.get(componentId)!
    const existing = tsMap.get(entity)
    const forceUi =
      this.forceWorkerUiPuts && WORKER_OWNED_UI_COMPONENT_IDS.has(componentId)
    // LWW: only a single worker writes scene components, so timestamps are
    // monotonic per (entity, component). Reject strictly-older messages.
    if (!forceUi && existing !== undefined && timestamp < existing) return

    // Network-parented Transform: strip sender-local wire parent, then inject the
    // local entity that owns matching NetworkEntity (renderer hierarchy parity).
    const effectiveData =
      componentId === this.transformId && this.hasNetworkParent(entity)
        ? fixTransformParent({ data } as never)
        : data

    let value: unknown
    try {
      value = meta.deserialize(new ReadWriteByteBuffer(effectiveData))
    } catch {
      return
    }

    if (componentId === this.transformId && this.hasNetworkParent(entity)) {
      value = this.withResolvedNetworkParent(entity, value)
    }

    // Always commit MainCamera immediately. Deferring until VC Transform+VirtualCamera
    // were on the projection left the lens freecam-bound forever when those rows arrived
    // late / out of order (planet-angzaar select stage). VirtualCameraBridge.isActive()
    // already no-ops until the target VC is fully hydrated.
    this.storeComponentPut(entity, componentId, timestamp, value)
    this.pendingMainCameraBind = null

    // Late NetworkParent / NetworkEntity arrival — rebind child Transform parent.
    if (
      (this.networkParentId !== null && componentId === this.networkParentId) ||
      (this.networkEntityId !== null && componentId === this.networkEntityId)
    ) {
      this.rebindNetworkParentedTransforms(entity, componentId)
    }
  }

  /** Find local entity carrying NetworkEntity{networkId, entityId}. */
  findLocalEntityByNetworkIdentity(networkId: number, entityId: number): Entity | null {
    if (this.networkEntityId === null) return null
    const map = this.components.get(this.networkEntityId)
    if (!map) return null
    for (const [local, raw] of map) {
      const net = raw as NetworkIdentityValue
      if (
        Number(net?.networkId) === Number(networkId) &&
        Number(net?.entityId) === Number(entityId)
      ) {
        return local
      }
    }
    return null
  }

  /** Local parent entity for a child that has NetworkParent, or null. */
  resolveNetworkParentLocalEntity(child: Entity): Entity | null {
    if (this.networkParentId === null) return null
    const parentNet = this.components.get(this.networkParentId)?.get(child) as
      | NetworkIdentityValue
      | undefined
    if (!parentNet) return null
    const byIdentity = this.findLocalEntityByNetworkIdentity(
      parentNet.networkId,
      parentNet.entityId
    )
    if (byIdentity != null) return byIdentity
    // Single-scene / non-synced: NetworkParent.entityId is often the local parent
    // entity number even when the parent has no NetworkEntity row yet (Angzaar).
    const guess = Number(parentNet.entityId) as Entity
    if (
      guess &&
      guess !== child &&
      this.transformId != null &&
      (this.components.get(this.transformId)?.has(guess) ?? false)
    ) {
      return guess
    }
    return null
  }

  /**
   * Force-resolve every NetworkParent → Transform.parent (late NetworkEntity arrivals).
   * Used by AOI first-frame sampling so plaza hierarchies aren't sampled half-bound.
   * @returns number of Transforms whose parent field changed
   */
  rebindAllNetworkParents(): number {
    if (this.networkParentId === null || this.transformId === null) return 0
    const parentMap = this.components.get(this.networkParentId)
    const transformMap = this.components.get(this.transformId)
    if (!parentMap || !transformMap) return 0
    let n = 0
    for (const [child] of parentMap) {
      const t = transformMap.get(child)
      if (t === undefined) continue
      const next = this.withResolvedNetworkParent(child, t)
      if (next !== t) {
        transformMap.set(child, next)
        // Queue diff so EntityStore / first-frame re-link parents (not just the map).
        this.changes.push({ entity: child, componentId: this.transformId, kind: 'put' })
        n++
      }
    }
    return n
  }

  /**
   * Children with NetworkParent whose local parent entity is still missing
   * (NetworkEntity for parent not on the projection yet).
   */
  countUnresolvedNetworkParents(): number {
    if (this.networkParentId === null) return 0
    const parentMap = this.components.get(this.networkParentId)
    if (!parentMap) return 0
    let n = 0
    for (const [child] of parentMap) {
      if (this.resolveNetworkParentLocalEntity(child) == null) n++
    }
    return n
  }

  private withResolvedNetworkParent(entity: Entity, transformValue: unknown): unknown {
    const localParent = this.resolveNetworkParentLocalEntity(entity)
    if (localParent == null) return transformValue
    const t = transformValue as { parent?: number }
    if (Number(t.parent) === Number(localParent)) return transformValue
    return { ...t, parent: localParent }
  }

  /**
   * After NetworkParent put on `entity`, rebind its Transform.
   * After NetworkEntity put, rebind any children whose NetworkParent points at this identity.
   */
  private rebindNetworkParentedTransforms(entity: Entity, componentId: number): void {
    if (this.transformId == null) return
    const transformMap = this.components.get(this.transformId)
    if (!transformMap) return

    if (this.networkParentId !== null && componentId === this.networkParentId) {
      const t = transformMap.get(entity)
      if (t === undefined) return
      const next = this.withResolvedNetworkParent(entity, t)
      if (next !== t) {
        transformMap.set(entity, next)
        this.changes.push({ entity, componentId: this.transformId, kind: 'put' })
      }
      return
    }

    if (this.networkEntityId === null || this.networkParentId === null) return
    if (componentId !== this.networkEntityId) return
    const identity = this.components.get(this.networkEntityId)?.get(entity) as
      | NetworkIdentityValue
      | undefined
    if (!identity) return
    const parentMap = this.components.get(this.networkParentId)
    if (!parentMap) return
    for (const [child, raw] of parentMap) {
      const p = raw as NetworkIdentityValue
      if (
        Number(p?.networkId) !== Number(identity.networkId) ||
        Number(p?.entityId) !== Number(identity.entityId)
      ) {
        continue
      }
      const t = transformMap.get(child)
      if (t === undefined) continue
      const next = this.withResolvedNetworkParent(child, t)
      if (next !== t) {
        transformMap.set(child, next)
        this.changes.push({ entity: child, componentId: this.transformId, kind: 'put' })
      }
    }
  }

  private storeComponentPut(entity: Entity, componentId: number, timestamp: number, value: unknown): void {
    const tsMap = this.timestamps.get(componentId)!
    tsMap.set(entity, timestamp)
    this.components.get(componentId)!.set(entity, value)
    this.changes.push({ entity, componentId, kind: 'put' })
  }

  private isMainCameraOnCameraEntity(entity: Entity, componentId: number): boolean {
    const gate = this.virtualCameraGate
    return gate != null && entity === gate.cameraEntity && componentId === gate.mainCameraComponentId
  }

  private virtualCameraTargetFromMain(value: unknown): Entity | null {
    const target = (value as { virtualCameraEntity?: number | null } | null)?.virtualCameraEntity
    if (target === undefined || target === null) return null
    return target as Entity
  }

  private flushPendingMainCameraBindInternal(): void {
    // MainCamera is committed immediately; drain any stale pending from older sessions.
    this.pendingMainCameraBind = null
  }

  private clearPendingMainCameraBindForEntity(entity: Entity): void {
    const pending = this.pendingMainCameraBind
    if (!pending) return
    const target = this.virtualCameraTargetFromMain(pending.value)
    if (target === entity) this.pendingMainCameraBind = null
  }

  /** True when `entity` carries both NetworkEntity and NetworkParent (engine network entity). */
  private hasNetworkParent(entity: Entity): boolean {
    if (this.networkEntityId === null || this.networkParentId === null) return false
    return (
      (this.components.get(this.networkEntityId)?.has(entity) ?? false) &&
      (this.components.get(this.networkParentId)?.has(entity) ?? false)
    )
  }

  private deleteComponent(entity: Entity, componentId: number, timestamp: number): void {
    const meta = this.meta.get(componentId)
    if (!meta) return

    const tsMap = this.timestamps.get(componentId)!
    const existing = tsMap.get(entity)
    if (existing !== undefined && timestamp < existing) return

    if (this.isMainCameraOnCameraEntity(entity, componentId)) {
      this.pendingMainCameraBind = null
    }
    this.clearPendingMainCameraBindForEntity(entity)

    tsMap.set(entity, timestamp)
    if (this.components.get(componentId)!.delete(entity)) {
      this.changes.push({ entity, componentId, kind: 'delete' })
    }
  }

  private deleteEntity(entity: Entity): void {
    this.clearPendingMainCameraBindForEntity(entity)
    this.deletedEntities.add(entity)
    for (const [componentId, map] of this.components) {
      if (map.delete(entity)) {
        this.changes.push({ entity, componentId, kind: 'delete' })
      }
      this.timestamps.get(componentId)!.delete(entity)
    }
  }

  /**
   * Renderer-owned LWW write (reserved transforms, tween Transform/TweenState,
   * PrimaryPointerInfo, …). Stores the decoded value object directly with a renderer
   * timestamp that outpaces inbound (so the renderer's interpolated Transform wins LWW
   * against the scene's). Does NOT push to `changes` — renderer writes are not part of
   * the inbound scene diff (the diff consumer handles tween/reserved separately).
   */
  /**
   * Worker→main live Transform for bound VC follow rig and MOVE CAMERA flight.
   * High monotonic timestamps beat async inbound CRDT so the lens stays aligned.
   */
  setVcLiveTransform(entity: Entity, value: unknown): void {
    if (this.deletedEntities.has(entity)) return
    const map = this.components.get(this.transformId)
    if (!map) return

    const ts = VC_LIVE_TS_BASE + ++this.vcLiveSeq
    const tsMap = this.timestamps.get(this.transformId)!
    tsMap.set(entity, ts)
    map.set(entity, value)
    this.vcLiveEntities.add(entity)
  }

  /** Drop live-lane priority when MainCamera.virtualCameraEntity clears. */
  clearVcLiveTransformForUnbind(): void {
    for (const entity of [...this.vcLiveEntities]) {
      this.clearVcLiveTransform(entity)
    }
  }

  /** Drop live-lane priority so inbound worker Transform can apply again. */
  clearVcLiveTransform(entity: Entity): void {
    const tsMap = this.timestamps.get(this.transformId)
    if (!tsMap) return
    const ts = tsMap.get(entity) ?? 0
    if (ts >= VC_LIVE_TS_BASE) {
      tsMap.set(entity, ts - VC_LIVE_TS_BASE)
    }
    this.vcLiveEntities.delete(entity)
  }

  private shouldRejectStaleInboundVcTransform(
    entity: Entity,
    componentId: number,
    _timestamp: number
  ): boolean {
    if (componentId !== this.transformId) return false
    // Live lane is exclusive while held. Cold CRDT local-hierarchy puts (often high TS) must
    // never clobber world-flattened / follow poses — that caused FPS-dip "map flicker".
    if (this.vcLiveEntities.has(entity)) return true
    const liveTs = this.timestamps.get(this.transformId)?.get(entity) ?? 0
    return liveTs >= VC_LIVE_TS_BASE
  }

  setRenderer(componentId: number, entity: Entity, value: unknown): void {
    if (this.deletedEntities.has(entity)) return
    const map = this.components.get(componentId)
    if (!map) return

    if (this.isMainCameraOnCameraEntity(entity, componentId)) {
      this.pendingMainCameraBind = null
    }

    const tsMap = this.timestamps.get(componentId)!
    tsMap.set(entity, (tsMap.get(entity) ?? 0) + 1)
    map.set(entity, value)
  }

  /**
   * Renderer/player-frame owned delete — clears projection map (not the unused ECS engine).
   * Store-component facades must call this from deleteFrom; otherwise createOrReplace writes
   * the projection while deleteFrom only touched the prototype engine (SpaceRunner stayed
   * frozen after load-gate clear: imHas=false but afterHas=true).
   */
  deleteRenderer(componentId: number, entity: Entity): void {
    const map = this.components.get(componentId)
    if (!map) return
    if (this.isMainCameraOnCameraEntity(entity, componentId)) {
      this.pendingMainCameraBind = null
    }
    this.clearPendingMainCameraBindForEntity(entity)
    const tsMap = this.timestamps.get(componentId)
    if (tsMap) {
      // Bump LWW so a stale lower-TS freeze PUT cannot resurrect the component.
      tsMap.set(entity, (tsMap.get(entity) ?? 0) + 1)
    }
    if (map.delete(entity)) {
      this.changes.push({ entity, componentId, kind: 'delete' })
    }
  }

  /** Renderer-owned grow-only append. Stores the latest value (parity with inbound APPEND handling). */
  appendRenderer(componentId: number, entity: Entity, value: unknown): void {
    if (this.deletedEntities.has(entity)) return
    const map = this.components.get(componentId)
    if (!map) return
    map.set(entity, value)
  }

  /** Latest decoded value for a component on an entity, or `undefined`. */
  get(componentId: number, entity: Entity): unknown {
    return this.components.get(componentId)?.get(entity)
  }

  /** Read path for renderer facades (MainCamera is never deferred). */
  getEffective(componentId: number, entity: Entity): unknown {
    return this.get(componentId, entity)
  }

  /** Whether the entity currently has a value for the component. */
  has(componentId: number, entity: Entity): boolean {
    return this.getEffective(componentId, entity) !== undefined
  }

  /** Last applied LWW Lamport timestamp for (component, entity), or 0 if never put. */
  getLamport(componentId: number, entity: Entity): number {
    return this.timestamps.get(componentId)?.get(entity) ?? 0
  }

  /** Commit a deferred MainCamera bind before encode / virtual-camera reads. */
  flushPendingMainCameraBind(): void {
    this.flushPendingMainCameraBindInternal()
  }

  /** Whether the entity is between DELETE_ENTITY and the next inbound PUT (id may be recycled). */
  isDeleted(entity: Entity): boolean {
    return this.deletedEntities.has(entity)
  }

  /** Iterate `[entity, value]` pairs for one component (read-API parity with `getEntitiesWith`). */
  *entitiesWith(componentId: number): IterableIterator<[Entity, unknown]> {
    const map = this.components.get(componentId)
    if (!map) return
    yield* map.entries()
  }

  /** Direct access to a component's entity→value map (read-only use). */
  componentMap(componentId: number): ReadonlyMap<Entity, unknown> | undefined {
    return this.components.get(componentId)
  }

  /**
   * Serialize all decoded component state to a CRDT byte stream — the projection's half of
   * the boot `getState` snapshot (scene-owned inbound + renderer-written tween/video state),
   * replacing the engine's `dumpCrdtStateToBuffer` for everything except the reserved
   * Player/Camera/Root entities (the encoder owns those — see `CrdtEncoder.serializeReservedSnapshot`).
   *
   * LWW components are emitted as PUTs with their last-applied Lamport timestamp; grow-only
   * components as a single APPEND of their latest value. NetworkEntity/NetworkParent are
   * included when their schemas are registered (P3 parent graph).
   */
  serializeSnapshot(
    buf: ReadWriteByteBuffer = new ReadWriteByteBuffer(),
    skipEntities?: ReadonlySet<Entity>
  ): ReadWriteByteBuffer {
    for (const [componentId, map] of this.components) {
      const meta = this.meta.get(componentId)
      if (!meta || !meta.serialize) continue
      const tsMap = this.timestamps.get(componentId)!
      for (const [entity, value] of map) {
        if (skipEntities?.has(entity)) continue
        const body = new ReadWriteByteBuffer()
        meta.serialize(value, body)
        const data = body.toBinary()
        if (meta.growOnly) {
          AppendValueOperation.write(entity, 0, componentId, data, buf)
        } else {
          PutComponentOperation.write(entity, tsMap.get(entity) ?? 1, componentId, data, buf)
        }
      }
    }
    return buf
  }

  /**
   * Clear LWW rows + timestamps for recycled UI entity ids before a bulk mount open.
   * Stale main timestamps from prior pool cycles reject worker PUTs (projection 4/23).
   */
  clearLwwSlotsForEntities(entities: ReadonlySet<Entity>, componentIds: readonly number[]): void {
    for (const componentId of componentIds) {
      const map = this.components.get(componentId)
      const tsMap = this.timestamps.get(componentId)
      if (!map || !tsMap) continue
      for (const entity of entities) {
        map.delete(entity)
        tsMap.delete(entity)
      }
    }
  }

  /** Drop decoded rows for entities outside the worker mount set (prevents ghost UiTransform round-trips). */
  purgeEntitiesOutsideSet(
    keepEntities: ReadonlySet<Entity>,
    componentIds: readonly number[],
    options?: { recordChanges?: boolean }
  ): void {
    const recordChanges = options?.recordChanges === true
    for (const componentId of componentIds) {
      const map = this.components.get(componentId)
      if (!map) continue
      for (const entity of [...map.keys()]) {
        if (keepEntities.has(entity)) continue
        map.delete(entity)
        this.timestamps.get(componentId)?.delete(entity)
        if (recordChanges) {
          this.changes.push({ entity, componentId, kind: 'delete' })
        }
      }
    }
  }

  /** Count of distinct non-reserved entities currently carrying a Transform (boot `hasEntities` gate). */
  sceneEntityCount(reserved: ReadonlySet<Entity>): number {
    const map = this.components.get(this.transformId)
    if (!map) return 0
    let count = 0
    for (const entity of map.keys()) if (!reserved.has(entity)) count++
    return count
  }
}

export interface ProjectionParityReport {
  /** Total component-entity pairs compared. */
  checked: number
  /** Human-readable mismatch descriptions (capped). */
  mismatches: string[]
}

const MAX_MISMATCHES = 12

/**
 * Dev-only parity check: assert the projection's typed maps match the live
 * mirror engine for scene-owned LWW components. Renderer-owned and
 * renderer-mutated components are excluded because the projection only sees the
 * inbound worker stream, not the renderer's local writes:
 *  - reserved entities (Root/Player/Camera) — renderer-seeded transforms, etc.
 *  - grow-only sets (`PointerEventsResult`, `VideoEvent`) — renderer-produced.
 *  - `PrimaryPointerInfo` — written by the pointer system.
 *  - `TweenState` — written by the tween bridge.
 *  - `Transform` on entities with a `Tween` — interpolated locally each frame.
 */
export function checkProjectionParity(
  projection: CrdtProjection,
  engine: IEngine,
  components: MirrorComponents
): ProjectionParityReport {
  const report: ProjectionParityReport = { checked: 0, mismatches: [] }

  const reserved = new Set<Entity>([engine.RootEntity, engine.PlayerEntity, engine.CameraEntity])
  const excludedIds = new Set<number>([
    components.PrimaryPointerInfo.componentId,
    components.TweenState.componentId,
    components.CameraMode.componentId,
    components.PointerLock.componentId
  ])
  const transformId = components.Transform.componentId
  const tween = components.Tween

  const push = (line: string): void => {
    if (report.mismatches.length < MAX_MISMATCHES) report.mismatches.push(line)
  }

  for (const def of Object.values(components)) {
    if (def.componentType === COMPONENT_TYPE_GROW_ONLY) continue
    if (excludedIds.has(def.componentId)) continue

    const projMap = projection.components.get(def.componentId) ?? new Map<Entity, unknown>()
    const engineEntities = new Set<Entity>()

    for (const [entity] of engine.getEntitiesWith(def)) {
      if (reserved.has(entity)) continue
      if (def.componentId === transformId && tween.has(entity)) continue
      engineEntities.add(entity)
      report.checked++

      const engineValue = def.get(entity)
      const projValue = projMap.get(entity)
      if (projValue === undefined) {
        push(`${def.componentName} e${entity}: missing in projection`)
      } else if (stableStringify(engineValue) !== stableStringify(projValue)) {
        push(`${def.componentName} e${entity}: value differs`)
      }
    }

    for (const entity of projMap.keys()) {
      if (reserved.has(entity)) continue
      if (def.componentId === transformId && tween.has(entity)) continue
      if (!engineEntities.has(entity)) {
        push(`${def.componentName} e${entity}: extra in projection`)
      }
    }
  }

  return report
}

/** Key-sorted JSON for order-independent structural comparison. */
function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, val) => {
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      const obj = val as Record<string, unknown>
      return Object.keys(obj)
        .sort()
        .reduce<Record<string, unknown>>((acc, k) => {
          acc[k] = obj[k]
          return acc
        }, {})
    }
    return val
  })
}
