import type { EntityPose } from '../../bridge/ReservedEntitiesSync'

export type GuestKind = 'primary' | 'pe' | 'secondary'

export type GuestId = string

export const PRIMARY_GUEST_ID: GuestId = 'primary'

export type SceneLoopTickInput = {
  now: number
  fpsTarget: number
  player: EntityPose
  camera: EntityPose
  frame: number
}

/** Last SceneLoop send/apply walls — Help HUD / RenderStats. */
export type SceneLoopPhaseMeters = {
  sendMs: number
  receiveMs: number
  applyMs: number
  leftoverMs: number
  inFlight: number
  due: number
  guests: number
  sent: number
}
