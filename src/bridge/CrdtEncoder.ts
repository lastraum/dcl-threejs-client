import type { Entity } from '@dcl/ecs'
import type { CrdtProjection } from './CrdtProjection'
import type { ReservedEntities } from './ProjectionView'
import { ReadWriteByteBuffer } from '@dcl/ecs/dist/serialization/ByteBuffer'
import { PutComponentOperation } from '@dcl/ecs/dist/serialization/crdt/putComponent'
import { AppendValueOperation } from '@dcl/ecs/dist/serialization/crdt/appendValue'
import { readMessage } from '@dcl/ecs/dist/serialization/crdt/message'
import { CrdtMessageType } from '@dcl/ecs/dist/serialization/crdt/types'
import type { MirrorComponents } from './mirrorComponents'

/**
 * Phase 3 renderer-owned outbound encoder (REARCHITECTURE_PLAN.md §5.1).
 *
 * The renderer owns a small set of components it writes *back* to the scene worker:
 * reserved Player/Camera transforms + identity, tween state, pointer results, video
 * events. The encoder reproduces that outbound CRDT
 * directly — reusing the SDK wire writers (`PutComponentOperation.write`) and each
 * component's `schema.serialize` — so we can eventually delete the second engine.
 *
 * Sub-step 3a covers the **reserved-entity LWW components** only (the most
 * deterministic subset). Tween + grow-only (pointer/video) follow in 3c.
 *
 * It runs in **shadow mode** first (gated by `?encparity`): it encodes from the same
 * mirror-engine values `flushOutgoing()` reads, and `checkEncoderParity()` asserts the
 * bytes match per `(entity, componentId)`. Only once parity is clean do we cut the
 * `crdt-response` payload over to this encoder.
 */

export interface EncoderEmit {
  entity: Entity
  componentId: number
  data: Uint8Array
}

type ComponentDef = MirrorComponents[keyof MirrorComponents]

interface LwwTarget {
  componentId: number
  componentName: string
  entity: Entity
  has(entity: Entity): boolean
  serialize(entity: Entity): Uint8Array
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

function serializeFromProjection(
  def: ComponentDef,
  projection: CrdtProjection,
  entity: Entity
): Uint8Array {
  const body = new ReadWriteByteBuffer()
  def.schema.serialize(projection.get(def.componentId, entity) as never, body)
  return body.toBinary()
}

function serializeValue(def: ComponentDef, value: unknown): Uint8Array {
  const body = new ReadWriteByteBuffer()
  def.schema.serialize(value as never, body)
  return body.toBinary()
}

export class CrdtEncoder {
  /** `${componentId}:${entity}` → last emitted Lamport timestamp (monotonic per key). */
  private readonly lamport = new Map<string, number>()
  /** `${componentId}:${entity}` → last serialized bytes (for dirty-only emission + parity). */
  private readonly lastSerialized = new Map<string, Uint8Array>()
  /** PUT targets emitted on the most recent `encode()` call (cleared each call). */
  readonly emitted: EncoderEmit[] = []
  /** APPEND values emitted on the most recent `encode()` call (cleared each call). */
  readonly emittedAppends: EncoderEmit[] = []

  /** Reserved-entity LWW components the renderer owns (sub-step 3a). */
  private readonly reservedTargets: LwwTarget[]
  private readonly reservedEntities: ReservedEntities
  private readonly projection: CrdtProjection
  /** Tween-path components the renderer rewrites on *dynamic* scene entities (3c). */
  private readonly tweenState: ComponentDef
  private readonly transform: ComponentDef
  /** Grow-only (APPEND) components the renderer appends to (pointer / video results). */
  private readonly growOnlyIds: Set<number>
  private readonly growOnlyById: Map<number, ComponentDef>
  /**
   * Source-captured grow-only appends since the last `encode()`. The renderer writers
   * (`PointerEventsSystem`, `VideoPlayerBridge`) call `recordAppend` at the exact
   * `addValue` site, so we serialize the value at that instant and reproduce one APPEND
   * per call — byte-exact and immune to grow-only set pruning (which silently drops
   * older entries the engine still flushed, the cause of the snapshot-diff append misses).
   */
  private readonly recordedAppends: EncoderEmit[] = []
  /** Source-captured dynamic LWW PUTs (RaycastResult, etc.). */
  private readonly lwwCaptureById: Map<number, ComponentDef>
  private readonly recordedLwwPuts: EncoderEmit[] = []
  /** componentIds the encoder is responsible for (for boot logging + coverage). */
  private readonly componentIds: Set<number>
  /** When set, tween encode scans only these entities (from TweenBridge dirty set). */
  private tweenEncodeEntities: ReadonlySet<Entity> | null = null

