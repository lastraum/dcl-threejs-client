import type { EntityPose } from '../../bridge/ReservedEntitiesSync'
import type { SceneScriptSystem } from '../systems/SceneScriptSystem'
import type { SceneGuest } from './SceneGuest'
import type { GuestId, GuestKind } from './types'

/** Host adapter over a live {@link SceneScriptSystem} (primary today; PE/secondary later). */
export class SceneScriptGuest implements SceneGuest {
  private sentAt = 0

  constructor(
    readonly id: GuestId,
    readonly kind: GuestKind,
    private readonly getSystem: () => SceneScriptSystem,
    readonly priority = kind !== 'secondary'
  ) {}

  inFlight(): boolean {
    return this.getSystem().isPlayFrameInFlight()
  }

  lastSentMs(): number {
    return this.sentAt
  }

  isDue(_now: number): boolean {
    return true
  }

  sendTick(_player: EntityPose, _camera: EntityPose, _frame: number): void {
    this.getSystem().tickPlayFrame()
    this.sentAt = performance.now()
  }

  takeReceived(): number {
    this.getSystem().drainQueuedCrdtOutbound()
    return 0
  }

  peelMotion(deadlineMs: number): void {
    this.getSystem().peelMotionSync(deadlineMs)
  }

  applyWorld(deadlineMs: number): Promise<void> {
    if (!this.getSystem().hasPendingApplyWork()) return Promise.resolve()
    return this.getSystem().syncRenderer({ deadlineMs })
  }
}
