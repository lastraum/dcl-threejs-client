import type { Entity, IEngine } from '@dcl/ecs'
import { Engine } from '@dcl/ecs'
import * as generated from '@dcl/ecs/dist/components/generated/index.gen'
import { ReadWriteByteBuffer } from '@dcl/ecs/dist/serialization/ByteBuffer'
import { AppendValueOperation } from '@dcl/ecs/dist/serialization/crdt/appendValue'
import { DeleteComponent } from '@dcl/ecs/dist/serialization/crdt/deleteComponent'
import { DeleteEntity } from '@dcl/ecs/dist/serialization/crdt/deleteEntity'
import { readMessage } from '@dcl/ecs/dist/serialization/crdt/message'
import { DeleteComponentNetwork } from '@dcl/ecs/dist/serialization/crdt/network/deleteComponentNetwork'
import { DeleteEntityNetwork } from '@dcl/ecs/dist/serialization/crdt/network/deleteEntityNetwork'
import { PutNetworkComponentOperation } from '@dcl/ecs/dist/serialization/crdt/network/putComponentNetwork'
import { PutComponentOperation } from '@dcl/ecs/dist/serialization/crdt/putComponent'
import { CrdtMessageType, type CrdtMessage } from '@dcl/ecs/dist/serialization/crdt/types'
import { preregisterRendererInjectedComponents } from './preregisterRendererInjectedComponents'
import {
  resolveWorkerPointerEvents,
  resolveWorkerUiBackground,
  resolveWorkerUiDropdown,
  resolveWorkerUiInput,
  resolveWorkerUiText,
  resolveWorkerUiTransform
} from './resolveBundledUiComponents'

/** Scene UI LWW ids the worker owns — must match main `processWorkerOutboundCrdtBatch` uiComponentIds. */
export const WORKER_SCENE_UI_COMPONENT_IDS = new Set([
  1050, // UiTransform
  1052, // UiBackground
  1053, // UiText
  1093, // UiInput
  1094, // UiDropdown
  1062 // PointerEvents (UI hit targets)
])

/** Beat recycled-entity stale timestamps on main projection. */
const UI_OUTBOUND_TS_BASE = 1_000_000

const lamport = new Map<string, number>()

let rendererSchemaEngine: IEngine | null = null

type ComponentSchema = {
  serialize(value: unknown, writer: ReadWriteByteBuffer): void
  deserialize(reader: ReadWriteByteBuffer): unknown
}

type SchemaComponent = {
  componentId: number
  schema: ComponentSchema
}

type BundledUiRead = {
  has(entity: Entity): boolean
  getOrNull(entity: Entity): unknown
  schema: ComponentSchema
}

export type WorkerSceneUiEncodeStats = {
  uiTransform: number
  uiBackground: number
  uiText: number
  uiInput: number
  uiDropdown: number
  pointerEvents: number
  skipped: number
}

/** Client @dcl/ecs schemas — not the scene bundle's (wire bytes must match main projection). */
function rendererAlignedUiSchemas(): {
  UiTransform: SchemaComponent
  UiBackground: SchemaComponent
  UiText: SchemaComponent
  UiInput: SchemaComponent
  UiDropdown: SchemaComponent
  PointerEvents: SchemaComponent
} {
  if (!rendererSchemaEngine) {
    rendererSchemaEngine = Engine()
  }
  const eng = rendererSchemaEngine
  const UiTransform = generated.UiTransform(eng)
  const UiBackground = generated.UiBackground(eng)
  const UiText = generated.UiText(eng)
  const UiInput = generated.UiInput(eng)
  const UiDropdown = generated.UiDropdown(eng)
  const PointerEvents = generated.PointerEvents(eng)
  return {
    UiTransform: { componentId: UiTransform.componentId, schema: UiTransform.schema },
    UiBackground: { componentId: UiBackground.componentId, schema: UiBackground.schema },
    UiText: { componentId: UiText.componentId, schema: UiText.schema },
    UiInput: { componentId: UiInput.componentId, schema: UiInput.schema },
    UiDropdown: { componentId: UiDropdown.componentId, schema: UiDropdown.schema },
    PointerEvents: { componentId: PointerEvents.componentId, schema: PointerEvents.schema }
  }
}

