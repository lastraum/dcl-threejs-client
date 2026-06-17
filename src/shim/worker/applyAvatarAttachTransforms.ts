import type { Entity, IEngine } from '@dcl/ecs'
import * as components from '@dcl/ecs/dist/components'
import type { AvatarAttachWorkerEntry } from '../../bridge/AvatarAttachBridge'

/** Apply renderer-owned avatar-relative transforms on the worker scene engine (SDK parity). */
export function applyAvatarAttachTransformsOnEngine(
  engine: IEngine,
  entries: AvatarAttachWorkerEntry[]
): void {
  if (!entries.length) return
  const Transform = components.Transform(engine)
  for (const entry of entries) {
    const entity = entry.entity as Entity
    const prev = Transform.has(entity) ? Transform.get(entity) : undefined
    Transform.createOrReplace(entity, {
      position: entry.position,
      rotation: entry.rotation,
      scale: entry.scale,
      parent: prev?.parent
    })
  }
}