import type { Entity, IEngine } from '@dcl/ecs'
import * as generated from '@dcl/ecs/dist/components/generated/index.gen'
import { prepareVcForMainCameraBind, type MainCameraBindValue } from '../../virtual-camera/core'
import { isPointerDeliveryInFlight, isPointerInputSessionActive } from './sceneWorkerInputSession'

const guarded = new WeakSet<IEngine>()
type MainCameraReplaceFn = (entity: Entity, value?: object) => unknown
const originalCreateOrReplaceByEngine = new WeakMap<IEngine, MainCameraReplaceFn>()

let lastBlockedClearLogAt = 0

function mainCameraVcEntity(value: unknown): Entity | null {
  const vc = (value as { virtualCameraEntity?: number | null } | null | undefined)?.virtualCameraEntity
  if (vc === undefined || vc === null) return null
  return vc as Entity
}

function readBoundVc(engine: IEngine): Entity | null {
  const MainCamera = generated.MainCamera(engine)
  const current = MainCamera.getOrNull(engine.CameraEntity) as { virtualCameraEntity?: number | null } | null
  return mainCameraVcEntity(current)
}

/** Allow RETURN TO PLAYER during pointer deliver; block accidental cooperative-tick clears only. */
function shouldBlockMainCameraClear(engine: IEngine): boolean {
  if (isPointerInputSessionActive() || isPointerDeliveryInFlight()) return false
  return readBoundVc(engine) !== null
}

function logBlockedClear(engine: IEngine, label: string): void {
  const now = performance.now()
  if (now - lastBlockedClearLogAt < 2000) return
  lastBlockedClearLogAt = now
  const live = readBoundVc(engine)
  console.log(
    `[vc-lens] worker guard — blocked MainCamera clear (${label}) liveVc=${live ?? 'null'}`
  )
}

function noteMainCameraWrite(engine: IEngine, entity: Entity, value: unknown): boolean {
  if (entity !== engine.CameraEntity) return false
  const vc = mainCameraVcEntity(value)
  if (vc !== null) return false
  return shouldBlockMainCameraClear(engine)
}

function wrapMainCameraMutable(engine: IEngine, entity: Entity, mutable: Record<string, unknown>): object {
  if (entity !== engine.CameraEntity) return mutable
  return new Proxy(mutable, {
    set(target, prop, value, receiver) {
      if (prop === 'virtualCameraEntity') {
        if (
          (value === undefined || value === null) &&
          shouldBlockMainCameraClear(engine)
        ) {
          logBlockedClear(engine, 'getMutable.virtualCameraEntity')
          return true
        }
        if (value !== undefined && value !== null) {
          prepareVcForMainCameraBind(engine, entity, {
            virtualCameraEntity: value as Entity
          })
        }
      }
      return Reflect.set(target, prop, value, receiver)
    }
  })
}

/**
 * Universal VirtualCamera bind guard — every scene gets ECS-authoritative VC pose
 * before MainCamera.virtualCameraEntity is written (createOrReplace or getMutable).
 * Blocks accidental `{}` clears outside pointer inject sessions (VIEW SHOT snap-back).
 * Stale transport clears are handled by reconcileMainCameraCrdtEgress on egress.
 */
export function installVirtualCameraBindGuard(engine: IEngine): void {
  if (guarded.has(engine)) return
  guarded.add(engine)

  const MainCamera = generated.MainCamera(engine)
  const originalCreateOrReplace = MainCamera.createOrReplace.bind(MainCamera)
  originalCreateOrReplaceByEngine.set(engine, originalCreateOrReplace as MainCameraReplaceFn)
  const originalGetMutable = MainCamera.getMutable.bind(MainCamera)
  const originalGetMutableOrNull =
    typeof MainCamera.getMutableOrNull === 'function' ?
      MainCamera.getMutableOrNull.bind(MainCamera)
    : null

  MainCamera.createOrReplace = ((entity: Entity, value?: unknown) => {
    if (noteMainCameraWrite(engine, entity, value ?? null)) {
      logBlockedClear(engine, 'createOrReplace')
      const live = readBoundVc(engine)
      if (live !== null) {
        prepareVcForMainCameraBind(engine, entity, { virtualCameraEntity: live })
        return originalCreateOrReplace(entity, { virtualCameraEntity: live } as never)
      }
      return originalCreateOrReplace(entity, value as never)
    }
    prepareVcForMainCameraBind(engine, entity, (value ?? null) as MainCameraBindValue | null)
    return originalCreateOrReplace(entity, value as never)
  }) as typeof MainCamera.createOrReplace

  MainCamera.getMutable = (entity: Entity) =>
    wrapMainCameraMutable(engine, entity, originalGetMutable(entity) as Record<string, unknown>)

  if (originalGetMutableOrNull) {
    MainCamera.getMutableOrNull = (entity: Entity) => {
      const mutable = originalGetMutableOrNull(entity)
      if (!mutable) return null
      return wrapMainCameraMutable(engine, entity, mutable as Record<string, unknown>)
    }
  }
}