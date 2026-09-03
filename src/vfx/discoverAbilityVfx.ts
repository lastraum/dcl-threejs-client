/**
 * Ability warm list from mirrored `tjs` ECS rows — never a global warm list.
 */
import type { MirrorComponents } from '../bridge/mirrorComponents'
import type { ProjectionView } from '../bridge/ProjectionView'
import type { TjsValue } from '../dcl/ecs/tjsComponent'
import { normalizeAbilityVfxId } from './tjsVfxIds'

export function sceneUsesTjsComponent(
  view: ProjectionView,
  Tjs: MirrorComponents['Tjs']
): boolean {
  for (const [_entity] of view.getEntitiesWith(Tjs)) return true
  return false
}

/** Shader kind names to warm for this scene. Empty → do not boot AbilityManager. */
export function discoverAbilityVfxIds(
  view: ProjectionView,
  Tjs: MirrorComponents['Tjs']
): string[] {
  const found = new Set<string>()
  for (const [entity] of view.getEntitiesWith(Tjs)) {
    void entity
    const row = Tjs.getOrNull(entity) as TjsValue | null
    if (!row || row.kind !== 'shader') continue
    const id = normalizeAbilityVfxId(row.name)
    if (id) found.add(id)
  }
  return [...found]
}
