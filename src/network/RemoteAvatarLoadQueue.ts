import * as THREE from 'three'
import { lastFrameOverBudget, scheduleOffPlayRaf, yieldToIdle } from '../rendering/mainThreadYield'

type QueuedLoad = {
  address: string
  /** Latest peer world position for distance recompute on pump. */
  position: THREE.Vector3
  run: () => Promise<void>
}

/**
 * Limits concurrent remote avatar composes; nearer peers load first.
 * Hard load radius: never start a compose beyond {@link LOAD_DISTANCE} m.
 * Steady state: **one at a time**, staggered starts so plaza CCT/colliders stay solid.
 * Once a peer has a model, the manager keeps it (no unload-for-distance).
 */
export class RemoteAvatarLoadQueue {
  /** Steady state + warm: never more than one full avatar compose. */
  static readonly MAX_CONCURRENT = 1
  /** During scene hydration / collider hold — no full composes; neon shell only. */
  static readonly MAX_CONCURRENT_HYDRATION = 0
  /**
   * Minimum wall time between compose **starts** (not finishes).
   * Was 10s — four nearby peers took 40s+ and felt “stuck at shells”.
   */
  static readonly MIN_COMPOSE_INTERVAL_MS = 3_500
  /**
   * Horizontal meters — only start full body compose inside this radius.
   * ~1.25× a 16 m parcel edge so same-parcel + neighbor edge load; far stay shells.
   */
  static readonly LOAD_DISTANCE = 20
  /** @deprecated use LOAD_DISTANCE — kept as alias for older call sites / logs. */
  static readonly DEFER_DISTANCE = RemoteAvatarLoadQueue.LOAD_DISTANCE
  /**
   * Pause new avatar starts while scene has this many **GLB** fetches in flight.
   * Only applies during hydration — post-play texture thrash used to block forever.
   */
  static readonly SCENE_PRESSURE_INFLIGHT = 4
  /**
   * After collider seal: hold all remote composes so pose resync + CCT aren't starved.
   */
  static readonly COLLIDER_HOLD_MS_PLAZA = 4_000
  static readonly COLLIDER_HOLD_MS_DEFAULT = 2_000

  /** Local player feet (Three world) — load radius / sort origin, not camera. */
  private readonly localPlayer = new THREE.Vector3()
  private readonly waiting = new Map<string, QueuedLoad>()
  private readonly active = new Set<string>()
  private running = 0
  private hydrationMode = false
  /** Post-seal hold — no full composes (shells still show). */
  private colliderHoldMode = false
  private sceneGltfInflight = 0
  /** Local player loading an emote GLB — don't start new remote composes until done. */
  private localEmoteBusy = false
  private colliderHoldExitTimer: ReturnType<typeof setTimeout> | null = null
  /** performance.now() when the last compose was started (0 = never). */
  private lastComposeStartMs = 0
  private intervalPumpTimer: ReturnType<typeof setTimeout> | null = null
  /** Coalesce rAF position updates into one idle pump. */
  private offRafPumpScheduled = false

  /** Reference for distance gates — pass local player feet, not freecam / orbit camera. */
  setLocalPlayerPosition(position: THREE.Vector3): void {
    this.localPlayer.copy(position)
    this.scheduleOffRafPump()
  }

  /** @deprecated use {@link setLocalPlayerPosition} */
  setCameraPosition(position: THREE.Vector3): void {
    this.setLocalPlayerPosition(position)
  }

  setHydrationMode(active: boolean): void {
    this.hydrationMode = active
    if (active) {
      if (this.colliderHoldExitTimer) {
        clearTimeout(this.colliderHoldExitTimer)
        this.colliderHoldExitTimer = null
      }
      if (this.intervalPumpTimer) {
        clearTimeout(this.intervalPumpTimer)
        this.intervalPumpTimer = null
      }
      this.colliderHoldMode = false
    }
    this.scheduleOffRafPump()
  }

