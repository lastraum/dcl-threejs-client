import type { EntityPose } from '../../bridge/ReservedEntitiesSync'
import type { GuestId, GuestKind } from './types'

/**
 * One scene-JS guest the host frame may send a tick to.
 * Phase 0: send + apply adapters only — no in-flight gate, receive still on the message path.
 */
export interface SceneGuest {
  readonly id: GuestId
  readonly kind: GuestKind
  /** Priority guests occupy a slot and are sent first (primary, PE). */
  readonly priority: boolean
  inFlight(): boolean
  lastSentMs(): number
  isDue(now: number): boolean
  sendTick(player: EntityPose, camera: EntityPose, frame: number): void
  takeReceived(): number
  peelMotion?(deadlineMs: number): void
  applyWorld(deadlineMs: number): Promise<void>
}
