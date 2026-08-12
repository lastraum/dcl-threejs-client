import type { EntityPose } from '../../bridge/ReservedEntitiesSync'
import type { SceneWorkerSlot } from '../../dcl/multiScene/SceneWorkerSlot'
import type { SceneGuest } from './SceneGuest'
import type { GuestId } from './types'

/** PE worker as a SceneLoop guest — play-frame send only; apply stays on tickAsync. */
export class PeSlotGuest implements SceneGuest {
  readonly kind = 'pe' as const
  readonly priority = true
  private sentAt = 0

  constructor(
    readonly id: GuestId,
    readonly slot: SceneWorkerSlot
  ) {}

  inFlight(): boolean {
    return false
  }

  lastSentMs(): number {
    return this.sentAt
  }

  isDue(_now: number): boolean {
    return true
  }

  sendTick(player: EntityPose, camera: EntityPose, _frame: number): void {
    this.slot.tickSync(player, camera, 0)
    this.sentAt = performance.now()
  }

  takeReceived(): number {
    return 0
  }

  async applyWorld(_deadlineMs: number): Promise<void> {
    // PE peel remains MultiSceneRuntime.tickAsync (shared leftover budget).
  }
}