  /**
   * Scene play-ready — still hold full composes briefly so collider pose resync / CCT
   * settle, then stagger 1 compose at a time.
   */
  setPlayReady(plazaScale = false): void {
    this.hydrationMode = false
    this.colliderHoldMode = true
    if (this.colliderHoldExitTimer) clearTimeout(this.colliderHoldExitTimer)
    const holdMs = plazaScale
      ? RemoteAvatarLoadQueue.COLLIDER_HOLD_MS_PLAZA
      : RemoteAvatarLoadQueue.COLLIDER_HOLD_MS_DEFAULT
    this.colliderHoldExitTimer = setTimeout(() => {
      this.colliderHoldExitTimer = null
      this.colliderHoldMode = false
      this.scheduleOffRafPump()
    }, holdMs)
    this.scheduleOffRafPump()
  }

  /**
   * Scene asset pressure — **GLB inflight only** (textures are continuous and were
   * permanently blocking remote bodies after play). Only gates during hydration.
   */
  setSceneAssetPressure(gltfInflight: number, _textureInflight = 0): void {
    this.sceneGltfInflight = gltfInflight
    this.scheduleOffRafPump()
  }

  /**
   * While the local player loads/binds a scene emote GLB, hold new remote composes
   * (in-flight composes finish). Does not hide or drop peers — only defers starts.
   */
  setLocalEmoteLoadBusy(busy: boolean): void {
    this.localEmoteBusy = busy
    if (!busy) this.scheduleOffRafPump()
  }

  /** True if this peer is waiting or actively composing. */
  isQueued(address: string): boolean {
    const key = address.toLowerCase()
    return this.waiting.has(key) || this.active.has(key)
  }

  /**
   * Queue a peer avatar load.
   * `force` ignores load radius (profile reload / explicit) by parking at local player.
   * Far peers may still be enqueued; {@link pump} will not start them until inside radius
   * (unless force) so walking toward a shell can promote without re-enqueue races.
   */
  enqueue(
    address: string,
    peerPosition: THREE.Vector3,
    run: () => Promise<void>,
    force = false
  ): void {
    const key = address.toLowerCase()
    if (this.active.has(key)) return

    const existing = this.waiting.get(key)
    if (existing) {
      if (force) {
        existing.position.copy(this.localPlayer)
      } else {
        existing.position.copy(peerPosition)
      }
      this.scheduleOffRafPump()
      return
    }

    const pos = peerPosition.clone()
    if (force) {
      // Park at local player so sort priority wins and hard gate treats as in-range.
      pos.copy(this.localPlayer)
    }
    this.waiting.set(key, { address: key, position: pos, run })
    this.scheduleOffRafPump()
  }

  /**
   * Refresh position when a waiting peer moves (or player-driven recheck).
   * Pass `pump=false` when bulk-updating many peers; call {@link notifyPump} once after.
   */
  updatePeerDistance(address: string, peerPosition: THREE.Vector3, pump = true): void {
    const key = address.toLowerCase()
    const entry = this.waiting.get(key)
    if (!entry) return
    entry.position.copy(peerPosition)
    if (pump) this.scheduleOffRafPump()
  }

  /** Re-evaluate the wait queue (e.g. after bulk distance updates). */
  notifyPump(): void {
    this.scheduleOffRafPump()
  }

  cancel(address: string): void {
    this.waiting.delete(address.toLowerCase())
  }

  /** True if horizontal distance is within the hard compose radius of the local player. */
  isWithinLoadDistance(peerPosition: THREE.Vector3): boolean {
    return (
      horizontalDistanceSq(peerPosition, this.localPlayer) <=
      RemoteAvatarLoadQueue.LOAD_DISTANCE * RemoteAvatarLoadQueue.LOAD_DISTANCE
    )
  }

  /** In-flight + waiting compose jobs (for loading toast). */
  getPendingComposeCount(): number {
    return this.waiting.size + this.active.size
  }

  getActiveComposeCount(): number {
    return this.active.size
  }

  getWaitingCount(): number {
    return this.waiting.size
  }

