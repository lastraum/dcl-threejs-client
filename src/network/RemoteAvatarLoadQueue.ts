import * as THREE from 'three'

type QueuedLoad = {
  address: string
  distanceSq: number
  run: () => Promise<void>
}

/** Limits concurrent remote avatar composes; nearer peers load first. */
export class RemoteAvatarLoadQueue {
  /** Default simultaneous full avatar composes. */
  static readonly MAX_CONCURRENT = 2
  /** During scene hydration — no full composes; pill + name tag only. */
  static readonly MAX_CONCURRENT_HYDRATION = 0
  /** After play-ready — bounded burst without starving the first interactive frames. */
  static readonly MAX_CONCURRENT_WARM = 2
  /** Plaza-scale scenes — one compose at a time during the post-ready warm window. */
  static readonly MAX_CONCURRENT_WARM_PLAZA = 1
  /** Peers beyond this horizontal distance wait until closer or queue drains. */
  static readonly DEFER_DISTANCE = 55
  /** Pause new avatar starts while scene has this many GLB fetches in flight. */
  static readonly SCENE_PRESSURE_INFLIGHT = 3

  private readonly camera = new THREE.Vector3()
  private readonly waiting = new Map<string, QueuedLoad>()
  private readonly active = new Set<string>()
  private running = 0
  private hydrationMode = false
  private cacheWarm = false
  private plazaScale = false
  private sceneGltfInflight = 0
  private cacheWarmExitTimer: ReturnType<typeof setTimeout> | null = null

  setCameraPosition(position: THREE.Vector3): void {
    this.camera.copy(position)
    this.reprioritize()
  }

  setHydrationMode(active: boolean): void {
    this.hydrationMode = active
    if (active) {
      if (this.cacheWarmExitTimer) {
        clearTimeout(this.cacheWarmExitTimer)
        this.cacheWarmExitTimer = null
      }
      this.cacheWarm = false
    }
    this.pump()
  }

  /** Scene play-ready — start bounded avatar composes after boot/spawn work finishes. */
  setPlayReady(plazaScale = false): void {
    this.hydrationMode = false
    this.plazaScale = plazaScale
    this.cacheWarm = true
    if (this.cacheWarmExitTimer) clearTimeout(this.cacheWarmExitTimer)
    this.cacheWarmExitTimer = setTimeout(() => {
      this.cacheWarmExitTimer = null
      this.cacheWarm = false
      this.pump()
    }, plazaScale ? 12_000 : 6_000)
    this.pump()
  }

  setSceneAssetPressure(gltfInflight: number, textureInflight = 0): void {
    this.sceneGltfInflight = gltfInflight + textureInflight
    this.pump()
  }

  /** Queue a peer avatar load. Replaces any pending entry for the same address. */
  enqueue(address: string, peerPosition: THREE.Vector3, run: () => Promise<void>, force = false): void {
    const key = address.toLowerCase()
    if (this.active.has(key)) return

    const distanceSq = horizontalDistanceSq(peerPosition, this.camera)
    this.waiting.set(key, { address: key, distanceSq: force ? 0 : distanceSq, run })
    this.pump()
  }

  /** Refresh sort priority when a waiting peer moves closer. */
  updatePeerDistance(address: string, peerPosition: THREE.Vector3): void {
    const key = address.toLowerCase()
    const entry = this.waiting.get(key)
    if (!entry) return
    entry.distanceSq = horizontalDistanceSq(peerPosition, this.camera)
    this.pump()
  }

  cancel(address: string): void {
    this.waiting.delete(address.toLowerCase())
  }

  private maxConcurrent(): number {
    if (this.hydrationMode) return RemoteAvatarLoadQueue.MAX_CONCURRENT_HYDRATION
    if (this.cacheWarm) {
      return this.plazaScale
        ? RemoteAvatarLoadQueue.MAX_CONCURRENT_WARM_PLAZA
        : RemoteAvatarLoadQueue.MAX_CONCURRENT_WARM
    }
    return RemoteAvatarLoadQueue.MAX_CONCURRENT
  }

  private scenePressureBlocks(): boolean {
    return this.hydrationMode && this.sceneGltfInflight >= RemoteAvatarLoadQueue.SCENE_PRESSURE_INFLIGHT
  }

  private markFinished(address: string): void {
    this.active.delete(address)
    this.running = Math.max(0, this.running - 1)
    this.pump()
  }

  private reprioritize(): void {
    this.pump()
  }

  private pump(): void {
    if (this.scenePressureBlocks()) return

    while (this.running < this.maxConcurrent() && this.waiting.size > 0) {
      const deferSq = RemoteAvatarLoadQueue.DEFER_DISTANCE ** 2
      const candidates = [...this.waiting.values()].sort((a, b) => a.distanceSq - b.distanceSq)
      const next = candidates.find((c) => c.distanceSq <= deferSq) ?? candidates[0]
      if (!next) break

      if (next.distanceSq > deferSq) {
        const hasNearWaiting = candidates.some((c) => c.distanceSq <= deferSq)
        if (hasNearWaiting) break
      }

      this.waiting.delete(next.address)
      this.active.add(next.address)
      this.running++

      void next.run().finally(() => {
        this.markFinished(next.address)
      })
    }
  }
}

function horizontalDistanceSq(a: THREE.Vector3, b: THREE.Vector3): number {
  const dx = a.x - b.x
  const dz = a.z - b.z
  return dx * dx + dz * dz
}