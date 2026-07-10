import type { Entity, IEngine } from '@dcl/ecs'
import * as generated from '@dcl/ecs/dist/components/generated/index.gen'
import { prepareVcForMainCameraBind, type MainCameraBindValue } from '../../virtual-camera/core'

const guarded = new WeakSet<IEngine>()

function wrapMainCameraMutable(engine: IEngine, entity: Entity, mutable: Record<string, unknown>): object {
  if (entity !== engine.CameraEntity) return mutable
  return new Proxy(mutable, {
    set(target, prop, value, receiver) {
      if (prop === 'virtualCameraEntity') {
        prepareVcForMainCameraBind(engine, entity, {
          virtualCameraEntity: value as Entity | null | undefined
        })
      }
      return Reflect.set(target, prop, value, receiver)
    }
  })
}

/**
 * Universal VirtualCamera bind guard — every scene gets ECS-authoritative VC pose
 * before MainCamera.virtualCameraEntity is written (createOrReplace or getMutable).
 */
export function installVirtualCameraBindGuard(engine: IEngine): void {
  if (guarded.has(engine)) return
  guarded.add(engine)

  const MainCamera = generated.MainCamera(engine)
  const originalCreateOrReplace = MainCamera.createOrReplace.bind(MainCamera)
  const originalGetMutable = MainCamera.getMutable.bind(MainCamera)
  const originalGetMutableOrNull =
    typeof MainCamera.getMutableOrNull === 'function' ?
      MainCamera.getMutableOrNull.bind(MainCamera)
    : null

  MainCamera.createOrReplace = ((entity: Entity, value?: unknown) => {
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