import type { Entity, IEngine } from '@dcl/ecs'
import * as generated from '@dcl/ecs/dist/components/generated/index.gen'
import { BLOCK_PLAYER_IM_CLEAR_KEY } from './patchClearPlayerInputModifier'
import { PATCH_INPUT_MODIFIER_SDK_KEY } from './patchInputModifierSdkSpread'
import { SCENE_ENGINE_CAPTURE_KEY } from './resolveSceneEngine'
import {
  CLEARED_INPUT_MODIFIER,
  isRefuseFreezeWrites,
  isWorkerLocomotionFreezeLatched,
  noteWorkerLocomotionClearWrite,
  noteWorkerLocomotionFreezeWrite
} from './workerPlayerFrameEgress'

const guardedCore = new WeakSet<IEngine>()
const guardedSdk = new WeakSet<object>()

let lastBlockedClearLogAt = 0

type StandardMode = {
  disableAll?: boolean
  disableWalk?: boolean
  disableJog?: boolean
  disableRun?: boolean
}

type InputModifierComponent = ReturnType<typeof generated.InputModifier>

function readStandardMode(value: unknown): StandardMode | null {
  const mode = (value as { mode?: { $case?: string; standard?: StandardMode } } | null | undefined)?.mode
  if (mode?.$case !== 'standard' || !mode.standard) return null
  return mode.standard
}

function locomotionFrozenStd(std: StandardMode): boolean {
  if (std.disableAll) return true
  return !!(std.disableWalk || std.disableJog || std.disableRun)
}

function locomotionClearedStd(std: StandardMode): boolean {
  if (std.disableAll) return false
  return !std.disableWalk && !std.disableJog && !std.disableRun
}

const WORKER_LOG_KEY = '__THREEJS_WORKER_LOG__'

function workerLog(message: string): void {
  const log = (globalThis as Record<string, unknown>)[WORKER_LOG_KEY] as
    | ((message: string) => void)
    | undefined
  if (log) log(message)
  else console.log(message)
}

function logBlockedClear(label: string): void {
  const now = performance.now()
  if (now - lastBlockedClearLogAt < 500) return
  lastBlockedClearLogAt = now
  workerLog(`[input-modifier] blocked locomotion clear (${label})`)
}

/**
 * Block accidental / double-toggle IM clear while MOVE CAMERA freeze is latched.
 * STOP clear during inject (without a freeze earlier in the same inject) is allowed.
 */
export function shouldBlockPlayerLocomotionClear(_engine: IEngine): boolean {
  // noteWorkerLocomotionClearWrite decides inject double-toggle vs STOP.
  return isWorkerLocomotionFreezeLatched()
}

function patchInputModifierCreateOrReplace(
  engine: IEngine,
  InputModifier: InputModifierComponent,
  label: string
): void {
  const originalCreateOrReplace = InputModifier.createOrReplace.bind(InputModifier)
  InputModifier.createOrReplace = ((entity: Entity, value?: unknown) => {
    if (entity === engine.PlayerEntity) {
      const next = readStandardMode(value)
      const wantFreeze = !!(next && locomotionFrozenStd(next))
      const wantClear = !!(next && locomotionClearedStd(next))

      // After STOP: block scene re-freeze from editFlightActive still true
      if (wantFreeze && isRefuseFreezeWrites()) {
        workerLog(`[input-modifier] blocked freeze write (${label}) — sticky STOP unfreeze`)
        return originalCreateOrReplace(entity, CLEARED_INPUT_MODIFIER as never)
      }

      if (wantClear) {
        if (noteWorkerLocomotionClearWrite()) {
          logBlockedClear(label)
          const live = InputModifier.getOrNull(entity)
          if (live) return originalCreateOrReplace(entity, live as never)
          return originalCreateOrReplace(entity, value as never)
        }
      }
    }
    const result = originalCreateOrReplace(entity, value as never)
    if (entity === engine.PlayerEntity) {
      const live = InputModifier.getOrNull(entity)
      const liveStd = live ? readStandardMode(live) : null
      if (liveStd && locomotionFrozenStd(liveStd)) {
        noteWorkerLocomotionFreezeWrite(live)
      } else if (!live || (liveStd && locomotionClearedStd(liveStd))) {
        noteWorkerLocomotionClearWrite()
      }
    }
    return result
  }) as typeof InputModifier.createOrReplace

  const originalDeleteFrom = InputModifier.deleteFrom.bind(InputModifier)
  InputModifier.deleteFrom = ((entity: Entity) => {
    if (entity === engine.PlayerEntity) {
      if (noteWorkerLocomotionClearWrite()) {
        logBlockedClear(`${label}-deleteFrom`)
        return InputModifier.getOrNull(entity)
      }
    }
    return originalDeleteFrom(entity)
  }) as typeof InputModifier.deleteFrom
}

export function installInputModifierLocomotionGuard(engine: IEngine): void {
  if (guardedCore.has(engine)) return
  guardedCore.add(engine)
  patchInputModifierCreateOrReplace(engine, generated.InputModifier(engine), 'core')
}

export function installInputModifierSdkPatchHook(): void {
  const g = globalThis as Record<string, unknown>
  g[PATCH_INPUT_MODIFIER_SDK_KEY] = (
    engine: IEngine,
    sdkComponent: InputModifierComponent,
    _coreComponent: InputModifierComponent
  ) => {
    if (guardedSdk.has(sdkComponent)) return
    guardedSdk.add(sdkComponent)
    patchInputModifierCreateOrReplace(engine, sdkComponent, 'sdk')
  }
}

export function installClearPlayerInputModifierBlockHook(): void {
  const g = globalThis as Record<string, unknown>
  g[BLOCK_PLAYER_IM_CLEAR_KEY] = () => {
    const engine = g[SCENE_ENGINE_CAPTURE_KEY] as IEngine | undefined
    if (!engine) return false
    if (noteWorkerLocomotionClearWrite()) {
      logBlockedClear('clearPlayerInputModifier')
      return true
    }
    return false
  }
}
