import type { EntityPose } from '../../bridge/ReservedEntitiesSync'
import type { SceneScriptSystem } from '../systems/SceneScriptSystem'
import type { SceneGuest } from './SceneGuest'
import type { GuestId, GuestKind } from './types'

/** Host adapter over a live {@link SceneScriptSystem} (primary + SceneLoop secondaries). PE is PeSlotGuest. */
export class SceneScriptGuest implements SceneGuest {
  private sentAt = 0

  /** Player → footprint meters for leftover mute ranking. */
  distM = Number.POSITIVE_INFINITY

  constructor(
    readonly id: GuestId,
    readonly kind: GuestKind,
    private readonly getSystem: () => SceneScriptSystem,
    readonly priority = kind !== 'secondary',
    /** Current guest (under feet) — leftover apply + immediate pointer wakeup. */
    private readonly isCurrent: () => boolean = () => false
  ) {}

  setDistM(distM: number | undefined): void {
    this.distM = Number.isFinite(distM) ? (distM as number) : Number.POSITIVE_INFINITY
  }

  inFlight(): boolean {
    return this.getSystem().isPlayFrameInFlight()
  }

  lastSentMs(): number {
    return this.sentAt
  }

  isDue(now: number): boolean {
    // Mute non-current secondaries at 20 Hz. Empty-graph hydrate only needs
    // a few ticks to emit CRDT — 20 Hz stacked on plaza rAF was 7 FPS.
    if (this.kind === 'secondary' && !this.isCurrent()) {
      let interval = 50
      try {
        if (this.getSystem().countGpuVisuals() <= 0) interval = 200
      } catch {
        /* system not ready */
      }
      return this.sentAt <= 0 || now - this.sentAt >= interval
    }
    if (this.getSystem().needsImmediateGuestTick()) return true
    // Primary / current: host rAF (~16 ms). 50 ms left Snow Drift look-ahead 0.4 m late at jog 8.
    return this.sentAt <= 0 || now - this.sentAt >= 16
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
