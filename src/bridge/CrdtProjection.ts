import type { Entity, IEngine } from '@dcl/ecs'
import { ReadWriteByteBuffer } from '@dcl/ecs/dist/serialization/ByteBuffer'
import { readMessage } from '@dcl/ecs/dist/serialization/crdt/message'
import { PutComponentOperation } from '@dcl/ecs/dist/serialization/crdt/putComponent'
import { AppendValueOperation } from '@dcl/ecs/dist/serialization/crdt/appendValue'
import { CrdtMessageType } from '@dcl/ecs/dist/serialization/crdt/types'
import type { CrdtMessage } from '@dcl/ecs/dist/serialization/crdt/types'
import { fixTransformParent } from '@dcl/ecs/dist/serialization/crdt/network/utils'
import type { MirrorComponents } from './mirrorComponents'

/** Component defs the projection needs to replicate the engine's network-entity handling. */
export interface ProjectionNetworkDefs {
  /** `core-schema::Network-Entity` def (componentId only is used). */
  networkEntity: { componentId: number }
  /** `core-schema::Network-Parent` def (componentId only is used). */
  networkParent: { componentId: number }
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

export class CrdtProjection {
  /** componentId → (entity → latest decoded value). */
  readonly components = new Map<number, Map<Entity, unknown>>()
  /** componentId → (entity → last applied Lamport timestamp). */
  private readonly timestamps = new Map<number, Map<Entity, number>>()
  private readonly meta = new Map<number, ComponentMeta>()
  private readonly deletedEntities = new Set<Entity>()
  /** Change set for the most recent `applyIncoming` (cleared on each call). */
  readonly changes: ProjectionChange[] = []

  private readonly transformId: number
  /** Network-entity book-keeping component ids (so we replicate `fixTransformParent`). */
  private readonly networkEntityId: number | null
  private readonly networkParentId: number | null

  constructor(components: MirrorComponents, network?: ProjectionNetworkDefs) {
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
    // The engine's CRDT system stores NetworkEntity/NetworkParent (built-in components) so
    // it can detect network-parented entities on receive. Register them here too — but as
    // raw passthrough (no typed schema): we only need presence, not the decoded value.
    for (const id of [this.networkEntityId, this.networkParentId]) {
      if (id !== null && !this.meta.has(id)) {
        this.meta.set(id, { id, name: `network::${id}`, growOnly: false, deserialize: () => ({}) })
        this.components.set(id, new Map())
        this.timestamps.set(id, new Map())
      }
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
    if (this.deletedEntities.has(entity)) return
    const meta = this.meta.get(componentId)
    if (!meta) return

    const tsMap = this.timestamps.get(componentId)!
    const existing = tsMap.get(entity)
    // LWW: only a single worker writes scene components, so timestamps are
    // monotonic per (entity, component). Reject strictly-older messages.
    if (existing !== undefined && timestamp < existing) return

    // Replicate the engine's receive-side `fixTransformParent` (crdt/index.js): a
    // network-parented entity's incoming Transform has its parent stripped (the wire
    // parent is in the *sender's* id space and is resolved separately via NetworkParent).
    // Without this, network-entity Transforms keep a stale parent — the `e2599 value
    // differs` projection-vs-engine mismatch.
    const effectiveData =
      componentId === this.transformId && this.hasNetworkParent(entity) ? fixTransformParent({ data } as never) : data

    const value = meta.deserialize(new ReadWriteByteBuffer(effectiveData))
    tsMap.set(entity, timestamp)
    this.components.get(componentId)!.set(entity, value)
    this.changes.push({ entity, componentId, kind: 'put' })
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

    tsMap.set(entity, timestamp)
    if (this.components.get(componentId)!.delete(entity)) {
      this.changes.push({ entity, componentId, kind: 'delete' })
    }
  }

  private deleteEntity(entity: Entity): void {
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
  setRenderer(componentId: number, entity: Entity, value: unknown): void {
    if (this.deletedEntities.has(entity)) return
    const map = this.components.get(componentId)
    if (!map) return
    const tsMap = this.timestamps.get(componentId)!
    tsMap.set(entity, (tsMap.get(entity) ?? 0) + 1)
    map.set(entity, value)
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

  /** Whether the entity currently has a value for the component. */
  has(componentId: number, entity: Entity): boolean {
    return this.components.get(componentId)?.has(entity) ?? false
  }

  /** Whether the entity has been deleted (DELETE_ENTITY) and is rejecting further puts. */
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
   * components as a single APPEND of their latest value. Presence-only passthrough defs
   * (NetworkEntity/NetworkParent) have no schema and are skipped.
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
    components.TweenState.componentId
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
