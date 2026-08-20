/**
 * SDK `engine.update(dt)` and `engine.addSystem((dt) => …)` are **seconds**.
 * SDK timers do `accumulatedTime += 1000 * dt`. Auth-server scenes (Last Call Dock)
 * already defend with `dt > 1 ? dt / 1000 : dt` when a host passes milliseconds.
 *
 * Values in (1, 250] are treated as milliseconds. Larger values are hitches and
 * stay seconds so the 250ms cap in the scheduler still applies.
 */
export const MAX_ENGINE_DT_SEC = 0.25

export function engineDtToSeconds(requested: number): number {
  if (!(requested > 0) || !Number.isFinite(requested)) return 0
  if (requested > 1 && requested <= 250) return requested / 1000
  return requested
}
