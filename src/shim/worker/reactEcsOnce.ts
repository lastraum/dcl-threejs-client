import type { IEngine } from '@dcl/ecs'

/** Patched bundle calls this instead of bare `e.addSystem(d,1e5,"@dcl/react-ecs")`. */
export const REACT_ECS_ONCE_KEY = '__THREEJS_UI_REACT_ECS_ONCE__'
export const REACT_ECS_REGISTERED_KEY = '__THREEJS_UI_REACT_ECS_REGISTERED__'

/**
 * Asset-pack init calls `createReactBasedUiSystem` a second time and registers
 * another `@dcl/react-ecs` reconcile with the main renderer unset — it runs
 * `update(null)` and/or steals the partitioned UI slot (Dead Surge mount=0).
 * Only the first registration (scene ReactEcsRenderer) may attach to the engine.
 *
 * Bundle patch must match any minified reconcile name and pretty-printed forms
 * (`ReactBasedUiSystem, 1e5, "@dcl/react-ecs"`).
 */
export function installReactEcsOnceGuard(): void {
  const g = globalThis as Record<string, unknown>
  if (typeof g[REACT_ECS_ONCE_KEY] === 'function') return
  g[REACT_ECS_ONCE_KEY] = (reconcile: (dt: number) => void, engine: IEngine) => {
    if (g[REACT_ECS_REGISTERED_KEY]) return
    g[REACT_ECS_REGISTERED_KEY] = true
    engine.addSystem(reconcile, 1e5, '@dcl/react-ecs')
  }
}

/** Clear once-flag before a new scene eval so the next first registration attaches. */
export function resetReactEcsOnceGuard(): void {
  const g = globalThis as Record<string, unknown>
  delete g[REACT_ECS_REGISTERED_KEY]
}