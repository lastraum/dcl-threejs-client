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

function findEngineInGraph(root: unknown, maxDepth = 10): IEngine | null {
  if (root == null || maxDepth < 0) return null
  if (isEngineLike(root)) return root
  if (typeof root !== 'object') return null

  const seen = new Set<object>()
  const queue: Array<{ val: unknown; depth: number }> = [{ val: root, depth: 0 }]

  while (queue.length) {
    const item = queue.shift()
    if (!item) continue
    const { val, depth } = item
    if (!val || typeof val !== 'object') continue
    if (seen.has(val)) continue
    seen.add(val)

    if (isEngineLike(val)) return val

    const rec = val as Record<string, unknown>
    if (isEngineLike(rec.engine)) return rec.engine

    if (depth >= maxDepth) continue
    for (const key of Object.keys(rec)) {
      queue.push({ val: rec[key], depth: depth + 1 })
    }
  }
  return null
}

/**
 * SDK7 scene bundles often omit `exports.engine` but embed the singleton on an internal
 * module (captured via pointerEventColliderChecker strip) or nested export bag.
 */
export function resolveSceneEngine(exports: SceneBundleExports): IEngine | null {
  if (isEngineLike(exports.engine)) return exports.engine

  const captured = takeCapturedSceneEngine()
  if (captured) return captured

  const fromExports = findEngineInGraph(exports)
  if (fromExports) return fromExports

  if (typeof exports.main === 'function') {
    try {
      const mainResult = exports.main()
      if (isEngineLike(mainResult)) return mainResult
      const fromMain = findEngineInGraph(mainResult)
      if (fromMain) return fromMain
    } catch {
      /* main() optional */
    }
  }

  return null
}
