import type { Entity } from '@dcl/ecs'
import type { PBTriggerAreaResult } from '@dcl/ecs/dist/components/generated/pb/decentraland/sdk/components/trigger_area_result.gen'
import type { MirrorComponents } from '../bridge/mirrorComponents'
import { ColliderLayer } from '../collision/ColliderLayer'

/** Matches `TriggerAreaEventType.TAET_ENTER` / `TAET_EXIT`. */
export const TAET_ENTER = 0
export const TAET_EXIT = 2

/** Local player triggerer layers written on TriggerAreaResult. */
export const LOCAL_PLAYER_LAYERS = ColliderLayer.CL_PLAYER | ColliderLayer.CL_MAIN_PLAYER

export type TriggerAreaPlayerTransform = {
  position: { x: number; y: number; z: number }
  rotation: { x: number; y: number; z: number; w: number }
  scale: { x: number; y: number; z: number }
}

export function buildTriggerAreaResult(
  triggerEntity: Entity,
  playerEntity: Entity,
  playerTransform: TriggerAreaPlayerTransform,
  areaTransform: TriggerAreaPlayerTransform | null,
  eventType: number,
  timestamp: number
): PBTriggerAreaResult {
  return {
    triggeredEntity: triggerEntity,
    triggeredEntityPosition: areaTransform
      ? { ...areaTransform.position }
      : { x: 0, y: 0, z: 0 },
    triggeredEntityRotation: areaTransform
      ? { ...areaTransform.rotation }
      : { x: 0, y: 0, z: 0, w: 1 },
    eventType,
    timestamp,
    trigger: {
      entity: playerEntity,
      layers: LOCAL_PLAYER_LAYERS,
      position: { ...playerTransform.position },
      rotation: { ...playerTransform.rotation },
      scale: { ...playerTransform.scale }
    }
  }
}

export function appendTriggerAreaResult(
  ecs: MirrorComponents,
  triggerEntity: Entity,
  result: PBTriggerAreaResult,
  recordAppend?: (componentId: number, entity: Entity, value: unknown) => void
): void {
  ecs.TriggerAreaResult.addValue(triggerEntity, result)
  recordAppend?.(ecs.TriggerAreaResult.componentId, triggerEntity, result)
}