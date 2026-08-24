import type { GuestId, GuestKind } from './types'

/** Snapshot of one SceneLoop guest at send time — no worker / system types. */
export type GuestSendSnapshot = {
  id: GuestId
  kind: GuestKind
  priority: boolean
  inFlight: boolean
  due: boolean
  lastSentMs: number
  /** Player → footprint meters. Missing → +Infinity (wait-only aging). */
  distM: number
}

export type PickGuestsToSendOpts = {
  now: number
  currentGuestId: GuestId | null
  /**
   * Exclusive slot: at most one secondary, current wins if due.
   * Rollback (`?sceneloopfair=0`).
   */
  exclusiveSecondarySlot: boolean
  /** Fair path: send one starved mute after standing-in. */
  allowMuteSecondary: boolean
}

export type PickGuestsToSendResult = {
  sendIds: GuestId[]
  due: number
  inFlight: number
  muteSent: number
}

function muteScore(g: GuestSendSnapshot, now: number): number {
  const dist = Number.isFinite(g.distM) ? g.distM : Number.POSITIVE_INFINITY
  const wait = Math.max(1, now - (g.lastSentMs || 0))
  return (dist * dist) / wait
}

/**
 * Standing-in first, then one leftover mute ranked by dist² / wait.
 * Never aborts in-flight guests.
 */
export function pickGuestsToSend(
  guests: readonly GuestSendSnapshot[],
  opts: PickGuestsToSendOpts
): PickGuestsToSendResult {
  const sendIds: GuestId[] = []
  let due = 0
  let inFlight = 0
  let muteSent = 0
  const currentId = opts.currentGuestId
  const eligible: GuestSendSnapshot[] = []

  for (const g of guests) {
    if (g.inFlight) {
      inFlight++
      continue
    }
    if (!g.due) continue
    due++
    eligible.push(g)
  }

  if (opts.exclusiveSecondarySlot) {
    const currentDue = eligible.some((g) => g.kind === 'secondary' && g.id === currentId)
    let secondarySent = 0
    const ordered = [...eligible].sort((a, b) => {
      if (a.priority !== b.priority) return a.priority ? -1 : 1
      if (a.kind === 'primary') return -1
      if (b.kind === 'primary') return 1
      return 0
    })
    for (const g of ordered) {
      if (g.kind === 'secondary') {
        if (secondarySent >= 1) continue
        if (currentDue && g.id !== currentId) continue
        secondarySent++
      }
      sendIds.push(g.id)
    }
    return { sendIds, due, inFlight, muteSent }
  }

  const sent = new Set<GuestId>()
  const push = (id: GuestId): void => {
    if (sent.has(id)) return
    sent.add(id)
    sendIds.push(id)
  }

  const priorityDue = eligible
    .filter((g) => g.priority)
    .sort((a, b) => {
      if (a.kind === 'primary') return -1
      if (b.kind === 'primary') return 1
      return 0
    })
  for (const g of priorityDue) push(g.id)

  if (currentId) {
    const cur = eligible.find((g) => g.id === currentId && g.kind === 'secondary')
    if (cur) push(cur.id)
  }

  if (opts.allowMuteSecondary) {
    const mutes = eligible
      .filter((g) => g.kind === 'secondary' && g.id !== currentId && !sent.has(g.id))
      .sort((a, b) => muteScore(a, opts.now) - muteScore(b, opts.now))
    if (mutes[0]) {
      push(mutes[0].id)
      muteSent = 1
    }
  }

  return { sendIds, due, inFlight, muteSent }
}
