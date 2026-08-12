import type { PortableExperienceManager } from '../../dcl/multiScene/PortableExperienceManager'
import { PeSlotGuest } from './PeSlotGuest'
import type { SceneGuest } from './SceneGuest'
import { SceneScriptGuest } from './SceneScriptGuest'
import type { SceneScriptSystem } from '../systems/SceneScriptSystem'
import {
  PRIMARY_GUEST_ID,
  type SceneLoopPhaseMeters,
  type SceneLoopTickInput
} from './types'

const emptyMeters = (): SceneLoopPhaseMeters => ({
  sendMs: 0,
  receiveMs: 0,
  applyMs: 0,
  leftoverMs: 0,
  inFlight: 0,
  due: 0,
  guests: 0,
  sent: 0
})

/**
 * Host frame clock for scene-JS guests.
 * Phase 0: named send / receive / apply + meters. Same tick rate as before (every rAF, no gate).
 */
export class SceneLoop {
  private readonly guests = new Map<string, SceneGuest>()
  private meters: SceneLoopPhaseMeters = emptyMeters()

  setPrimary(getSystem: () => SceneScriptSystem): void {
    this.guests.set(
      PRIMARY_GUEST_ID,
      new SceneScriptGuest(PRIMARY_GUEST_ID, 'primary', getSystem, true)
    )
  }

  /** Keep PE guests aligned with running PE workers. */
  reconcilePe(pe: PortableExperienceManager | null): void {
    const live = new Set<string>()
    if (pe) {
      for (const { id, slot } of pe.listRunningWorkers()) {
        live.add(id)
        const existing = this.guests.get(id)
        if (existing instanceof PeSlotGuest && existing.slot === slot) continue
        this.guests.set(id, new PeSlotGuest(id, slot))
      }
    }
    for (const [id, guest] of this.guests) {
      if (guest.kind === 'pe' && !live.has(id)) this.guests.delete(id)
    }
  }

  removeGuest(id: string): void {
    this.guests.delete(id)
  }

  clear(): void {
    this.guests.clear()
    this.meters = emptyMeters()
  }

  getMeters(): SceneLoopPhaseMeters {
    return this.meters
  }

  /**
   * Send due guests (priority first). Phase 0: everyone is due; no in-flight skip.
   * Receive is still the CRDT message handler — this only snapshots a 0 receive wall.
   */
  send(input: SceneLoopTickInput): void {
    const t0 = performance.now()
    const ordered = [...this.guests.values()].sort((a, b) => {
      if (a.priority !== b.priority) return a.priority ? -1 : 1
      if (a.kind === 'primary') return -1
      if (b.kind === 'primary') return 1
      return 0
    })
    let due = 0
    let sent = 0
    let inFlight = 0
    for (const guest of ordered) {
      if (guest.inFlight()) inFlight++
      if (!guest.isDue(input.now)) continue
      due++
      guest.sendTick(input.player, input.camera, input.frame)
      sent++
    }
    const sendMs = performance.now() - t0
    this.meters = {
      ...this.meters,
      sendMs,
      receiveMs: 0,
      leftoverMs: 0,
      inFlight,
      due,
      guests: this.guests.size,
      sent
    }
  }

  async applyWorld(deadlineMs: number): Promise<void> {
    const t0 = performance.now()
    const primary = this.guests.get(PRIMARY_GUEST_ID)
    if (primary) await primary.applyWorld(deadlineMs)
    this.meters = {
      ...this.meters,
      applyMs: performance.now() - t0
    }
  }
}