  constructor(reserved: ReservedEntities, projection: CrdtProjection, components: MirrorComponents) {
    this.reservedEntities = reserved
    this.projection = projection
    this.tweenState = components.TweenState
    this.transform = components.Transform
    const growOnly = [components.PointerEventsResult, components.TriggerAreaResult, components.VideoEvent]
    this.growOnlyIds = new Set(growOnly.map((d) => d.componentId))
    this.growOnlyById = new Map(growOnly.map((d) => [d.componentId, d]))
    const lwwCapture = [components.RaycastResult]
    this.lwwCaptureById = new Map(lwwCapture.map((d) => [d.componentId, d]))

    const mk = (def: ComponentDef, entity: Entity): LwwTarget => ({
      componentId: def.componentId,
      componentName: def.componentName,
      entity,
      has: (e) => projection.has(def.componentId, e),
      serialize: (e) => serializeFromProjection(def, projection, e)
    })

    this.reservedTargets = [
      mk(components.Transform, reserved.player),
      mk(components.PlayerIdentityData, reserved.player),
      mk(components.AvatarBase, reserved.player),
      mk(components.AvatarEquippedData, reserved.player),
      mk(components.Transform, reserved.camera),
      mk(components.MainCamera, reserved.camera),
      // Renderer writes pointer screen/hover state to RootEntity (PointerEventsSystem).
      mk(components.PrimaryPointerInfo, reserved.root)
    ]

    this.componentIds = new Set(this.reservedTargets.map((t) => t.componentId))
    this.componentIds.add(this.tweenState.componentId)
    this.componentIds.add(this.transform.componentId)
    for (const id of this.growOnlyIds) this.componentIds.add(id)
    for (const id of this.lwwCaptureById.keys()) this.componentIds.add(id)
  }

  private key(entity: Entity, componentId: number): string {
    return `${componentId}:${entity}`
  }

  /** Emit one dirty-only LWW PUT for `(entity, componentId)` into `buf`. Returns true if written. */
  private emitLww(
    entity: Entity,
    componentId: number,
    data: Uint8Array,
    buf: ReadWriteByteBuffer
  ): boolean {
    const key = this.key(entity, componentId)
    const prev = this.lastSerialized.get(key)
    if (prev && bytesEqual(prev, data)) return false // dirty-only: skip unchanged

    this.lastSerialized.set(key, data)
    const ts = (this.lamport.get(key) ?? 0) + 1
    this.lamport.set(key, ts)
    PutComponentOperation.write(entity, ts, componentId, data, buf)
    this.emitted.push({ entity, componentId, data })
    return true
  }

  /** Grow-only appends queued since the last `encode()` / `encodeAppendsOnly()`. */
  get pendingAppendCount(): number {
    return this.recordedAppends.length
  }

  /** Dynamic LWW PUTs queued since the last `encode()` / `encodeLwwPutsOnly()`. */
  get pendingLwwPutCount(): number {
    return this.recordedLwwPuts.length
  }

  /**
   * Encode only source-captured grow-only appends (pointer/video results).
   * Used for pointer flush stash so player/camera LWW is not re-shipped every nudge.
   */
  encodeAppendsOnly(): Uint8Array | null {
    this.emittedAppends.length = 0
    const buf = new ReadWriteByteBuffer()
    if (!this.encodeAppends(buf)) return null
    return buf.toBinary()
  }

  /**
   * Encode only source-captured dynamic LWW PUTs (RaycastResult).
   * Used for proactive worker delivery without re-shipping reserved entities.
   */
  encodeLwwPutsOnly(): Uint8Array | null {
    this.emitted.length = 0
    const buf = new ReadWriteByteBuffer()
    if (!this.encodeRecordedLwwPuts(buf)) return null
    return buf.toBinary()
  }

