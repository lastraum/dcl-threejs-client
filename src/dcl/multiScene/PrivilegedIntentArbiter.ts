import {
  SCENE_WORKER_PRIORITY,
  type PrivilegedChannel,
  type SceneWorkerKind
} from './types'

export type PrivilegedIntent<T = unknown> = {
  channel: PrivilegedChannel
  kind: SceneWorkerKind
  slotId: string
  payload: T
  at: number
}

/**
 * Primary always wins. PE beats secondary. Same-priority: later intent wins.
 * Clear channel after apply so PE can act when primary is silent next frame.
 */
export class PrivilegedIntentArbiter {
  private pending = new Map<PrivilegedChannel, PrivilegedIntent>()

  submit<T>(intent: PrivilegedIntent<T>): void {
    const prev = this.pending.get(intent.channel)
    if (!prev) {
      this.pending.set(intent.channel, intent as PrivilegedIntent)
      return
    }
    const pPrev = SCENE_WORKER_PRIORITY[prev.kind]
    const pNext = SCENE_WORKER_PRIORITY[intent.kind]
    if (pNext > pPrev || (pNext === pPrev && intent.at >= prev.at)) {
      this.pending.set(intent.channel, intent as PrivilegedIntent)
    }
  }

  /** Take and clear one channel (apply winner). */
  take<T = unknown>(channel: PrivilegedChannel): PrivilegedIntent<T> | null {
    const hit = this.pending.get(channel) as PrivilegedIntent<T> | undefined
    if (!hit) return null
    this.pending.delete(channel)
    return hit
  }

  peek(channel: PrivilegedChannel): PrivilegedIntent | null {
    return this.pending.get(channel) ?? null
  }

  clear(): void {
    this.pending.clear()
  }
}
