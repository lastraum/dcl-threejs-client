/**
 * Host-owned LWW write on the guest @dcl/ecs engine without dirtying sendMessages.
 * Host injects via updateFromCrdt (lastSentData updated, dirtyIterator not).
 */
import type { Entity } from '@dcl/ecs'
import type { CrdtMessageBody } from '@dcl/ecs/dist/serialization/crdt'
import { CrdtMessageType } from '@dcl/ecs/dist/serialization/crdt/types'
import { ReadWriteByteBuffer } from '@dcl/ecs/dist/serialization/ByteBuffer'

/** Reserved Transform (entity 0/1/2) + host result/info LWW — never scene egress. */
export const HOST_OWNED_LWW_COMPONENT_IDS = new Set([
  1, // Transform — only reserved entities stripped (see isHostOwnedReservedTransform)
  1048, // EngineInfo
  1054, // UiCanvasInformation
  1072, // CameraMode
  1074, // PointerLock
  1106, // RealmInfo
  1209, // PrimaryPointerInfo
  1103, // TweenState
  1068, // RaycastResult
  1049, // GltfContainerLoadingState
  1095, // UiInputResult
  1096 // UiDropdownResult
])

const RESERVED_TRANSFORM_ENTITIES = new Set([0, 1, 2])

export function isHostOwnedReservedTransform(componentId: number, entityId: number): boolean {
  return componentId === 1 && RESERVED_TRANSFORM_ENTITIES.has(entityId)
}

export function isHostOwnedLwwEgress(componentId: number, entityId: number): boolean {
  if (isHostOwnedReservedTransform(componentId, entityId)) return true
  if (componentId === 1) return false
  return HOST_OWNED_LWW_COMPONENT_IDS.has(componentId)
}

let hostLamport = 1_000_000

type HostLwwComponent<T> = {
  componentId: number
  schema: { serialize: (value: T, buf: ReadWriteByteBuffer) => void }
  updateFromCrdt: (body: CrdtMessageBody) => unknown
}

/** Put host value on the guest store. Does not add the entity to dirtyIterator. */
export function writeHostLwwNoDirty<T>(
  component: HostLwwComponent<T>,
  entity: number,
  value: T
): void {
  const buf = new ReadWriteByteBuffer()
  component.schema.serialize(value, buf)
  const data = buf.toCopiedBinary()
  component.updateFromCrdt({
    type: CrdtMessageType.PUT_COMPONENT,
    componentId: component.componentId,
    entityId: entity as Entity,
    timestamp: ++hostLamport,
    data
  })
}