  /**
   * Encode only dirty `TweenState` PUTs (no Transform, reserved entities, or appends).
   * Used for lightweight proactive worker push after pointer-triggered tweens.
   */
  encodeTweenStateOnly(): Uint8Array | null {
    this.emitted.length = 0
    const buf = new ReadWriteByteBuffer()
    const tweenStateId = this.tweenState.componentId
    const tweenDirty = this.tweenEncodeEntities
    this.tweenEncodeEntities = null
    if (!tweenDirty?.size) return null
    let wrote = false
    for (const entity of tweenDirty) {
      if (!this.projection.has(tweenStateId, entity)) continue
      if (
        this.emitLww(
          entity,
          tweenStateId,
          serializeFromProjection(this.tweenState, this.projection, entity),
          buf
        )
      ) {
        wrote = true
      }
    }
    return wrote ? buf.toBinary() : null
  }

  /** Grow-only component ids the encoder owns (pointer results, video events). */
  growOnlyComponentIds(): ReadonlySet<number> {
    return this.growOnlyIds
  }

  /** Limit tween-path encode to entities updated this frame (null = scan all TweenState owners). */
  setTweenEncodeEntities(entities: ReadonlySet<Entity> | null): void {
    this.tweenEncodeEntities = entities
  }

  /**
   * Encode renderer-owned components whose value changed since the last call.
   * Returns the CRDT payload (one binary blob) or `null` when nothing changed.
   */
  encode(): Uint8Array | null {
    this.emitted.length = 0
    this.emittedAppends.length = 0
    const buf = new ReadWriteByteBuffer()
    let wrote = false

    // Reserved-entity LWW (player/camera transforms + identity + camera config).
    for (const target of this.reservedTargets) {
      if (!target.has(target.entity)) continue
      if (this.emitLww(target.entity, target.componentId, target.serialize(target.entity), buf)) {
        wrote = true
      }
    }

    // Tween path (3c): renderer rewrites TweenState + the interpolated Transform on
    // each tweened scene entity. Entities are dynamic, so scan by TweenState ownership.
    const tweenStateId = this.tweenState.componentId
    const transformId = this.transform.componentId
    const tweenDirty = this.tweenEncodeEntities
    this.tweenEncodeEntities = null
    const tweenEntities =
      tweenDirty && tweenDirty.size > 0
        ? [...tweenDirty].filter((entity) => this.projection.has(tweenStateId, entity))
        : null
    const emitTweenEntity = (entity: Entity): void => {
      if (this.emitLww(entity, tweenStateId, serializeFromProjection(this.tweenState, this.projection, entity), buf)) {
        wrote = true
      }
      if (this.projection.has(transformId, entity)) {
        if (this.emitLww(entity, transformId, serializeFromProjection(this.transform, this.projection, entity), buf)) {
          wrote = true
        }
      }
    }
    if (tweenEntities?.length) {
      for (const entity of tweenEntities) emitTweenEntity(entity)
    } else {
      const tweenMap = this.projection.componentMap(tweenStateId)
      if (tweenMap) {
        for (const [entity] of tweenMap) emitTweenEntity(entity)
      }
    }

    // Grow-only path (3c): pointer/video results the renderer appends. flushOutgoing
    // emits one APPEND per `addValue` since the last flush; we reproduce that one-for-one
    // from the values source-captured at each `addValue` site (see `recordAppend`).
    if (this.encodeAppends(buf)) wrote = true

    if (this.encodeRecordedLwwPuts(buf)) wrote = true

    return wrote ? buf.toBinary() : null
  }

  /**
   * Source-capture a grow-only append at the exact `addValue` call site. The value is
   * serialized immediately (so it reflects the value as-written, immune to later mutation
   * or set pruning) and emitted as a single APPEND on the next `encode()`.
   */
  recordAppend(componentId: number, entity: Entity, value: unknown): void {
    const def = this.growOnlyById.get(componentId)
    if (!def) return
    this.recordedAppends.push({ entity, componentId, data: serializeValue(def, value) })
  }

  /** Source-capture a renderer-owned dynamic LWW PUT (RaycastResult). */
  recordLww(componentId: number, entity: Entity, value: unknown): void {
    const def = this.lwwCaptureById.get(componentId)
    if (!def) return
    this.recordedLwwPuts.push({ entity, componentId, data: serializeValue(def, value) })
  }

  /** Emit one APPEND op per source-captured value since the last encode. */
  private encodeAppends(buf: ReadWriteByteBuffer): boolean {
    if (this.recordedAppends.length === 0) return false
    for (const rec of this.recordedAppends) {
      AppendValueOperation.write(rec.entity, 0, rec.componentId, rec.data, buf)
      this.emittedAppends.push(rec)
    }
    this.recordedAppends.length = 0
    return true
  }

