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

/**
 * Only entities reachable from the canvas root via a valid parent chain in this frame's
 * projection. Orphans (parent missing from projection) are CRDT lag — never render them.
 */
export function filterMountedUiRecords(records: UiEntityRecord[]): UiEntityRecord[] {
  if (records.length === 0) return records

  const byEntity = new Map<Entity, UiEntityRecord>()
  for (const row of records) byEntity.set(row.entity, row)

  const mounted = new Set<Entity>()
  const queue: Entity[] = []
  for (const row of records) {
    const parent = row.transform.parent ?? CANVAS_ROOT_ENTITY
    if (parent === CANVAS_ROOT_ENTITY || parent === 0) queue.push(row.entity)
  }

  while (queue.length > 0) {
    const entity = queue.shift()!
    if (mounted.has(entity) || !byEntity.has(entity)) continue
    mounted.add(entity)
    for (const row of records) {
      if ((row.transform.parent ?? CANVAS_ROOT_ENTITY) === entity) queue.push(row.entity)
    }
  }

  return records.filter((row) => mounted.has(row.entity))
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

/**
 * COD dirty scope: any Ui* change on E dirties E ∪ descendants(E).
 * Cousin panels under the same canvas root do not enter this set.
 */
export function expandDirtyWithDescendants(
  seeds: readonly Entity[],
  forest: ReadonlyMap<Entity, Entity[]>
): Entity[] {
  if (!seeds.length) return []
  const out: Entity[] = []
  const seen = new Set<Entity>()
  const stack = [...seeds]
  while (stack.length) {
    const e = stack.pop()!
    if (seen.has(e)) continue
    seen.add(e)
    out.push(e)
    const kids = forest.get(e)
    if (kids?.length) {
      for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]!)
    }
  }
  return out
}

/**
 * Layout-affecting dirties: entity ∪ descendants; if not absolute-only, also the
 * flex parent subtree (siblings reflow). Still does not touch cousin canvas roots.
 */
export function expandLayoutDirtyBranch(
  seeds: readonly Entity[],
  forest: ReadonlyMap<Entity, Entity[]>,
  transformOf: (e: Entity) => PBUiTransform | null,
  isAbsolute: (t: PBUiTransform) => boolean
): Entity[] {
  if (!seeds.length) return []
  const branchSeeds = new Set<Entity>()
  for (const e of seeds) {
    branchSeeds.add(e)
    const t = transformOf(e)
    if (!t || isAbsolute(t)) continue
    const parent = (t.parent ?? CANVAS_ROOT_ENTITY) as Entity
    if (parent !== CANVAS_ROOT_ENTITY && (parent as number) !== 0) {
      branchSeeds.add(parent)
    }
  }
  return expandDirtyWithDescendants([...branchSeeds], forest)
}