export function resetWorkerSceneUiCrdtLamport(): void {
  lamport.clear()
}

function lamportKey(entity: Entity, componentId: number): string {
  return `${componentId}:${entity}`
}

function nextLamport(entity: Entity, componentId: number): number {
  const key = lamportKey(entity, componentId)
  const ts = (lamport.get(key) ?? UI_OUTBOUND_TS_BASE) + 1
  lamport.set(key, ts)
  return ts
}

function toPlainComponentValue(value: unknown): unknown {
  if (value == null || typeof value !== 'object') return value
  try {
    if (typeof structuredClone === 'function') return structuredClone(value)
  } catch {
    /* fall through */
  }
  return JSON.parse(JSON.stringify(value))
}

/** Prefer bundled scene wire bytes — main @dcl/ecs deserialize matches when timestamps are cleared. */
function encodeComponentWire(
  bundledSchema: ComponentSchema,
  clientSchema: ComponentSchema,
  value: unknown
): Uint8Array | null {
  try {
    const bundledBuf = new ReadWriteByteBuffer()
    bundledSchema.serialize(value, bundledBuf)
    return bundledBuf.toBinary()
  } catch {
    /* fall through */
  }
  try {
    const out = new ReadWriteByteBuffer()
    clientSchema.serialize(toPlainComponentValue(value), out)
    return out.toBinary()
  } catch {
    return null
  }
}

function bumpEncodeStat(stats: WorkerSceneUiEncodeStats, componentId: number): void {
  switch (componentId) {
    case 1050:
      stats.uiTransform++
      break
    case 1052:
      stats.uiBackground++
      break
    case 1053:
      stats.uiText++
      break
    case 1093:
      stats.uiInput++
      break
    case 1094:
      stats.uiDropdown++
      break
    case 1062:
      stats.pointerEvents++
      break
    default:
      break
  }
}

function isSceneUiComponentMessage(msg: CrdtMessage): boolean {
  if (
    msg.type === CrdtMessageType.PUT_COMPONENT ||
    msg.type === CrdtMessageType.PUT_COMPONENT_NETWORK ||
    msg.type === CrdtMessageType.DELETE_COMPONENT ||
    msg.type === CrdtMessageType.DELETE_COMPONENT_NETWORK
  ) {
    return WORKER_SCENE_UI_COMPONENT_IDS.has(msg.componentId)
  }
  return false
}

function rewriteCrdtMessage(msg: CrdtMessage, buf: ReadWriteByteBuffer): void {
  switch (msg.type) {
    case CrdtMessageType.PUT_COMPONENT:
      PutComponentOperation.write(msg.entityId, msg.timestamp, msg.componentId, msg.data, buf)
      break
    case CrdtMessageType.PUT_COMPONENT_NETWORK:
      PutNetworkComponentOperation.write(
        msg.entityId,
        msg.timestamp,
        msg.componentId,
        msg.networkId,
        msg.data,
        buf
      )
      break
    case CrdtMessageType.DELETE_COMPONENT:
      DeleteComponent.write(msg.entityId, msg.componentId, msg.timestamp, buf)
      break
    case CrdtMessageType.DELETE_COMPONENT_NETWORK:
      DeleteComponentNetwork.write(msg.entityId, msg.componentId, msg.timestamp, msg.networkId, buf)
      break
    case CrdtMessageType.APPEND_VALUE:
      AppendValueOperation.write(msg.entityId, msg.timestamp, msg.componentId, msg.data, buf)
      break
    case CrdtMessageType.DELETE_ENTITY:
      DeleteEntity.write(msg.entityId, buf)
      break
    case CrdtMessageType.DELETE_ENTITY_NETWORK:
      DeleteEntityNetwork.write(msg.entityId, msg.networkId, buf)
      break
    default:
      break
  }
}

/**
 * Hard egress filter — scene UI bytes may only leave the worker during pointer phase-4 emit.
 * Cooperative `engine.update` transport must never ship Ui* PUT/DELETE on the play path.
 */
