import type { IEngine } from '@dcl/ecs'

/** Patched bundle calls this instead of bare `e.addSystem(d,1e5,"@dcl/react-ecs")`. */
export const REACT_ECS_ONCE_KEY = '__THREEJS_UI_REACT_ECS_ONCE__'

/**
 * Asset-pack init calls `sw(engine)` a second time and registers another @dcl/react-ecs
 * reconcile with `n` never set — it runs `r.update(null)` and wipes scene UI.
 * Only the first registration (scene `cw.setUiRenderer`) may attach to the engine.
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