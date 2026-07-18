import type { Entity, IEngine } from '@dcl/ecs'
import * as generated from '@dcl/ecs/dist/components/generated/index.gen'

const guarded = new WeakSet<IEngine>()

const WORKER_LOG_KEY = '__THREEJS_WORKER_LOG__'

function workerLog(message: string): void {
  const log = (globalThis as Record<string, unknown>)[WORKER_LOG_KEY] as
    | ((message: string) => void)
    | undefined
  if (log) log(message)
  else console.log(message)
}

/**
 * Genesis plaza sit/plant systems call GltfContainer.getMutable(entity) without has().
 * When the entity lost its container (or never had one), ECS throws and aborts the system
 * mid-handler — freeze applies, triggerSceneEmote never runs. Soft-create so handlers finish.
 */
export function guardGltfContainerGetMutable(engine: IEngine): void {
  if (guarded.has(engine)) return
  guarded.add(engine)

  const GltfContainer = generated.GltfContainer(engine)
  const originalMutable = GltfContainer.getMutable.bind(GltfContainer)
  const originalOrNull =
    typeof GltfContainer.getMutableOrNull === 'function'
      ? GltfContainer.getMutableOrNull.bind(GltfContainer)
      : null
  const createOrReplace =
    typeof GltfContainer.createOrReplace === 'function'
      ? GltfContainer.createOrReplace.bind(GltfContainer)
      : null
  const create = typeof GltfContainer.create === 'function' ? GltfContainer.create.bind(GltfContainer) : null

  const softCreate = (entity: Entity) => {
    try {
      if (createOrReplace) return createOrReplace(entity, { src: '' })
      if (create) return create(entity, { src: '' })
    } catch {
      /* entity may be invalid */
    }
    return { src: '' }
  }

  GltfContainer.getMutableOrNull = (entity: Entity) => {
    if (entity == null || !Number.isFinite(entity as number)) return null
    if (originalOrNull) {
      try {
        const hit = originalOrNull(entity)
        if (hit) return hit
      } catch {
        /* fall through */
      }
    }
    try {
      return originalMutable(entity)
    } catch {
      return null
    }
  }

  GltfContainer.getMutable = (entity: Entity) => {
    if (entity == null || !Number.isFinite(entity as number)) {
      return softCreate(0 as Entity)
    }
    if (originalOrNull) {
      try {
        const hit = originalOrNull(entity)
        if (hit) return hit
      } catch {
        /* fall through */
      }
    }
    try {
      return originalMutable(entity)
    } catch {
      workerLog(
        `[sceneWorker] GltfContainer.getMutable soft-create e${entity} (scene would have thrown)`
      )
      return softCreate(entity)
    }
  }
}
