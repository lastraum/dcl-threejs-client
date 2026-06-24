import { ColliderLayer } from '../../collision/ColliderLayer'

/** Reserved entity id for editor-authored terrain in main.composite. */
export const TERRAIN_COMPOSITE_ENTITY_ID = 9001

type CompositeJson = {
  version: number
  components: Array<{
    name: string
    jsonSchema: unknown
    data: Record<string, { json: unknown }>
  }>
}

function emptyTransformSchema(): unknown {
  return {
    type: 'object',
    properties: {
      position: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } } },
      scale: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } } },
      rotation: {
        type: 'object',
        properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' }, w: { type: 'number' } }
      },
      parent: { type: 'integer' }
    },
    serializationType: 'transform'
  }
}

function emptyGltfSchema(): unknown {
  return {
    type: 'object',
    properties: {
      src: { type: 'string' },
      visibleMeshesCollisionMask: { type: 'integer' },
      invisibleMeshesCollisionMask: { type: 'integer' }
    }
  }
}

function findComponent(composite: CompositeJson, name: string) {
  let comp = composite.components.find((c) => c.name === name)
  if (!comp) {
    comp = {
      name,
      jsonSchema:
        name === 'core::Transform'
          ? emptyTransformSchema()
          : name === 'core::GltfContainer'
            ? emptyGltfSchema()
            : {},
      data: {}
    }
    composite.components.push(comp)
  }
  return comp
}

export function mergeTerrainIntoComposite(
  compositeText: string | null,
  opts: {
    glbSrc: string
    position: { x: number; y: number; z: number }
    entityId?: number
  }
): string {
  const entityId = String(opts.entityId ?? TERRAIN_COMPOSITE_ENTITY_ID)
  const composite: CompositeJson = compositeText
    ? (JSON.parse(compositeText) as CompositeJson)
    : { version: 1, components: [] }

  const transform = findComponent(composite, 'core::Transform')
  transform.data[entityId] = {
    json: {
      position: opts.position,
      scale: { x: 1, y: 1, z: 1 },
      rotation: { x: 0, y: 0, z: 0, w: 1 },
      parent: 0
    }
  }

  const gltf = findComponent(composite, 'core::GltfContainer')
  gltf.data[entityId] = {
    json: {
      src: opts.glbSrc,
      visibleMeshesCollisionMask: ColliderLayer.CL_NONE,
      invisibleMeshesCollisionMask: ColliderLayer.CL_PHYSICS
    }
  }

  return JSON.stringify(composite, null, 2)
}