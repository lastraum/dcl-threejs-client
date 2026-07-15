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
import { shouldBlockPlayerLocomotionClear } from './inputModifierLocomotionGuard'
import { preregisterRendererInjectedComponents } from './preregisterRendererInjectedComponents'
import {
  resolveWorkerPointerEvents,
  resolveWorkerUiBackground,
  resolveWorkerUiDropdown,
  resolveWorkerUiInput,
  resolveWorkerUiText,
  resolveWorkerUiTransform
} from './resolveBundledUiComponents'

/** Worker-authoritative LWW — main must not echo these back during an open pointer session. */
export const WORKER_AUTHORITATIVE_COMPONENT_IDS = new Set([
  1075, // MainCamera
  1078 // InputModifier
])

/**
 * Scene UI LWW ids stripped from cooperative CRDT (phase-4 mount snapshot only).
 *
 * Do NOT include PointerEvents (1062) — PE is shared by world props and UI. Stripping
 * it left main with only UI-snapshot PE (entities=1 meshes=0) and killed in-world hover/click.
 * PE still rides normal CRDT; mount snapshot may still include PE for UI LWW lag fill.
 */
export const WORKER_SCENE_UI_COMPONENT_IDS = new Set([
  1050, // UiTransform
  1052, // UiText
  1053, // UiBackground
  1093, // UiInput
  1094 // UiDropdown
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
  resetMainCameraEgressBaseline()
  resetInputModifierEgressBaseline()
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

/**
 * Snapshot values must be plain data for main-thread projection (no wire deserialize).
 * Prefer JSON — `structuredClone` on some ECS/protobuf-shaped objects drops fields
 * (empty UiText / missing colors → blank labels in the DOM painter).
 */
function toPlainComponentValue(value: unknown): unknown {
  if (value == null || typeof value !== 'object') return value
  try {
    return JSON.parse(JSON.stringify(value))
  } catch {
    /* fall through */
  }
  try {
    if (typeof structuredClone === 'function') return structuredClone(value)
  } catch {
    /* fall through */
  }
  return value
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
      stats.uiText++
      break
    case 1053:
      stats.uiBackground++
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

function isWorkerAuthoritativeComponentMessage(msg: CrdtMessage): boolean {
  if (
    msg.type === CrdtMessageType.PUT_COMPONENT ||
    msg.type === CrdtMessageType.PUT_COMPONENT_NETWORK ||
    msg.type === CrdtMessageType.DELETE_COMPONENT ||
    msg.type === CrdtMessageType.DELETE_COMPONENT_NETWORK
  ) {
    return WORKER_AUTHORITATIVE_COMPONENT_IDS.has(msg.componentId)
  }
  return false
}

function filterWorkerAuthoritativeCrdtBytes(data: Uint8Array): Uint8Array {
  if (!data.byteLength) return data
  const out = new ReadWriteByteBuffer()
  const readBuf = new ReadWriteByteBuffer(data)
  let wrote = false
  try {
    let msg = readMessage(readBuf)
    while (msg) {
      if (!isWorkerAuthoritativeComponentMessage(msg)) {
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

/** Remove worker-authoritative PUT/DELETE — inbound during open pointer session. */
export function stripWorkerAuthoritativeCrdtBytes(data: Uint8Array): Uint8Array {
  return filterWorkerAuthoritativeCrdtBytes(data)
}

const MAIN_CAMERA_COMPONENT_ID = 1075
const INPUT_MODIFIER_COMPONENT_ID = 1078

let lastMainCameraEgressKey = ''
let lastInputModifierEgressKey = ''

export function resetMainCameraEgressBaseline(): void {
  lastMainCameraEgressKey = ''
}

export function resetInputModifierEgressBaseline(): void {
  lastInputModifierEgressKey = ''
}

/** @deprecated Use resetMainCameraEgressBaseline */
export function resetWorkerMainCameraEgressBaseline(): void {
  resetMainCameraEgressBaseline()
}

function mainCameraEgressKey(engine: IEngine): string {
  const MainCamera = generated.MainCamera(engine)
  const entity = engine.CameraEntity as Entity
  const value = MainCamera.getOrNull(entity) as { virtualCameraEntity?: number | null } | null
  const vc = value?.virtualCameraEntity
  return vc === undefined || vc === null ? 'cleared' : `vc=${vc}`
}

function inputModifierEgressKey(engine: IEngine): string {
  const InputModifier = generated.InputModifier(engine)
  const entity = engine.PlayerEntity as Entity
  const value = InputModifier.getOrNull(entity)
  if (!value) return 'cleared'
  const dataBuf = new ReadWriteByteBuffer()
  InputModifier.schema.serialize(value, dataBuf)
  const bytes = dataBuf.toBinary()
  return Array.from(bytes).join(',')
}

export function stripComponentIdsFromCrdtBytes(data: Uint8Array, componentIds: ReadonlySet<number>): Uint8Array {
  if (!data.byteLength || !componentIds.size) return data
  const out = new ReadWriteByteBuffer()
  const readBuf = new ReadWriteByteBuffer(data)
  let wrote = false
  try {
    let msg = readMessage(readBuf)
    while (msg) {
      const isStripped =
        (msg.type === CrdtMessageType.PUT_COMPONENT ||
          msg.type === CrdtMessageType.PUT_COMPONENT_NETWORK ||
          msg.type === CrdtMessageType.DELETE_COMPONENT ||
          msg.type === CrdtMessageType.DELETE_COMPONENT_NETWORK) &&
        componentIds.has(msg.componentId)
      if (!isStripped) {
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

function crdtBlobTouchesComponent(data: Uint8Array, componentId: number): boolean {
  if (!data.byteLength) return false
  const readBuf = new ReadWriteByteBuffer(data)
  try {
    let msg = readMessage(readBuf)
    while (msg) {
      if (
        (msg.type === CrdtMessageType.PUT_COMPONENT ||
          msg.type === CrdtMessageType.PUT_COMPONENT_NETWORK ||
          msg.type === CrdtMessageType.DELETE_COMPONENT ||
          msg.type === CrdtMessageType.DELETE_COMPONENT_NETWORK) &&
        msg.componentId === componentId
      ) {
        return true
      }
      msg = readMessage(readBuf)
    }
  } catch {
    return false
  }
  return false
}

function encodeLiveMainCameraPut(engine: IEngine): Uint8Array | null {
  preregisterRendererInjectedComponents(engine)
  const MainCamera = generated.MainCamera(engine)
  const entity = engine.CameraEntity as Entity
  const value = MainCamera.getOrNull(entity)
  const dataBuf = new ReadWriteByteBuffer()
  MainCamera.schema.serialize(value ?? {}, dataBuf)
  const out = new ReadWriteByteBuffer()
  const ts = nextLamport(entity, MAIN_CAMERA_COMPONENT_ID)
  PutComponentOperation.write(entity, ts, MainCamera.componentId, dataBuf.toBinary(), out)
  return out.toBinary()
}

function encodeLiveInputModifierPut(engine: IEngine): Uint8Array | null {
  preregisterRendererInjectedComponents(engine)
  const InputModifier = generated.InputModifier(engine)
  const entity = engine.PlayerEntity as Entity
  const value = InputModifier.getOrNull(entity)
  if (!value) return null
  const dataBuf = new ReadWriteByteBuffer()
  InputModifier.schema.serialize(value, dataBuf)
  const out = new ReadWriteByteBuffer()
  const ts = nextLamport(entity, INPUT_MODIFIER_COMPONENT_ID)
  PutComponentOperation.write(entity, ts, InputModifier.componentId, dataBuf.toBinary(), out)
  return out.toBinary()
}

/**
 * Append live MainCamera + InputModifier snapshots — pointer flush when deferred non-Ui queue is empty.
 */
export function reconcileWorkerAuthoritativeCrdtEgress(engine: IEngine, data: Uint8Array): Uint8Array {
  let out = reconcileMainCameraCrdtEgress(engine, data)
  out = reconcileInputModifierCrdtEgress(engine, out)
  return out
}

/**
 * MainCamera egress — stale `{}` clears in the transport queue must not override an active VC bind.
 */
export function reconcileMainCameraCrdtEgress(engine: IEngine, data: Uint8Array): Uint8Array {
  const liveKey = mainCameraEgressKey(engine)
  const touchesMainCamera = crdtBlobTouchesComponent(data, MAIN_CAMERA_COMPONENT_ID)
  const copy = touchesMainCamera
    ? stripComponentIdsFromCrdtBytes(data, new Set([MAIN_CAMERA_COMPONENT_ID]))
    : data
  const needsLiveSnapshot = touchesMainCamera || liveKey !== lastMainCameraEgressKey
  if (!needsLiveSnapshot) return copy

  const liveMainCamera = encodeLiveMainCameraPut(engine)
  if (!liveMainCamera?.byteLength) return copy
  lastMainCameraEgressKey = liveKey

  if (!copy.byteLength) return liveMainCamera
  const merged = new Uint8Array(copy.byteLength + liveMainCamera.byteLength)
  merged.set(copy, 0)
  merged.set(liveMainCamera, copy.byteLength)
  return merged
}

/**
 * InputModifier egress — scene-applied avatar locomotion/emote lock on PlayerEntity (not VC).
 * Strip stale wire ops and append a live engine snapshot so main projection matches worker state.
 */
export function reconcileInputModifierCrdtEgress(engine: IEngine, data: Uint8Array): Uint8Array {
  const liveKey = inputModifierEgressKey(engine)
  const touchesInputModifier = crdtBlobTouchesComponent(data, INPUT_MODIFIER_COMPONENT_ID)
  const copy = touchesInputModifier
    ? stripComponentIdsFromCrdtBytes(data, new Set([INPUT_MODIFIER_COMPONENT_ID]))
    : data
  const needsLiveSnapshot =
    touchesInputModifier ||
    liveKey !== lastInputModifierEgressKey ||
    shouldBlockPlayerLocomotionClear(engine)
  if (!needsLiveSnapshot) return copy

  const liveInputModifier = encodeLiveInputModifierPut(engine)
  if (!liveInputModifier?.byteLength) return copy
  lastInputModifierEgressKey = liveKey

  if (!copy.byteLength) return liveInputModifier
  const merged = new Uint8Array(copy.byteLength + liveInputModifier.byteLength)
  merged.set(copy, 0)
  merged.set(liveInputModifier, copy.byteLength)
  return merged
}

type LwwCrdtEntry = { msg: CrdtMessage; timestamp: number }

function lwwEntryKey(msg: CrdtMessage): string | null {
  if (
    msg.type === CrdtMessageType.PUT_COMPONENT ||
    msg.type === CrdtMessageType.PUT_COMPONENT_NETWORK ||
    msg.type === CrdtMessageType.DELETE_COMPONENT ||
    msg.type === CrdtMessageType.DELETE_COMPONENT_NETWORK
  ) {
    return `${msg.componentId}:${msg.entityId}`
  }
  return null
}

/** Merge pointer-deferred chunks — highest timestamp wins per (componentId, entity). */
export function coalesceCrdtChunksLww(chunks: Uint8Array[]): Uint8Array[] {
  if (chunks.length <= 1) return chunks
  const lww = new Map<string, LwwCrdtEntry>()
  const passthrough: CrdtMessage[] = []

  for (const chunk of chunks) {
    if (!chunk.byteLength) continue
    const readBuf = new ReadWriteByteBuffer(chunk)
    try {
      let msg = readMessage(readBuf)
      while (msg) {
        const key = lwwEntryKey(msg)
        if (!key) {
          passthrough.push(msg)
        } else {
          const ts =
            'timestamp' in msg && typeof msg.timestamp === 'number' ? msg.timestamp : 0
          const prev = lww.get(key)
          if (!prev || ts >= prev.timestamp) lww.set(key, { msg, timestamp: ts })
        }
        msg = readMessage(readBuf)
      }
    } catch {
      return chunks
    }
  }

  const out = new ReadWriteByteBuffer()
  for (const msg of passthrough) rewriteCrdtMessage(msg, out)
  for (const entry of lww.values()) rewriteCrdtMessage(entry.msg, out)
  const merged = out.toBinary()
  return merged.byteLength ? [merged] : []
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

/** Mount entity ids currently holding UiTransform (worker authority set). */
export function collectWorkerUiMountEntityIds(engine: IEngine): number[] {
  preregisterRendererInjectedComponents(engine)
  const UiTransform = resolveWorkerUiTransform(engine)
  const out: number[] = []
  for (const [entity] of engine.getEntitiesWith(UiTransform)) {
    out.push(entity as number)
  }
  return out
}

/**
 * Plain component values for mounted UI entities — structured egress to main.
 * Optional `onlyEntities` limits rows to dirty entities (full mount ids travel separately).
 * Main applies directly to projection (no bundled/client schema wire round-trip).
 */
export function collectWorkerUiMountSnapshot(
  engine: IEngine,
  onlyEntities?: ReadonlySet<number>
): WorkerUiMountSnapshotRow[] {
  preregisterRendererInjectedComponents(engine)
  const UiTransform = resolveWorkerUiTransform(engine)
  const UiBackground = resolveWorkerUiBackground(engine)
  const UiText = resolveWorkerUiText(engine)
  const UiInput = resolveWorkerUiInput(engine)
  const UiDropdown = resolveWorkerUiDropdown(engine)
  const PointerEvents = resolveWorkerPointerEvents(engine)
  // Always tag rows with the resolved component's real id (never hardcoded swaps).
  const pairs: Array<{ read: BundledUiRead; componentId: number }> = [
    { read: UiTransform as unknown as BundledUiRead, componentId: UiTransform.componentId },
    { read: UiText as unknown as BundledUiRead, componentId: UiText.componentId },
    { read: UiBackground as unknown as BundledUiRead, componentId: UiBackground.componentId },
    { read: UiInput as unknown as BundledUiRead, componentId: UiInput.componentId },
    { read: UiDropdown as unknown as BundledUiRead, componentId: UiDropdown.componentId },
    { read: PointerEvents as unknown as BundledUiRead, componentId: PointerEvents.componentId }
  ]
  const rows: WorkerUiMountSnapshotRow[] = []
  const pushEntity = (id: Entity) => {
    for (const { read, componentId } of pairs) {
      if (!read.has(id)) continue
      const value = read.getOrNull(id)
      if (value == null) continue
      rows.push({ entity: id as number, componentId, value: toPlainComponentValue(value) })
    }
  }
  if (onlyEntities) {
    for (const entity of onlyEntities) {
      const id = entity as Entity
      if (!UiTransform.has(id)) continue
      pushEntity(id)
    }
    return rows
  }
  for (const [entity] of engine.getEntitiesWith(UiTransform)) {
    pushEntity(entity as Entity)
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