import type { Entity } from '@dcl/ecs'
import type { PBUiTransform } from '@dcl/ecs/dist/components/generated/pb/decentraland/sdk/components/ui_transform.gen'

export const CANVAS_ROOT_ENTITY = 0 as Entity

export type UiEntityRecord = {
  entity: Entity
  transform: PBUiTransform
}

/** Order siblings: first has `rightOf === 0`, then chain `rightOf === prev entity id`. */
export function orderUiSiblings(entities: Entity[], transformOf: (e: Entity) => PBUiTransform): Entity[] {
  if (entities.length <= 1) return [...entities]
  const byRightOf = new Map<number, Entity>()
  for (const e of entities) {
    byRightOf.set(transformOf(e).rightOf ?? 0, e)
  }
  const out: Entity[] = []
  let prevKey = 0
  const seen = new Set<Entity>()
  while (byRightOf.has(prevKey)) {
    const e = byRightOf.get(prevKey)!
    if (seen.has(e)) break
    seen.add(e)
    out.push(e)
    prevKey = e as number
  }
  for (const e of entities) {
    if (!seen.has(e)) out.push(e)
  }
  return out
}

export function buildUiForest(
  records: UiEntityRecord[]
): Map<Entity, Entity[]> {
  const byParent = new Map<number, Entity[]>()
  const transformOf = new Map<Entity, PBUiTransform>()
  for (const row of records) {
    transformOf.set(row.entity, row.transform)
    const parent = row.transform.parent ?? CANVAS_ROOT_ENTITY
    const list = byParent.get(parent) ?? []
    list.push(row.entity)
    byParent.set(parent, list)
  }
  const ordered = new Map<Entity, Entity[]>()
  for (const [parent, children] of byParent) {
    ordered.set(
      parent as Entity,
      orderUiSiblings(children, (e) => transformOf.get(e)!)
    )
  }
  return ordered
}