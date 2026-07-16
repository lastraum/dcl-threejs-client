import type { IEngine } from '@dcl/ecs'

/** Patched bundle calls this instead of bare `e.addSystem(d,1e5,"@dcl/react-ecs")`. */
export const REACT_ECS_ONCE_KEY = '__THREEJS_UI_REACT_ECS_ONCE__'

/**
 * Asset-pack init calls `eS(engine)` / `sw(engine)` a second time and registers
 * another `@dcl/react-ecs` reconcile with the main renderer `n` never set — it runs
 * `update(null)` and wipes scene UI (Flagtag lobby `mount=0`).
 * Only the first registration (scene `setUiRenderer`) may attach to the engine.
 *
 * Bundle patch must match any minified reconcile name (`d`, `p`, …), not only `d`.
 */
export function installReactEcsOnceGuard(): void {
  const g = globalThis as Record<string, unknown>
  if (typeof g[REACT_ECS_ONCE_KEY] === 'function') return
  g[REACT_ECS_ONCE_KEY] = (reconcile: (dt: number) => void, engine: IEngine) => {
    if (g.__THREEJS_UI_REACT_ECS_REGISTERED__) return
    g.__THREEJS_UI_REACT_ECS_REGISTERED__ = true
    engine.addSystem(reconcile, 1e5, '@dcl/react-ecs')
  }
}