  /** Debug snapshot for MainFrameHud / toast diagnosis. */
  getGateSnapshot(): {
    waiting: number
    active: number
    hydration: boolean
    hold: boolean
    pressure: boolean
    emoteBusy: boolean
    gapMs: number
    gltfInflight: number
  } {
    return {
      waiting: this.waiting.size,
      active: this.active.size,
      hydration: this.hydrationMode,
      hold: this.colliderHoldMode,
      pressure: this.scenePressureBlocks(),
      emoteBusy: this.localEmoteBusy,
      gapMs: this.msUntilNextComposeAllowed(),
      gltfInflight: this.sceneGltfInflight
    }
  }

  private maxConcurrent(): number {
    if (this.hydrationMode || this.colliderHoldMode) {
      return RemoteAvatarLoadQueue.MAX_CONCURRENT_HYDRATION
    }
    return RemoteAvatarLoadQueue.MAX_CONCURRENT
  }

  /**
   * Only block during **hydration**. After play-ready, AOI / deferred textures used to keep
   * inflight ≥ 3 forever → body=0 for all remotes (shells only).
   */
  private scenePressureBlocks(): boolean {
    if (!this.hydrationMode) return false
    return this.sceneGltfInflight >= RemoteAvatarLoadQueue.SCENE_PRESSURE_INFLIGHT
  }

  /** Ms until the start-gap allows another compose (0 = ready). */
  private msUntilNextComposeAllowed(): number {
    if (this.lastComposeStartMs <= 0) return 0
    const elapsed = performance.now() - this.lastComposeStartMs
    return Math.max(0, RemoteAvatarLoadQueue.MIN_COMPOSE_INTERVAL_MS - elapsed)
  }

  private scheduleIntervalPump(delayMs: number): void {
    if (this.intervalPumpTimer) return
    this.intervalPumpTimer = setTimeout(() => {
      this.intervalPumpTimer = null
      this.pump()
    }, Math.max(50, delayMs))
  }

  private markFinished(address: string): void {
    this.active.delete(address)
    this.running = Math.max(0, this.running - 1)
    this.scheduleOffRafPump()
  }

  private scheduleOffRafPump(): void {
    if (this.offRafPumpScheduled) return
    this.offRafPumpScheduled = true
    scheduleOffPlayRaf(() => {
      this.offRafPumpScheduled = false
      this.pump()
    })
  }

  private pump(): void {
    if (this.scenePressureBlocks()) {
      // Retry — without this, a sticky pressure sample never re-evaluates.
      this.scheduleIntervalPump(400)
      return
    }
    if (this.localEmoteBusy) return
    // Presenter owns the frame. Do not start a multi-second compose unless the
    // last present was cheap (Bevy: compose off the present thread).
    if (lastFrameOverBudget(20)) {
      this.scheduleIntervalPump(120)
      return
    }

    const waitGap = this.msUntilNextComposeAllowed()
    if (waitGap > 0) {
      this.scheduleIntervalPump(waitGap)
      return
    }

    const loadSq =
      RemoteAvatarLoadQueue.LOAD_DISTANCE * RemoteAvatarLoadQueue.LOAD_DISTANCE

    // One at a time — never start a second while one is running.
    while (this.running < this.maxConcurrent() && this.waiting.size > 0) {
      // Re-check gap after each start (while only allows one when MAX=1).
      const gap = this.msUntilNextComposeAllowed()
      if (gap > 0) {
        this.scheduleIntervalPump(gap)
        break
      }

      const candidates = [...this.waiting.values()]
        .map((c) => ({
          c,
          distanceSq: horizontalDistanceSq(c.position, this.localPlayer)
        }))
        .sort((a, b) => a.distanceSq - b.distanceSq)

      // Hard gate: never start a compose outside load radius (no far fallback).
      const next = candidates.find((row) => row.distanceSq <= loadSq)
      if (!next) break

      this.waiting.delete(next.c.address)
      this.active.add(next.c.address)
      this.running++
      this.lastComposeStartMs = performance.now()

      void (async () => {
        await yieldToIdle(80)
        await next.c.run()
      })().finally(() => {
        this.markFinished(next.c.address)
      })
    }
  }
}

function horizontalDistanceSq(a: THREE.Vector3, b: THREE.Vector3): number {
  const dx = a.x - b.x
  const dz = a.z - b.z
  return dx * dx + dz * dz
}
