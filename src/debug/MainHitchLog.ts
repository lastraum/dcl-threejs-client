/**
 * One-line main-thread hitch attribution for FPS spikes.
 *
 * Always on for significant walls (default ≥50ms). No ?perfdebug required — the goal is
 * correlating "lag spike to 10" with remote VRM / pet / compose without drowning the console.
 *
 * Format: `[hitch] kind Nms detail…`
 */

const DEFAULT_THRESHOLD_MS = 50
/** Avoid double-firing the same kind in one burst (multi-step load). */
const KIND_GAP_MS = 150

const lastByKind = new Map<string, number>()

/**
 * @param kind short tag: `remote-vrm`, `remote-odk`, `remote-dcl`, `remote-pet`, `local-pet`, …
 * @param ms wall time of the load/compose block
 * @param detail free-form (name, hash, bytes) — keep short
 */
export function logMainHitch(
  kind: string,
  ms: number,
  detail = '',
  thresholdMs = DEFAULT_THRESHOLD_MS
): void {
  if (!(ms >= thresholdMs)) return
  const now = performance.now()
  const prev = lastByKind.get(kind) ?? 0
  if (now - prev < KIND_GAP_MS) return
  lastByKind.set(kind, now)
  const d = detail.trim()
  console.warn(`[hitch] ${kind} ${ms.toFixed(0)}ms${d ? ` ${d}` : ''}`)
}
