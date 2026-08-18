import type { EntityPose } from '../../bridge/ReservedEntitiesSync'
import type { SceneScriptSystem } from '../systems/SceneScriptSystem'
import type { SceneGuest } from './SceneGuest'
import type { GuestId, GuestKind } from './types'

/** Host adapter over a live {@link SceneScriptSystem} (primary + SceneLoop secondaries). PE is PeSlotGuest. */
export class SceneScriptGuest implements SceneGuest {
  private sentAt = 0

  constructor(
    readonly id: GuestId,
    readonly kind: GuestKind,
    private readonly getSystem: () => SceneScriptSystem,
    readonly priority = kind !== 'secondary',
    /** Current guest (under feet) — leftover apply + immediate pointer wakeup. */
    private readonly isCurrent: () => boolean = () => false
  ) {}

  inFlight(): boolean {
    return this.getSystem().isPlayFrameInFlight()
  }

  lastSentMs(): number {
    return this.sentAt
  }

  isDue(now: number): boolean {
    const cadenceDue = this.sentAt <= 0 || now - this.sentAt >= 50
    // Mute non-current secondaries at 50 ms. Immediate is primary or current guest (under feet).
    if (this.kind === 'secondary' && !this.isCurrent()) return cadenceDue
    if (this.getSystem().needsImmediateGuestTick()) return true
    return cadenceDue
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
    const sys = this.getSystem()
    if (sys.pendingDiffSize() === 0 && !sys.hasContentApplyWork()) return Promise.resolve()
    return sys.syncRenderer({ deadlineMs, skipMotion: true })
  }
}
