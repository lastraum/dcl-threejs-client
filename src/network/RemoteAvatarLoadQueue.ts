import * as THREE from 'three'

type QueuedLoad = {
  address: string
  /** Latest peer world position for distance recompute on pump. */
  position: THREE.Vector3
  run: () => Promise<void>
}

/**
 * Limits concurrent remote avatar composes; nearer peers load first.
 * Hard load radius: never start a compose beyond {@link LOAD_DISTANCE} m.
 * Steady state: **one at a time**, **≥10s between starts** so plaza CCT/colliders stay solid.
 * Once a peer has a model, the manager keeps it (no unload-for-distance).
 */
export class RemoteAvatarLoadQueue {
  /** Steady state + warm: never more than one full avatar compose. */
  static readonly MAX_CONCURRENT = 1
  /** During scene hydration / collider hold — no full composes; pill + name tag only. */
  static readonly MAX_CONCURRENT_HYDRATION = 0
  /**
   * Minimum wall time between compose **starts** (not finishes).
   * Next peer waits until this gap after the previous start, even if the first finished early.
   */
  static readonly MIN_COMPOSE_INTERVAL_MS = 10_000
  /**
   * Horizontal meters — only start full body compose inside this radius.
   * ~1.25× a 16 m parcel edge so same-parcel + neighbor edge load; far stay pills.
   */
  static readonly LOAD_DISTANCE = 20
  /** @deprecated use LOAD_DISTANCE — kept as alias for older call sites / logs. */
  static readonly DEFER_DISTANCE = RemoteAvatarLoadQueue.LOAD_DISTANCE
  /** Pause new avatar starts while scene has this many GLB fetches in flight. */
  static readonly SCENE_PRESSURE_INFLIGHT = 3
  /**
   * After collider seal: hold all remote composes so pose resync + CCT aren't starved.
   */
  static readonly COLLIDER_HOLD_MS_PLAZA = 10_000
  static readonly COLLIDER_HOLD_MS_DEFAULT = 4_000

  private readonly camera = new THREE.Vector3()
  private readonly waiting = new Map<string, QueuedLoad>()
  private readonly active = new Set<string>()
  private running = 0
  private hydrationMode = false
  /** Post-seal hold — no full composes (pills/name tags still update). */
  private colliderHoldMode = false
  private sceneGltfInflight = 0
  /** Local player loading an emote GLB — don't start new remote composes until done. */
  private localEmoteBusy = false
  private colliderHoldExitTimer: ReturnType<typeof setTimeout> | null = null
  /** performance.now() when the last compose was started (0 = never). */
  private lastComposeStartMs = 0
  private intervalPumpTimer: ReturnType<typeof setTimeout> | null = null

  setCameraPosition(position: THREE.Vector3): void {
    this.camera.copy(position)
    this.pump()
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
    this.pump()
  }

  /**
   * Scene play-ready — still hold full composes briefly so collider pose resync / CCT
   * settle, then stagger 1 compose / 10s.
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
      // First compose may start immediately after hold (interval clock starts on first start).
      this.pump()
    }, holdMs)
    this.pump()
  }

  setSceneAssetPressure(gltfInflight: number, textureInflight = 0): void {
    this.sceneGltfInflight = gltfInflight + textureInflight
    this.pump()
  }

  /**
   * While the local player loads/binds a scene emote GLB, hold new remote composes
   * (in-flight composes finish). Does not hide or drop peers — only defers starts.
   */
  setLocalEmoteLoadBusy(busy: boolean): void {
    this.localEmoteBusy = busy
    if (!busy) this.pump()
  }

  /**
   * Queue a peer avatar load. Replaces any pending entry for the same address.
   * `force` ignores load radius (profile reload / explicit).
   * Far peers may still be enqueued; {@link pump} will not start them until inside radius
   * (unless force) so walking toward a pill can promote without re-enqueue races.
   */
  enqueue(
    address: string,
    peerPosition: THREE.Vector3,
    run: () => Promise<void>,
    force = false
  ): void {
    const key = address.toLowerCase()
    if (this.active.has(key)) return

    const pos = peerPosition.clone()
    if (force) {
      // Park “at camera” so sort priority wins and hard gate treats as in-range.
      pos.copy(this.camera)
    }
    this.waiting.set(key, { address: key, position: pos, run })
    this.pump()
  }

  /** Refresh position when a waiting peer moves (or camera-driven recheck). */
  updatePeerDistance(address: string, peerPosition: THREE.Vector3): void {
    const key = address.toLowerCase()
    const entry = this.waiting.get(key)
    if (!entry) return
    entry.position.copy(peerPosition)
    this.pump()
  }

  cancel(address: string): void {
    this.waiting.delete(address.toLowerCase())
  }

  /** True if horizontal distance is within the hard compose radius. */
  isWithinLoadDistance(peerPosition: THREE.Vector3): boolean {
    return (
      horizontalDistanceSq(peerPosition, this.camera) <=
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

  private maxConcurrent(): number {
    if (this.hydrationMode || this.colliderHoldMode) {
      return RemoteAvatarLoadQueue.MAX_CONCURRENT_HYDRATION
    }
    return RemoteAvatarLoadQueue.MAX_CONCURRENT
  }

  private scenePressureBlocks(): boolean {
    // Block new composes under scene GLB pressure even after play-ready (not only hydration).
    return this.sceneGltfInflight >= RemoteAvatarLoadQueue.SCENE_PRESSURE_INFLIGHT
  }

  /** Ms until the 10s start-gap allows another compose (0 = ready). */
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
    }, delayMs)
  }

  private markFinished(address: string): void {
    this.active.delete(address)
    this.running = Math.max(0, this.running - 1)
    this.pump()
  }

  private pump(): void {
    if (this.scenePressureBlocks()) return
    if (this.localEmoteBusy) return

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
          distanceSq: horizontalDistanceSq(c.position, this.camera)
        }))
        .sort((a, b) => a.distanceSq - b.distanceSq)

      // Hard gate: never start a compose outside load radius (no far fallback).
      const next = candidates.find((row) => row.distanceSq <= loadSq)
      if (!next) break

      this.waiting.delete(next.c.address)
      this.active.add(next.c.address)
      this.running++
      this.lastComposeStartMs = performance.now()

      void next.c.run().finally(() => {
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
