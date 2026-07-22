import type { Entity, IEngine } from '@dcl/ecs'
import * as generated from '@dcl/ecs/dist/components/generated/index.gen'
import { BLOCK_PLAYER_IM_CLEAR_KEY } from './patchClearPlayerInputModifier'
import { PATCH_INPUT_MODIFIER_SDK_KEY } from './patchInputModifierSdkSpread'
import { SCENE_ENGINE_CAPTURE_KEY } from './resolveSceneEngine'
import {
  noteWorkerLocomotionClearWrite,
  noteWorkerLocomotionFreezeWrite
} from './workerPlayerFrameEgress'

const guardedCore = new WeakSet<IEngine>()
const guardedSdk = new WeakSet<object>()

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

/**
 * Platform: scene always owns IM clears. Host never blocks.
 */
export function shouldBlockPlayerLocomotionClear(_engine: IEngine): boolean {
  return false
}

function patchInputModifierCreateOrReplace(
  engine: IEngine,
  InputModifier: InputModifierComponent,
  _label: string
): void {
  const originalCreateOrReplace = InputModifier.createOrReplace.bind(InputModifier)
  InputModifier.createOrReplace = ((entity: Entity, value?: unknown) => {
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
      noteWorkerLocomotionClearWrite()
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
  // Platform: never block clearPlayerInputModifier — scene owns IM.
  g[BLOCK_PLAYER_IM_CLEAR_KEY] = () => false
  void SCENE_ENGINE_CAPTURE_KEY
}
