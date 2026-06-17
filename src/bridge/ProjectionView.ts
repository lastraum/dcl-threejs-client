import type { Entity, IEngine } from '@dcl/ecs'
import type { MirrorComponents } from './mirrorComponents'
import type { CrdtProjection } from './CrdtProjection'

export interface ProjectionView {
  readonly components: MirrorComponents
  readonly RootEntity: Entity
  readonly PlayerEntity: Entity
  readonly CameraEntity: Entity
  readonly getEntitiesWith: IEngine['getEntitiesWith']
}

export interface ReservedEntities {
  root: Entity
  player: Entity
  camera: Entity
}

type AnyComponentDef = MirrorComponents[keyof MirrorComponents]

/**
 * Read/write facade: `@dcl/ecs` component schemas for ids/serialization,
 * `CrdtProjection` typed maps for all runtime state.
 */
export function createStoreComponents(
  templates: MirrorComponents,
  projection: CrdtProjection
): MirrorComponents {
  const out = {} as Record<string, AnyComponentDef>
  for (const [name, def] of Object.entries(templates) as Array<[string, AnyComponentDef]>) {
    if (!def?.componentId) continue
    const componentId = def.componentId
    const facade = Object.create(def) as Record<string, unknown>

    facade.get = (entity: Entity): unknown => {
      const value = projection.get(componentId, entity)
      if (value === undefined) {
        throw new Error(`[StoreComponents] ${def.componentName}.get(${entity}) on entity without the component`)
      }
      return value
    }
    facade.getOrNull = (entity: Entity): unknown => {
      const value = projection.get(componentId, entity)
      return value === undefined ? null : value
    }
    facade.has = (entity: Entity): boolean => projection.has(componentId, entity)

    if (typeof (def as { createOrReplace?: unknown }).createOrReplace === 'function') {
      facade.createOrReplace = (entity: Entity, value: unknown): unknown => {
        projection.setRenderer(componentId, entity, value)
        return value
      }
    }
    if (typeof (def as { addValue?: unknown }).addValue === 'function') {
      facade.addValue = (entity: Entity, value: unknown): unknown => {
        projection.appendRenderer(componentId, entity, value)
        return value
      }
    }

    out[name] = facade as unknown as AnyComponentDef
  }
  return out as unknown as MirrorComponents
}

/** Expose the typed `CrdtProjection` as a `ProjectionView`. */
export function projectionViewFromProjection(
  projection: CrdtProjection,
  components: MirrorComponents,
  reserved: ReservedEntities
): ProjectionView {
  const getEntitiesWith = ((...defs: Array<{ componentId: number }>) => {
    const [first, ...rest] = defs
    const firstMap = first ? projection.componentMap(first.componentId) : undefined
    function* iter(): IterableIterator<[Entity, ...unknown[]]> {
      if (!firstMap) return
      outer: for (const [entity, value] of firstMap) {
        const tuple: unknown[] = [value]
        for (const def of rest) {
          if (!projection.has(def.componentId, entity)) continue outer
          tuple.push(projection.get(def.componentId, entity))
        }
        yield [entity, ...tuple]
      }
    }
    return iter()
  }) as unknown as IEngine['getEntitiesWith']

  return {
    components,
    RootEntity: reserved.root,
    PlayerEntity: reserved.player,
    CameraEntity: reserved.camera,
    getEntitiesWith
  }
}