  /** Emit one PUT op per source-captured dynamic LWW value since the last encode. */
  private encodeRecordedLwwPuts(buf: ReadWriteByteBuffer): boolean {
    if (this.recordedLwwPuts.length === 0) return false
    let wrote = false
    for (const rec of this.recordedLwwPuts) {
      if (this.emitLww(rec.entity, rec.componentId, rec.data, buf)) {
        wrote = true
      }
    }
    this.recordedLwwPuts.length = 0
    return wrote
  }

  /** Latest serialized bytes the encoder believes for `(entity, componentId)`. */
  serializedFor(entity: Entity, componentId: number): Uint8Array | undefined {
    return this.lastSerialized.get(this.key(entity, componentId))
  }

  /**
   * Full (non-dirty) snapshot of the renderer-owned reserved-entity components for the boot
   * `getState` — the encoder's half of the snapshot (the projection serializes everything else).
   * Includes the Root identity Transform (entity 0) the engine seeds. Timestamps are monotone
   * per key but otherwise irrelevant: at boot the worker engine is empty so any PUT is accepted.
   */
  serializeReservedSnapshot(buf: ReadWriteByteBuffer = new ReadWriteByteBuffer()): ReadWriteByteBuffer {
    const transformId = this.transform.componentId
    const root = this.reservedEntities.root
    if (this.projection.has(transformId, root)) {
      const data = serializeFromProjection(this.transform, this.projection, root)
      PutComponentOperation.write(root, 1, transformId, data, buf)
    }
    for (const target of this.reservedTargets) {
      if (!target.has(target.entity)) continue
      const data = target.serialize(target.entity)
      const ts = (this.lamport.get(this.key(target.entity, target.componentId)) ?? 0) + 1
      PutComponentOperation.write(target.entity, ts, target.componentId, data, buf)
    }
    return buf
  }

  /** componentIds the encoder is responsible for (used to scope the parity check). */
  coveredComponentIds(): Set<number> {
    return new Set(this.componentIds)
  }

