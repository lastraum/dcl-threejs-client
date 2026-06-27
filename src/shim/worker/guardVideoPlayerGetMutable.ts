import type { Entity, IEngine } from '@dcl/ecs'
import * as generated from '@dcl/ecs/dist/components/generated/index.gen'

const guarded = new WeakSet<IEngine>()

/** Scene theatre video system can call VideoPlayer.getMutable(null) before screen entity exists. */
export function guardVideoPlayerGetMutable(engine: IEngine): void {
  if (guarded.has(engine)) return
  guarded.add(engine)

  const VideoPlayer = generated.VideoPlayer(engine)
  const originalMutable = VideoPlayer.getMutable.bind(VideoPlayer)
  const originalOrNull =
    typeof VideoPlayer.getMutableOrNull === 'function'
      ? VideoPlayer.getMutableOrNull.bind(VideoPlayer)
      : null
  const inert = {
    playing: false,
    src: '',
    loop: false,
    volume: 0,
    currentOffset: 0
  }

  const guardEntity = (entity: Entity): boolean =>
    entity == null || entity === (0 as Entity) || !Number.isFinite(entity as number)

  VideoPlayer.getMutableOrNull = (entity: Entity) => {
    if (guardEntity(entity)) return inert
    if (originalOrNull) {
      try {
        return originalOrNull(entity) ?? inert
      } catch {
        return inert
      }
    }
    try {
      return originalMutable(entity)
    } catch {
      return inert
    }
  }

  VideoPlayer.getMutable = (entity: Entity) => VideoPlayer.getMutableOrNull(entity) ?? inert
}