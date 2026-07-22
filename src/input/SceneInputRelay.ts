import type { InputHub, InputHubSubscriber } from './InputHub'
import type { SceneInputSnapshotBody } from '../player/sceneInputSnapshot'

/** @deprecated Name kept for PlayerSystem — use hub pressed state for new code. */
export type SceneKeyboardSnapshot = {
  forward: boolean
  backward: boolean
  left: boolean
  right: boolean
  jump: boolean
  ctrl: boolean
  action3: boolean
  action4: boolean
  action5: boolean
  action6: boolean
}

export type SceneInputConsumerDeps = {
  /**
   * Per-subscriber block is unused for hardware (hub owns global block).
   * Kept for API compatibility; ignored when attached to InputHub.
   */
  isRelayBlocked?: () => boolean
  isLocomotionBlocked?: () => boolean
  clearPlayerMoveKeys?: () => void
  publishInputSnapshot: (body: SceneInputSnapshotBody) => void
  pumpWorkerTick?: () => void
  onFlightKeysReleased?: () => void
  forceRepublishSnapshot?: () => boolean
}

/**
 * Scene/PE worker input consumer — does **not** own window listeners.
 * Registers with {@link InputHub} so primary + PE receive the same key bus.
 */
export class SceneInputRelay {
  private hub: InputHub | null = null
  private unsub: (() => void) | null = null
  private subscriberId = 'scene'

  /** Unique id for hub fan-out (`primary`, `pe:…`). */
  setSubscriberId(id: string): void {
    this.subscriberId = id
  }

  /**
   * Attach to the world InputHub and register publish/pump callbacks.
   * Call once after pointer bind (or PE wire). Replaces prior subscription.
   */
  attachToHub(hub: InputHub, deps: SceneInputConsumerDeps): void {
    this.detachFromHub()
    this.hub = hub
    const sub: InputHubSubscriber = {
      id: this.subscriberId,
      publish: (body) => deps.publishInputSnapshot(body),
      pumpWorkerTick: deps.pumpWorkerTick,
      forceRepublish: deps.forceRepublishSnapshot,
      onFlightKeysReleased: deps.onFlightKeysReleased
    }
    this.unsub = hub.subscribe(sub)
  }

  detachFromHub(): void {
    this.unsub?.()
    this.unsub = null
    this.hub = null
  }

  /**
   * @deprecated Prefer World calling `inputHub.sync(tick)` once per frame.
   * No-op for multi-consumer safety (avoids double-sync if both PE and primary call).
   */
  sync(_tickNumber: number): void {
    // Hub is synced once from World — individual relays do not drive hardware.
  }

  /**
   * Release is global (one keyboard). Prefer hub.releaseAll; this mirrors for dispose paths.
   */
  releaseHeldKeys(reason: string): void {
    this.hub?.releaseAll(reason)
  }

  dispose(): void {
    this.detachFromHub()
  }

  /** @deprecated Use attachToHub — no longer binds window. */
  bind(deps: SceneInputConsumerDeps): void {
    if (!this.hub) {
      console.warn(
        `[input] SceneInputRelay.bind without hub id=${this.subscriberId} — call attachToHub first`
      )
      return
    }
    this.attachToHub(this.hub, deps)
  }
}
