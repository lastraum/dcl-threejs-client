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
    /** Under-feet current scene — full-rate tick, no origin rebase. */
    private readonly isCurrent: () => boolean = () => false
  ) {}

  inFlight(): boolean {
    return this.getSystem().isPlayFrameInFlight()
  }

  lastSentMs(): number {
    return this.sentAt
  }

  isDue(now: number): boolean {
    // Scene under feet is current (official desktop) — display-rate scripts.
    // Other live neighbors stay on the 20 Hz guest clock.
    if (this.kind === 'secondary') {
      const minMs = this.isCurrent() ? 16 : 50
      return this.sentAt <= 0 || now - this.sentAt >= minMs
    }
    // Pointer inject still needs a guest tick this turn. Otherwise 20 Hz — display
    // rAF is the presenter, not scene.js.
    if (this.getSystem().needsImmediateGuestTick()) return true
    return this.sentAt <= 0 || now - this.sentAt >= 50
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
