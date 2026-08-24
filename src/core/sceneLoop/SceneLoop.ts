import type { PortableExperienceManager } from '../../dcl/multiScene/PortableExperienceManager'
import { PeSlotGuest } from './PeSlotGuest'
import type { SceneGuest } from './SceneGuest'
import { SceneScriptGuest } from './SceneScriptGuest'
import type { SceneScriptSystem } from '../systems/SceneScriptSystem'
import {
  PRIMARY_GUEST_ID,
  type GuestId,
  type SceneLoopPhaseMeters,
  type SceneLoopTickInput
} from './types'
import { pickGuestsToSend } from './pickGuestsToSend'

const emptyMeters = (): SceneLoopPhaseMeters => ({
  sendMs: 0,
  receiveMs: 0,
  applyMs: 0,
  leftoverMs: 0,
  inFlight: 0,
  due: 0,
  guests: 0,
  sent: 0,
  muteSent: 0
})

/**
 * Host frame clock for scene-JS guests.
 * Send (if due) → receive queued CRDT → motion peel → present → spare apply.
 */
export class SceneLoop {
  private readonly guests = new Map<string, SceneGuest>()
  private meters: SceneLoopPhaseMeters = emptyMeters()
  private lastApplyMs = 0
  private lastCurrentApplyMs = 0
  /** Live guest whose footprint contains the player — current scene, not FocusOwner. */
  private currentGuestId: GuestId | null = null

  /** True when the last apply overran the display budget — next rAF should be minimum. */
  lastApplyOverran(budgetMs = 28): boolean {
    return this.lastApplyMs > budgetMs || this.lastCurrentApplyMs > budgetMs
  }

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

  setCurrentGuestId(id: GuestId | null): void {
    this.currentGuestId = id
  }

  getCurrentGuestId(): GuestId | null {
    return this.currentGuestId
  }

  reconcileLiveGuests(
    getters: Array<{ id: string; getSystem: () => SceneScriptSystem; distM?: number }>
  ): void {
    const live = new Set(getters.map((g) => g.id))
    for (const g of getters) {
      const existing = this.guests.get(g.id)
      if (existing instanceof SceneScriptGuest) {
        existing.setDistM(g.distM)
        continue
      }
      const guest = new SceneScriptGuest(
        g.id,
        'secondary',
        g.getSystem,
        false,
        () => this.currentGuestId === g.id
      )
      guest.setDistM(g.distM)
      this.guests.set(g.id, guest)
    }
    for (const [id, guest] of this.guests) {
      if (guest.kind === 'secondary' && !live.has(id)) this.guests.delete(id)
    }
    if (this.currentGuestId && !this.guests.has(this.currentGuestId)) {
      this.currentGuestId = null
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

  send(input: SceneLoopTickInput): void {
    const t0 = performance.now()
    const exclusive = input.exclusiveSecondarySlot === true
    const allowMute = !exclusive && input.allowMuteSecondary === true
    const snapshots = [...this.guests.values()].map((g) => ({
      id: g.id,
      kind: g.kind,
      priority: g.priority,
      inFlight: g.inFlight(),
      due: g.isDue(input.now),
      lastSentMs: g.lastSentMs(),
      distM: g instanceof SceneScriptGuest ? g.distM : Number.POSITIVE_INFINITY
    }))
    const picked = pickGuestsToSend(snapshots, {
      now: input.now,
      currentGuestId: this.currentGuestId,
      exclusiveSecondarySlot: exclusive,
      allowMuteSecondary: allowMute
    })
    const byId = new Map([...this.guests.values()].map((g) => [g.id, g]))
    for (const id of picked.sendIds) {
      byId.get(id)?.sendTick(input.player, input.camera, input.frame)
    }
    this.meters = {
      ...this.meters,
      sendMs: performance.now() - t0,
      leftoverMs: 0,
      inFlight: picked.inFlight,
      due: picked.due,
      guests: this.guests.size,
      sent: picked.sendIds.length,
      muteSent: picked.muteSent
    }
  }

  receive(): void {
    const t0 = performance.now()
    for (const guest of this.guests.values()) guest.takeReceived()
    this.meters = {
      ...this.meters,
      receiveMs: performance.now() - t0
    }
  }

  /** Cheap Transform/Tween peel before WebGL present. */
  peelMotion(deadlineMs: number): void {
    this.guests.get(PRIMARY_GUEST_ID)?.peelMotion?.(deadlineMs)
    const cur = this.currentGuest()
    if (cur) cur.peelMotion?.(deadlineMs)
  }

  async applyWorld(deadlineMs: number): Promise<void> {
    const t0 = performance.now()
    const primary = this.guests.get(PRIMARY_GUEST_ID)
    if (primary) await primary.applyWorld(deadlineMs)
    this.lastApplyMs = performance.now() - t0
    this.meters = {
      ...this.meters,
      applyMs: this.lastApplyMs
    }
  }

  /** Apply the under-feet guest even when plaza leftover is 0 (new flower GLBs). */
  async applyCurrentGuest(deadlineMs: number): Promise<void> {
    const cur = this.currentGuest()
    if (!cur || cur.id === PRIMARY_GUEST_ID) {
      this.lastCurrentApplyMs = 0
      return
    }
    const t0 = performance.now()
    await cur.applyWorld(deadlineMs)
    this.lastCurrentApplyMs = performance.now() - t0
  }

  /**
   * Neighbor live guests still emit CRDT after hydrate (Transform drones,
   * flower addEntity). Current already applied; spend leftover here.
   */
  async applyOtherLiveGuests(deadlineMs: number): Promise<void> {
    if (deadlineMs <= 0) return
    const skip = this.currentGuestId
    const t0 = performance.now()
    for (const guest of this.guests.values()) {
      if (guest.kind !== 'secondary') continue
      if (guest.id === skip) continue
      const spent = performance.now() - t0
      if (spent >= deadlineMs) break
      await guest.applyWorld(Math.max(1, deadlineMs - spent))
    }
  }

  private currentGuest(): SceneGuest | undefined {
    if (!this.currentGuestId) return undefined
    return this.guests.get(this.currentGuestId)
  }
}
