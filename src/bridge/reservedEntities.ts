import type { Entity } from '@dcl/ecs'
import type { ReservedEntities } from './ProjectionView'

/** SDK7 reserved entity ids (Root 0, Player 1, Camera 2). */
export const SDK_RESERVED: ReservedEntities = {
  root: 0 as Entity,
  player: 1 as Entity,
  camera: 2 as Entity
}
