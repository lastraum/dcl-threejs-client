import type { Entity, IEngine } from '@dcl/ecs'
import * as extended from '@dcl/ecs/dist/components'
import * as generated from '@dcl/ecs/dist/components/generated/index.gen'
import { preregisterRendererInjectedComponents } from './preregisterRendererInjectedComponents'
import { ReadWriteByteBuffer } from '@dcl/ecs/dist/serialization/ByteBuffer'
import { DeleteComponent } from '@dcl/ecs/dist/serialization/crdt/deleteComponent'
import { DeleteEntity } from '@dcl/ecs/dist/serialization/crdt/deleteEntity'
import { DeleteComponentNetwork } from '@dcl/ecs/dist/serialization/crdt/network/deleteComponentNetwork'
import { DeleteEntityNetwork } from '@dcl/ecs/dist/serialization/crdt/network/deleteEntityNetwork'
import { PutNetworkComponentOperation } from '@dcl/ecs/dist/serialization/crdt/network/putComponentNetwork'
import { AppendValueOperation } from '@dcl/ecs/dist/serialization/crdt/appendValue'
import { readMessage } from '@dcl/ecs/dist/serialization/crdt/message'
import { PutComponentOperation } from '@dcl/ecs/dist/serialization/crdt/putComponent'
import { CrdtMessageType, type CrdtMessage } from '@dcl/ecs/dist/serialization/crdt/types'

/** `core::Transform` component id (SDK7 fixed). */
const TRANSFORM_COMPONENT_ID = 1

/** SDK7 reserved entities — renderer-owned Transform must land same-tick on the worker. */
const RESERVED_ENTITIES = new Set<Entity>([0 as Entity, 1 as Entity, 2 as Entity])

/** `core::TweenState` — renderer-driven tween progress for worker `tweenCompleted()`. */
const TWEEN_STATE_ID = 1103
/** `core::RaycastResult` — renderer raycast hits for worker `raycastSystem` callbacks. */
const RAYCAST_RESULT_ID = 1068
/** `core::GltfContainerLoadingState` — renderer reports GLB load progress (ADR-215). */
const GLTF_CONTAINER_LOADING_STATE_ID = 1049
/** `core::VideoPlayer` — renderer syncs `playing` on natural end for scene toggle parity. */
const VIDEO_PLAYER_ID = 1043
/** `core::UiCanvasInformation` — renderer injects virtual canvas size for scene UI systems. */
const UI_CANVAS_INFORMATION_ID = 1054
/** `core::UiInputResult` — renderer writes typed text back to scene systems. */
const UI_INPUT_RESULT_ID = 1095
/** `core::UiDropdownResult` — renderer writes selected index back to scene systems. */
const UI_DROPDOWN_RESULT_ID = 1096
/** `core::CameraMode` — renderer reports 1st/3rd person on CameraEntity. */
const CAMERA_MODE_ID = 1072
/** `core::PointerLock` — renderer reports pointer-lock state on CameraEntity. */
const POINTER_LOCK_ID = 1074
/** `core::RealmInfo` — renderer injects scene-room connect for SDK network catch-up. */
const REALM_INFO_ID = 1106

export type RendererLwwInjectCounts = {
  tweenPuts: number
  raycastPuts: number
  gltfLoadingStatePuts: number
  /** FINISHED / FINISHED_WITH_ERROR / NOT_FOUND — SpaceRunner load-freeze release signal. */
  gltfLoadingStateTerminalPuts: number
  videoPlayerPuts: number
  uiCanvasPuts: number
  uiInputResultPuts: number
  uiDropdownResultPuts: number
  cameraModePuts: number
  pointerLockPuts: number
  realmInfoPuts: number
  reservedTransformPuts: number
}

/** LoadingState: UNKNOWN=0 LOADING=1 NOT_FOUND=2 FINISHED_WITH_ERROR=3 FINISHED=4 */
function isTerminalGltfLoadingState(currentState: unknown): boolean {
  const s = typeof currentState === 'number' ? currentState : Number(currentState)
  return s === 2 || s === 3 || s === 4
}

