import * as THREE from 'three'

type QueuedLoad = {
  address: string
  distanceSq: number
  run: () => Promise<void>
}

/** Limits concurrent remote avatar composes; nearer peers load first. */
export class RemoteAvatarLoadQueue {
  /** Max simultaneous full avatar composes (placeholder + profile). */
  static readonly MAX_CONCURRENT = 2
  /** Peers beyond this horizontal distance wait until closer or queue drains. */
  static readonly DEFER_DISTANCE = 55

  private readonly camera = new THREE.Vector3()
  private readonly waiting = new Map<string, QueuedLoad>()
  private readonly active = new Set<string>()
  private running = 0

  setCameraPosition(position: THREE.Vector3): void {
    this.camera.copy(position)
    this.reprioritize()
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

  private markFinished(address: string): void {
    this.active.delete(address)
    this.running = Math.max(0, this.running - 1)
    this.pump()
  }

  private reprioritize(): void {
    this.pump()
  }

  private pump(): void {
    while (this.running < RemoteAvatarLoadQueue.MAX_CONCURRENT && this.waiting.size > 0) {
      const deferSq = RemoteAvatarLoadQueue.DEFER_DISTANCE ** 2
      const candidates = [...this.waiting.values()].sort((a, b) => a.distanceSq - b.distanceSq)
      const next = candidates.find((c) => c.distanceSq <= deferSq) ?? candidates[0]
      if (!next) break

      // Only defer when nearer peers are still waiting and this one is far.
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
