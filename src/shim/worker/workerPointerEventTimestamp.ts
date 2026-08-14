/**
 * Monotonic PointerEventsResult timestamps on the scene worker.
 * Must be shared by keyboard snapshots, inject-pointer-click, and renderer pointer appends —
 * @dcl/ecs getClick() rejects UP events whose timestamp is not > previousFrameMaxTimestamp.
 */
let nextTimestamp = 1

export function nextWorkerPointerEventTimestamp(): number {
  return nextTimestamp++
}

/** Keep inject timestamps ahead of any PER already on the engine (getInputCommand). */
export function ensureWorkerPointerEventTimestampAfter(minExclusive: number): void {
  if (!Number.isFinite(minExclusive)) return
  const next = Math.floor(minExclusive) + 1
  if (nextTimestamp < next) nextTimestamp = next
}

export function resetWorkerPointerEventTimestamp(): void {
  nextTimestamp = 1
}