/** Player (1) + Camera (2) — free-flight may own these; Root (0) always host-owned. */
const RESERVED_PLAYER_CAMERA = new Set<Entity>([1 as Entity, 2 as Entity])

export type InjectRendererLwwOpts = {
  /**
   * Scene free-flight (InputModifier freeze, not MOVE CAMERA): skip Player/Camera
   * Transform inject so main avatar feet cannot undo WASD motion every grow-only / inbound.
   */
  skipReservedPlayerCameraTransform?: boolean
}

/**
 * Apply renderer-encoded LWW PUTs for renderer-owned dynamic components directly on the scene worker engine.
 * Mirrors `injectTriggerAreaAppendsOnEngine` — same-tick delivery without waiting for transport LWW.
 */
export function injectRendererLwwPutsOnEngine(
  engine: IEngine,
  chunks: Uint8Array[],
  opts?: InjectRendererLwwOpts
): RendererLwwInjectCounts {
  preregisterRendererInjectedComponents(engine)
  const Transform = extended.Transform(engine)
  const transformId = Transform.componentId
  const TweenState = generated.TweenState(engine)
  const RaycastResult = generated.RaycastResult(engine)
  const GltfContainerLoadingState = generated.GltfContainerLoadingState(engine)
  const VideoPlayer = generated.VideoPlayer(engine)
  const UiCanvasInformation = generated.UiCanvasInformation(engine)
  const UiInputResult = generated.UiInputResult(engine)
  const UiDropdownResult = generated.UiDropdownResult(engine)
  const CameraMode = generated.CameraMode(engine)
  const PointerLock = generated.PointerLock(engine)
  const RealmInfo = generated.RealmInfo(engine)
  const skipPlayerCamera = opts?.skipReservedPlayerCameraTransform === true
  let tweenPuts = 0
  let raycastPuts = 0
  let gltfLoadingStatePuts = 0
  let gltfLoadingStateTerminalPuts = 0
  let videoPlayerPuts = 0
  let uiCanvasPuts = 0
  let uiInputResultPuts = 0
  let uiDropdownResultPuts = 0
  let cameraModePuts = 0
  let pointerLockPuts = 0
  let realmInfoPuts = 0
  let reservedTransformPuts = 0

  for (const chunk of chunks) {
    const buf = new ReadWriteByteBuffer(chunk)
    let msg = readMessage(buf)
    while (msg) {
      if (msg.type === CrdtMessageType.PUT_COMPONENT) {
        if (msg.componentId === transformId && RESERVED_ENTITIES.has(msg.entityId as Entity)) {
          if (skipPlayerCamera && RESERVED_PLAYER_CAMERA.has(msg.entityId as Entity)) {
            // Scene owns free-flight PE/Camera — ignore host re-pin.
          } else {
            const valueBuf = new ReadWriteByteBuffer(msg.data)
            const value = Transform.schema.deserialize(valueBuf)
            Transform.createOrReplace(msg.entityId as Entity, value)
            reservedTransformPuts++
          }
        } else if (msg.componentId === TWEEN_STATE_ID) {
          const valueBuf = new ReadWriteByteBuffer(msg.data)
          const value = TweenState.schema.deserialize(valueBuf)
          TweenState.createOrReplace(msg.entityId as Entity, value)
          tweenPuts++
        } else if (msg.componentId === RAYCAST_RESULT_ID) {
          const valueBuf = new ReadWriteByteBuffer(msg.data)
          const value = RaycastResult.schema.deserialize(valueBuf)
          RaycastResult.createOrReplace(msg.entityId as Entity, value)
          raycastPuts++
        } else if (msg.componentId === GLTF_CONTAINER_LOADING_STATE_ID) {
          const valueBuf = new ReadWriteByteBuffer(msg.data)
          const value = GltfContainerLoadingState.schema.deserialize(valueBuf)
          GltfContainerLoadingState.createOrReplace(msg.entityId as Entity, value)
          gltfLoadingStatePuts++
          const currentState = (value as { currentState?: number } | null)?.currentState
          if (isTerminalGltfLoadingState(currentState)) {
            gltfLoadingStateTerminalPuts++
          }
        } else if (msg.componentId === VIDEO_PLAYER_ID) {
          const valueBuf = new ReadWriteByteBuffer(msg.data)
          const value = VideoPlayer.schema.deserialize(valueBuf)
          VideoPlayer.createOrReplace(msg.entityId as Entity, value)
          videoPlayerPuts++
        } else if (msg.componentId === UI_CANVAS_INFORMATION_ID && msg.entityId === 0) {
          const valueBuf = new ReadWriteByteBuffer(msg.data)
          const value = UiCanvasInformation.schema.deserialize(valueBuf)
          UiCanvasInformation.createOrReplace(msg.entityId as Entity, value)
          uiCanvasPuts++
        } else if (msg.componentId === UI_INPUT_RESULT_ID) {
          const valueBuf = new ReadWriteByteBuffer(msg.data)
          const value = UiInputResult.schema.deserialize(valueBuf)
          UiInputResult.createOrReplace(msg.entityId as Entity, value)
          uiInputResultPuts++
        } else if (msg.componentId === UI_DROPDOWN_RESULT_ID) {
          const valueBuf = new ReadWriteByteBuffer(msg.data)
          const value = UiDropdownResult.schema.deserialize(valueBuf)
          UiDropdownResult.createOrReplace(msg.entityId as Entity, value)
          uiDropdownResultPuts++
        } else if (msg.componentId === CAMERA_MODE_ID) {
          const valueBuf = new ReadWriteByteBuffer(msg.data)
          const value = CameraMode.schema.deserialize(valueBuf)
          CameraMode.createOrReplace(msg.entityId as Entity, value)
          cameraModePuts++
        } else if (msg.componentId === POINTER_LOCK_ID) {
          const valueBuf = new ReadWriteByteBuffer(msg.data)
          const value = PointerLock.schema.deserialize(valueBuf)
          PointerLock.createOrReplace(msg.entityId as Entity, value)
          pointerLockPuts++
        } else if (msg.componentId === REALM_INFO_ID && msg.entityId === 0) {
          const valueBuf = new ReadWriteByteBuffer(msg.data)
          const value = RealmInfo.schema.deserialize(valueBuf)
          RealmInfo.createOrReplace(msg.entityId as Entity, value)
          realmInfoPuts++
        }
      }
      msg = readMessage(buf)
    }
  }

  return {
    tweenPuts,
    raycastPuts,
    gltfLoadingStatePuts,
    gltfLoadingStateTerminalPuts,
    videoPlayerPuts,
    uiCanvasPuts,
    uiInputResultPuts,
    uiDropdownResultPuts,
    cameraModePuts,
    pointerLockPuts,
    realmInfoPuts,
    reservedTransformPuts
  }
}

