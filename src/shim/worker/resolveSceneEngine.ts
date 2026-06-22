import type { IEngine } from '@dcl/ecs'
import type { SceneBundleExports } from '../system/createSystemStubs'

/** Set during bundle eval when stripping bundled pointerEventColliderChecker(engine). */
export const SCENE_ENGINE_CAPTURE_KEY = '__THREEJS_SCENE_ENGINE__'

export function isEngineLike(val: unknown): val is IEngine {
  if (!val || typeof val !== 'object') return false
  const o = val as Record<string, unknown>
  return (
    typeof o.update === 'function' &&
    typeof o.addSystem === 'function' &&
    typeof o.getEntitiesWith === 'function'
  )
}

export function takeCapturedSceneEngine(): IEngine | null {
  const g = globalThis as Record<string, unknown>
  const eng = g[SCENE_ENGINE_CAPTURE_KEY]
  delete g[SCENE_ENGINE_CAPTURE_KEY]
  return isEngineLike(eng) ? eng : null
}

const SKIP_ENGINE_GRAPH_KEYS = new Set(['onStart', 'onUpdate', 'main', 'rendererTransport'])

/** Shallow export-bag scan — skips thunks/getters; does not invoke `main`. */
function findEngineInExportGraph(root: unknown, maxDepth: number): IEngine | null {
  const seen = new Set<object>()
  const queue: { val: unknown; depth: number }[] = [{ val: root, depth: 0 }]

  while (queue.length) {
    const item = queue.shift()
    if (!item) continue
    const { val, depth } = item
    if (!val || typeof val !== 'object') continue
    if (seen.has(val)) continue
    seen.add(val)

    if (isEngineLike(val)) return val
    if (depth >= maxDepth) continue

    for (const key of Object.getOwnPropertyNames(val)) {
      if (SKIP_ENGINE_GRAPH_KEYS.has(key)) continue
      const desc = Object.getOwnPropertyDescriptor(val, key)
      if (!desc || desc.get || typeof desc.value !== 'object' || desc.value == null) continue
      queue.push({ val: desc.value, depth: depth + 1 })
    }
  }

  return null
}

/**
 * SDK7 scene bundles often omit `exports.engine`. Capture hooks in `patchSceneBundle`:
 * `pointerEventColliderChecker(engine)` (dev bundles) and `engine.addTransport(renderer)` (minified).
 */
export function resolveSceneEngine(exports: SceneBundleExports): IEngine | null {
  // addTransport / checker capture runs on the scene runtime engine — prefer it over
  // exports.engine (SDK singleton re-exports can point at a different instance).
  const captured = takeCapturedSceneEngine()
  if (captured) return captured

  if (isEngineLike(exports.engine)) return exports.engine

  return findEngineInExportGraph(exports, 2)
}