function filterSceneUiCrdtBytes(data: Uint8Array, keepUi: boolean): Uint8Array {
  if (!data.byteLength) return data
  const out = new ReadWriteByteBuffer()
  const readBuf = new ReadWriteByteBuffer(data)
  let wrote = false
  try {
    let msg = readMessage(readBuf)
    while (msg) {
      const isUi = isSceneUiComponentMessage(msg)
      if (keepUi ? isUi : !isUi) {
        rewriteCrdtMessage(msg, out)
        wrote = true
      }
      msg = readMessage(readBuf)
    }
  } catch {
    return new Uint8Array(0)
  }
  return wrote ? out.toBinary() : new Uint8Array(0)
}

/** Remove Ui* PUT/DELETE — cooperative ticks and pointer phases 1–3. */
export function stripSceneUiCrdtBytes(data: Uint8Array): Uint8Array {
  return filterSceneUiCrdtBytes(data, false)
}

/** Strip DELETE_ENTITY for worker mount ids — passes through stripSceneUiCrdtBytes on main. */
export function stripEntityDeletesFromCrdtBytes(
  data: Uint8Array,
  protectedEntities: ReadonlySet<number>
): Uint8Array {
  if (!data.byteLength || !protectedEntities.size) return data
  const out = new ReadWriteByteBuffer()
  const readBuf = new ReadWriteByteBuffer(data)
  let wrote = false
  try {
    let msg = readMessage(readBuf)
    while (msg) {
      const entityId = msg.entityId as number
      const isProtectedDelete =
        (msg.type === CrdtMessageType.DELETE_ENTITY ||
          msg.type === CrdtMessageType.DELETE_ENTITY_NETWORK) &&
        protectedEntities.has(entityId)
      if (!isProtectedDelete) {
        rewriteCrdtMessage(msg, out)
        wrote = true
      }
      msg = readMessage(readBuf)
    }
  } catch {
    return data
  }
  return wrote ? out.toBinary() : new Uint8Array(0)
}

/** Keep only Ui* PUT/DELETE — pointer phase 4 atomic egress chunk. */
export function extractSceneUiCrdtBytes(data: Uint8Array): Uint8Array {
  return filterSceneUiCrdtBytes(data, true)
}

/** Count UiTransform PUT ops in a CRDT blob (worker log / parity). */
export function countSceneUiTransformPuts(data: Uint8Array): number {
  if (!data.byteLength) return 0
  const readBuf = new ReadWriteByteBuffer(data)
  let count = 0
  try {
    let msg = readMessage(readBuf)
    while (msg) {
      if (
        (msg.type === CrdtMessageType.PUT_COMPONENT || msg.type === CrdtMessageType.PUT_COMPONENT_NETWORK) &&
        msg.componentId === 1050
      ) {
        count++
      }
      msg = readMessage(readBuf)
    }
  } catch {
    return count
  }
  return count
}

function parseFingerprintEntityKeys(fingerprint: string): Set<string> {
  const keys = new Set<string>()
  if (!fingerprint) return keys
  for (const line of fingerprint.split('|')) {
    const colon = line.indexOf(':')
    if (colon > 0) keys.add(line.slice(0, colon))
  }
  return keys
}

type UiReadWritePair = {
  read: BundledUiRead
  write: SchemaComponent
}

export type WorkerSceneUiEncodeResult = {
  data: Uint8Array
  stats: WorkerSceneUiEncodeStats
}

export type WorkerUiMountSnapshotRow = {
  entity: number
  componentId: number
  value: unknown
}

export const UI_TRANSFORM_COMPONENT_ID = 1050

/** Mount set authority — UiTransform row entity ids from the snapshot (not a separate collect). */
export function extractSnapshotMountEntityIds(snapshot: readonly WorkerUiMountSnapshotRow[]): number[] {
  const out: number[] = []
  for (const row of snapshot) {
    if (row.componentId !== UI_TRANSFORM_COMPONENT_ID) continue
    out.push(row.entity)
  }
  return out
}

/**
 * Plain component values for every mounted UI entity — pointer phase 4 structured egress.
 * Main applies directly to projection (no bundled/client schema wire round-trip).
 */