/**
 * Drop Player/Camera Transform PUTs from renderer inbound chunks so transport
 * apply cannot re-pin free-flight PE after inject skipped them.
 */
export function stripReservedPlayerCameraTransformsFromChunks(chunks: Uint8Array[]): Uint8Array[] {
  const out: Uint8Array[] = []
  for (const chunk of chunks) {
    if (!chunk.byteLength) continue
    const writeBuf = new ReadWriteByteBuffer()
    const readBuf = new ReadWriteByteBuffer(chunk)
    let wrote = false
    let dropped = false
    try {
      let msg = readMessage(readBuf)
      while (msg) {
        const drop =
          (msg.type === CrdtMessageType.PUT_COMPONENT ||
            msg.type === CrdtMessageType.PUT_COMPONENT_NETWORK) &&
          msg.componentId === TRANSFORM_COMPONENT_ID &&
          RESERVED_PLAYER_CAMERA.has(msg.entityId as Entity)
        if (drop) {
          dropped = true
        } else {
          rewriteCrdtMessage(msg, writeBuf)
          wrote = true
        }
        msg = readMessage(readBuf)
      }
    } catch {
      out.push(chunk)
      continue
    }
    if (!dropped) {
      out.push(chunk)
      continue
    }
    if (wrote) {
      const bin = writeBuf.toBinary()
      if (bin.byteLength) out.push(bin)
    }
  }
  return out
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