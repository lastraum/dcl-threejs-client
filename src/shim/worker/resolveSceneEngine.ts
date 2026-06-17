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

/**
 * SDK7 scene bundles often omit `exports.engine` but embed the singleton on an internal
 * module (captured via pointerEventColliderChecker strip) or nested export bag.
 */
export function resolveSceneEngine(exports: SceneBundleExports): IEngine | null {
  if (isEngineLike(exports.engine)) return exports.engine

  const captured = takeCapturedSceneEngine()
  if (captured) return captured

  // Do not walk exports.main / export bags here — asset-pack bundles invoke scene init
  // and can stall boot (Rick Roll) before onStart runs.
  return null
}