  /**
   * Whether `(entity, componentId)` is a renderer-owned PUT the encoder must reproduce.
   *
   * - Reserved player/camera components are always owned.
   * - `TweenState` is renderer-owned on any entity (the renderer drives all tweens).
   * - `Transform` is renderer-owned on reserved entities and on tweened entities; on
   *   any other scene entity Transform is scene-owned (incoming) and out of scope.
   */
  covers(entity: Entity, componentId: number): boolean {
    if (componentId === this.tweenState.componentId) return true
    if (this.growOnlyIds.has(componentId)) return true
    if (this.lwwCaptureById.has(componentId)) return true
    if (componentId === this.transform.componentId) {
      if (entity === this.reservedEntities.player || entity === this.reservedEntities.camera) return true
      return this.projection.has(this.tweenState.componentId, entity)
    }
    for (const t of this.reservedTargets) {
      if (t.entity === entity && t.componentId === componentId) return true
    }
    return false
  }
}

/** Keep only APPEND ops for the given grow-only component ids (pointer flush mirror fallback). */
export function filterGrowOnlyAppends(chunks: Uint8Array[], componentIds: ReadonlySet<number>): Uint8Array[] {
  const buf = new ReadWriteByteBuffer()
  let wrote = false
  for (const chunk of chunks) {
    const readBuf = new ReadWriteByteBuffer(chunk)
    try {
      let msg = readMessage(readBuf)
      while (msg) {
        if (msg.type === CrdtMessageType.APPEND_VALUE && componentIds.has(msg.componentId)) {
          AppendValueOperation.write(msg.entityId, msg.timestamp, msg.componentId, msg.data, buf)
          wrote = true
        }
        msg = readMessage(readBuf)
      }
    } catch {
      /* partial chunk — keep whatever we decoded */
    }
  }
  return wrote ? [buf.toBinary()] : []
}

export interface EncoderParityReport {
  checked: number
  mismatches: string[]
  /**
   * Renderer-owned `flushOutgoing` messages the encoder does NOT reproduce and that are
   * NOT an echo of this tick's inbound — i.e. genuine local writes the cutover would drop.
   * Must be empty before `crdt-response` can be driven by the encoder (cutover blocker).
   */
  uncovered: string[]
}

const MAX_MISMATCHES = 12

/** Key set of (entity, componentId) and deleted entities present in inbound this tick. */
function buildInboundIndex(inbound: Uint8Array[] | undefined): {
  keys: Set<string>
  deletedEntities: Set<number>
} {
  const keys = new Set<string>()
  const deletedEntities = new Set<number>()
  if (!inbound) return { keys, deletedEntities }
  for (const chunk of inbound) {
    const buf = new ReadWriteByteBuffer(chunk)
    // A malformed/partial chunk must never throw out of the audit — a parse error here
    // would otherwise propagate through checkEncoderParity into the crdt-send handler.
    try {
      let msg = readMessage(buf)
      while (msg) {
        if (msg.type === CrdtMessageType.DELETE_ENTITY || msg.type === CrdtMessageType.DELETE_ENTITY_NETWORK) {
          deletedEntities.add(msg.entityId)
        } else if ('componentId' in msg) {
          keys.add(`${msg.componentId}:${msg.entityId}`)
        }
        msg = readMessage(buf)
      }
    } catch {
      // Best-effort: keep whatever we decoded before the error.
    }
  }
  return { keys, deletedEntities }
}

/**
 * Shadow-mode oracle: for every covered renderer-owned PUT that `flushOutgoing()`
 * produced, the encoder's serialized value for that `(entity, componentId)` must be
 * byte-identical to what the engine's independent serializer wrote. This is the
 * meaningful cross-check — two independent serializers must agree — and it catches
 * wrong values, stale (missed-change) values, and uncovered keys.
 *
 * We intentionally do **not** flag "encoder emitted a key the engine didn't flush
 * this tick": the engine flushes once-written stable components (e.g. `MainCamera`)
 * on an earlier round-trip, so the encoder's first emission legitimately lands on a
 * later tick. The encoder's dedup also means an unchanged value isn't re-emitted
 * while the engine re-emits on every `createOrReplace` — both are correct, neither
 * is a mismatch because `serializedFor` still holds the right bytes.
 *
 * Grow-only `APPEND` messages are validated as a per-`(entity,componentId)` **multiset**
 * against the values the encoder appended in the same `encode()` call: every appended
 * value the engine flushed this tick must have a byte-identical counterpart the encoder
 * produced (and vice-versa, since both observe the same flush boundary).
 */
export function checkEncoderParity(
  encoder: CrdtEncoder,
  flushOutgoing: Uint8Array[],
  inbound?: Uint8Array[]
): EncoderParityReport {
  const mismatches: string[] = []
  const uncovered: string[] = []
  let checked = 0

  // Multiset of the encoder's appends this tick: `comp:entity` → remaining blobs.
  const pendingAppends = new Map<string, Uint8Array[]>()
  for (const a of encoder.emittedAppends) {
    const k = `${a.componentId}:${a.entity}`
    const list = pendingAppends.get(k)
    if (list) list.push(a.data)
    else pendingAppends.set(k, [a.data])
  }

  const { keys: inboundKeys, deletedEntities: inboundDeleted } = buildInboundIndex(inbound)
  const noteUncovered = (desc: string) => {
    if (uncovered.length < MAX_MISMATCHES) uncovered.push(desc)
  }

  for (const chunk of flushOutgoing) {
    const buf = new ReadWriteByteBuffer(chunk)
    // Guard the whole chunk: a parse error mid-stream must not throw out of the audit
    // (that would crash the crdt-send handler). Record it as a mismatch so the cutover
    // gate falls back to the engine bytes for this tick rather than shipping a payload we
    // could not fully verify.
    try {
    let msg = readMessage(buf)
    while (msg) {
      const entity = msg.entityId as Entity
      if (msg.type === CrdtMessageType.PUT_COMPONENT || msg.type === CrdtMessageType.PUT_COMPONENT_NETWORK) {
        const componentId = msg.componentId
        if (encoder.covers(entity, componentId)) {
          checked++
          const encoded = encoder.serializedFor(entity, componentId)
          if (!encoded) {
            if (mismatches.length < MAX_MISMATCHES) {
              mismatches.push(`missing in encoder: entity=${entity} comp=${componentId}`)
            }
          } else if (!bytesEqual(encoded, msg.data)) {
            if (mismatches.length < MAX_MISMATCHES) {
              mismatches.push(
                `byte mismatch: entity=${entity} comp=${componentId} (enc ${encoded.length}B vs flush ${msg.data.length}B)`
              )
            }
          }
        } else if (!inboundKeys.has(`${componentId}:${entity}`)) {
          noteUncovered(`PUT entity=${entity} comp=${componentId}`)
        }
      } else if (msg.type === CrdtMessageType.APPEND_VALUE) {
        const componentId = msg.componentId
        const data = msg.data
        if (encoder.covers(entity, componentId)) {
          checked++
          const list = pendingAppends.get(`${componentId}:${entity}`)
          const idx = list ? list.findIndex((b) => bytesEqual(b, data)) : -1
          if (idx === -1) {
            if (mismatches.length < MAX_MISMATCHES) {
              mismatches.push(`missing append in encoder: entity=${entity} comp=${componentId} (${data.length}B)`)
            }
          } else {
            list!.splice(idx, 1) // consume the matched value from the multiset
          }
        } else if (!inboundKeys.has(`${componentId}:${entity}`)) {
          noteUncovered(`APPEND entity=${entity} comp=${componentId}`)
        }
      } else if (msg.type === CrdtMessageType.DELETE_COMPONENT || msg.type === CrdtMessageType.DELETE_COMPONENT_NETWORK) {
        const componentId = msg.componentId
        if (!inboundKeys.has(`${componentId}:${entity}`)) {
          noteUncovered(`DELETE_COMPONENT entity=${entity} comp=${componentId}`)
        }
      } else if (msg.type === CrdtMessageType.DELETE_ENTITY || msg.type === CrdtMessageType.DELETE_ENTITY_NETWORK) {
        if (!inboundDeleted.has(entity)) {
          noteUncovered(`DELETE_ENTITY entity=${entity}`)
        }
      }
      msg = readMessage(buf)
    }
    } catch (err) {
      if (mismatches.length < MAX_MISMATCHES) {
        mismatches.push(`flush parse error: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }

  return { checked, mismatches, uncovered }
}

export interface SnapshotParityReport {
  /** Distinct PUT `(componentId:entity)` keys decoded from the engine dump. */
  engineKeys: number
  /** Distinct PUT keys decoded from the projection+encoder snapshot. */
  newKeys: number
  /** Keys the engine dumped that the new snapshot is missing (or whose value differs / is absent). */
  missing: string[]
  /** Keys present in both whose serialized bytes differ. */
  mismatched: string[]
  /** Keys the new snapshot has that the engine did not dump. */
  extra: string[]
}

/** Decode a CRDT byte stream into PUT `(componentId:entity)` → latest bytes (timestamps ignored). */
function decodeSnapshotPuts(chunks: Uint8Array[], ignoreComponentIds?: Set<number>): Map<string, Uint8Array> {
  const puts = new Map<string, Uint8Array>()
  for (const chunk of chunks) {
    const buf = new ReadWriteByteBuffer(chunk)
    try {
      let msg = readMessage(buf)
      while (msg) {
        if (
          (msg.type === CrdtMessageType.PUT_COMPONENT || msg.type === CrdtMessageType.PUT_COMPONENT_NETWORK) &&
          'componentId' in msg &&
          !ignoreComponentIds?.has(msg.componentId)
        ) {
          puts.set(`${msg.componentId}:${msg.entityId}`, msg.data)
        }
        msg = readMessage(buf)
      }
    } catch {
      // best-effort: keep whatever decoded before the error
    }
  }
  return puts
}

/**
 * Boot-snapshot oracle: compare the projection+encoder `getState` snapshot against the engine's
 * `dumpCrdtStateToBuffer` output, by PUT value bytes (timestamps deliberately ignored — the two
 * serializers assign Lamport counters independently, but identical values must produce identical
 * bytes via the shared schema). APPEND/grow-only and presence-only network components are out of
 * scope here (empty at boot; network handled before the snapshot cutover).
 */
export function compareCrdtSnapshots(
  engine: Uint8Array[],
  next: Uint8Array[],
  ignoreComponentIds?: Set<number>
): SnapshotParityReport {
  const e = decodeSnapshotPuts(engine, ignoreComponentIds)
  const n = decodeSnapshotPuts(next, ignoreComponentIds)
  const missing: string[] = []
  const mismatched: string[] = []
  const extra: string[] = []
  for (const [key, data] of e) {
    const nd = n.get(key)
    if (!nd) {
      if (missing.length < MAX_MISMATCHES) missing.push(key)
    } else if (!bytesEqual(nd, data)) {
      if (mismatched.length < MAX_MISMATCHES) mismatched.push(key)
    }
  }
  for (const key of n.keys()) {
    if (!e.has(key) && extra.length < MAX_MISMATCHES) extra.push(key)
  }
  return { engineKeys: e.size, newKeys: n.size, missing, mismatched, extra }
}