export function collectWorkerUiMountSnapshot(engine: IEngine): WorkerUiMountSnapshotRow[] {
  preregisterRendererInjectedComponents(engine)
  const UiTransform = resolveWorkerUiTransform(engine)
  const pairs: Array<{ read: BundledUiRead; componentId: number }> = [
    { read: UiTransform as unknown as BundledUiRead, componentId: 1050 },
    { read: resolveWorkerUiBackground(engine) as BundledUiRead, componentId: 1052 },
    { read: resolveWorkerUiText(engine) as BundledUiRead, componentId: 1053 },
    { read: resolveWorkerUiInput(engine) as BundledUiRead, componentId: 1093 },
    { read: resolveWorkerUiDropdown(engine) as BundledUiRead, componentId: 1094 },
    { read: resolveWorkerPointerEvents(engine) as BundledUiRead, componentId: 1062 }
  ]
  const rows: WorkerUiMountSnapshotRow[] = []
  for (const [entity] of engine.getEntitiesWith(UiTransform)) {
    const id = entity as Entity
    for (const { read, componentId } of pairs) {
      if (!read.has(id)) continue
      const value = read.getOrNull(id)
      if (value == null) continue
      rows.push({ entity: id as number, componentId, value: toPlainComponentValue(value) })
    }
  }
  return rows
}

/**
 * Deterministic pointer-tick UI encode — bundled schema wire normalized to client schemas
 * so main projection deserializes UiText/UiBackground (not just UiTransform shells).
 */
export function encodeWorkerSceneUiCrdtOutbound(
  engine: IEngine,
  prevFingerprint: string
): WorkerSceneUiEncodeResult | null {
  preregisterRendererInjectedComponents(engine)
  const schemas = rendererAlignedUiSchemas()
  const UiTransformComponent = resolveWorkerUiTransform(engine)
  const UiTransformRead = UiTransformComponent as unknown as BundledUiRead
  const pairs: UiReadWritePair[] = [
    { read: UiTransformRead, write: schemas.UiTransform },
    { read: resolveWorkerUiBackground(engine) as BundledUiRead, write: schemas.UiBackground },
    { read: resolveWorkerUiText(engine) as BundledUiRead, write: schemas.UiText },
    { read: resolveWorkerUiInput(engine) as BundledUiRead, write: schemas.UiInput },
    { read: resolveWorkerUiDropdown(engine) as BundledUiRead, write: schemas.UiDropdown },
    { read: resolveWorkerPointerEvents(engine) as BundledUiRead, write: schemas.PointerEvents }
  ]

  const buf = new ReadWriteByteBuffer()
  const stats: WorkerSceneUiEncodeStats = {
    uiTransform: 0,
    uiBackground: 0,
    uiText: 0,
    uiInput: 0,
    uiDropdown: 0,
    pointerEvents: 0,
    skipped: 0
  }
  let wrote = false

  for (const [entity] of engine.getEntitiesWith(UiTransformComponent)) {
    const id = entity as Entity
    for (const { read, write } of pairs) {
      if (!read.has(id)) continue
      const value = read.getOrNull(id)
      if (value == null) continue
      const data = encodeComponentWire(read.schema, write.schema, value)
      if (!data?.byteLength) {
        stats.skipped++
        continue
      }
      PutComponentOperation.write(id, nextLamport(id, write.componentId), write.componentId, data, buf)
      bumpEncodeStat(stats, write.componentId)
      wrote = true
    }
  }

  const prevKeys = parseFingerprintEntityKeys(prevFingerprint)
  const liveKeys = new Set<string>()
  for (const [entity] of engine.getEntitiesWith(UiTransformComponent)) {
    liveKeys.add(String(entity))
  }
  for (const entityKey of prevKeys) {
    if (liveKeys.has(entityKey)) continue
    const id = Number(entityKey) as Entity
    for (const componentId of WORKER_SCENE_UI_COMPONENT_IDS) {
      DeleteComponent.write(id, componentId, nextLamport(id, componentId), buf)
      wrote = true
    }
  }

  if (!wrote) return null
  return { data: buf.toBinary(), stats }
}