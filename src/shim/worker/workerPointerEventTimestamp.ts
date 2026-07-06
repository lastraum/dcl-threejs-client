/**
 * Monotonic PointerEventsResult timestamps on the scene worker.
 * Must be shared by keyboard snapshots, inject-pointer-click, and renderer pointer appends —
 * @dcl/ecs getClick() rejects UP events whose timestamp is not > previousFrameMaxTimestamp.
 */
let nextTimestamp = 1

export function nextWorkerPointerEventTimestamp(): number {
  return nextTimestamp++
}

export function resetWorkerPointerEventTimestamp(): void {
  nextTimestamp = 1
}