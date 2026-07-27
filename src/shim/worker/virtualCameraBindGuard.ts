import type { Entity, IEngine } from '@dcl/ecs'
import * as generated from '@dcl/ecs/dist/components/generated/index.gen'
import { prepareVcForMainCameraBind, type MainCameraBindValue } from '../../virtual-camera/core'

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

/**
 * Scene owns MainCamera unbind. Never permanently block clears:
 * SpaceRunner map flyover ends with getMutable.virtualCameraEntity = null / createOrReplace({})
 * outside a pointer inject — blocking left the lens stuck on the preview cam (logs:
 * `blocked MainCamera clear (getMutable.virtualCameraEntity) liveVc=…`).
 *
 * VIEW SHOT / transport thrash is handled by reconcileMainCameraCrdtEgress (strip+re-emit
 * live snapshot), not by refusing intentional scene writes.
 */
function noteMainCameraWrite(_engine: IEngine, entity: Entity, value: unknown): boolean {
  void _engine
  void entity
  void value
  return false
}

function wrapMainCameraMutable(engine: IEngine, entity: Entity, mutable: Record<string, unknown>): object {
  if (entity !== engine.CameraEntity) return mutable
  return new Proxy(mutable, {
    set(target, prop, value, receiver) {
      if (prop === 'virtualCameraEntity') {
        if (value !== undefined && value !== null) {
          prepareVcForMainCameraBind(engine, entity, {
            virtualCameraEntity: value as Entity
          })
        } else {
          const was = readBoundVc(engine)
          if (was !== null) {
            const now = performance.now()
            if (now - lastBlockedClearLogAt >= 500) {
              lastBlockedClearLogAt = now
              console.log(
                `[vc-lens] worker — MainCamera clear (getMutable) was=e${was} → player lens`
              )
            }
          }
        }
      }
      return Reflect.set(target, prop, value, receiver)
    }
  })
}

/**
 * Dead Surge (and many SDK scenes) gate VC bind with:
 *   if (!MainCamera.has(CameraEntity)) return
 *   MainCamera.getMutable(CameraEntity).virtualCameraEntity = vc
 * Boot getState often never seeds MainCamera on CameraEntity — bind never runs, freecam
 * keeps orbit, and the client never sees a VirtualCamera lens.
 */
export function ensureMainCameraOnCameraEntity(engine: IEngine): void {
  const MainCamera = generated.MainCamera(engine)
  if (MainCamera.has(engine.CameraEntity)) return
  const original = originalCreateOrReplaceByEngine.get(engine)
  if (original) {
    original(engine.CameraEntity, {})
  } else {
    MainCamera.createOrReplace(engine.CameraEntity, {})
  }
  console.log('[vc-lens] worker — seeded MainCamera on CameraEntity (scene has()-guard requires it)')
}

/**
 * Universal VirtualCamera bind guard — every scene gets ECS-authoritative VC pose
 * before MainCamera.virtualCameraEntity is written (createOrReplace or getMutable).
 * Clears are always allowed (scene owns unbind — flyover / return-to-player).
 * Stale transport MainCamera thrash is handled by reconcileMainCameraCrdtEgress.
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
  const originalGetOrCreateMutable =
    typeof (MainCamera as { getOrCreateMutable?: (e: Entity, v?: unknown) => unknown }).getOrCreateMutable ===
    'function'
      ? (MainCamera as { getOrCreateMutable: (e: Entity, v?: unknown) => unknown }).getOrCreateMutable.bind(
          MainCamera
        )
      : null

  MainCamera.createOrReplace = ((entity: Entity, value?: unknown) => {
    void noteMainCameraWrite(engine, entity, value ?? null)
    const vc = mainCameraVcEntity(value ?? null)
    if (vc === null && entity === engine.CameraEntity) {
      const was = readBoundVc(engine)
      if (was !== null) {
        const now = performance.now()
        if (now - lastBlockedClearLogAt >= 500) {
          lastBlockedClearLogAt = now
          console.log(
            `[vc-lens] worker — MainCamera clear (createOrReplace) was=e${was} → player lens`
          )
        }
      }
    }
    prepareVcForMainCameraBind(engine, entity, (value ?? null) as MainCameraBindValue | null)
    return originalCreateOrReplace(entity, value as never)
  }) as typeof MainCamera.createOrReplace

  MainCamera.getMutable = (entity: Entity) => {
    // CameraEntity: create empty shell so scene has()-guards / getMutable binds succeed.
    if (entity === engine.CameraEntity && !MainCamera.has(entity)) {
      originalCreateOrReplace(entity, {})
    }
    const mutable =
      originalGetOrCreateMutable && entity === engine.CameraEntity
        ? (originalGetOrCreateMutable(entity, {}) as Record<string, unknown>)
        : (originalGetMutable(entity) as Record<string, unknown>)
    return wrapMainCameraMutable(engine, entity, mutable)
  }

  if (originalGetMutableOrNull) {
    MainCamera.getMutableOrNull = (entity: Entity) => {
      if (entity === engine.CameraEntity && !MainCamera.has(entity)) {
        originalCreateOrReplace(entity, {})
      }
      const mutable = originalGetMutableOrNull(entity)
      if (!mutable) return null
      return wrapMainCameraMutable(engine, entity, mutable as Record<string, unknown>)
    }
  }

  ensureMainCameraOnCameraEntity(engine)
}