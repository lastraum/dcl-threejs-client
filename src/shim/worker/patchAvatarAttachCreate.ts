import type { Entity, IEngine } from '@dcl/ecs'
import * as generated from '@dcl/ecs/dist/components/generated/index.gen'

const guarded = new WeakSet<IEngine>()

/**
 * Scenes (and network resync paths) often call AvatarAttach.create after the component
 * already exists from a prior create / CRDT PUT — throws "already exists" and aborts
 * world advance after character select (planet-angzaar entity 556).
 *
 * Explorer is effectively create-or-replace for LWW components. Map create → createOrReplace
 * when the entity already has AvatarAttach.
 */
export function installAvatarAttachCreateGuard(engine: IEngine): void {
  if (guarded.has(engine)) return
  guarded.add(engine)

  const AvatarAttach = generated.AvatarAttach(engine)
  const originalCreate = AvatarAttach.create.bind(AvatarAttach)
  const createOrReplace = AvatarAttach.createOrReplace.bind(AvatarAttach)

  AvatarAttach.create = ((entity: Entity, value?: unknown) => {
    if (AvatarAttach.has(entity)) {
      return createOrReplace(entity, value as never)
    }
    return originalCreate(entity, value as never)
  }) as typeof AvatarAttach.create
}
