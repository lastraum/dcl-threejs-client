/**
 * Monotonic timestamps for all PointerEventsResult writes (UI clicks, keyboard relay, etc.).
 * @dcl/ecs inputSystem uses a single global frame window — split counters let relay events
 * advance previousFrameMaxTimestamp so UI click injects fail getClick().
 */
let nextTimestamp = 1

export function nextPointerEventTimestamp(): number {
  return nextTimestamp++
}

export function resetPointerEventTimestamp(): void {
  nextTimestamp = 1
}