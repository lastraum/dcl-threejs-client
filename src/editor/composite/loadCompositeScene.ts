import * as THREE from 'three'
import type { ResolvedScene } from '../../dcl/content/types'
import type { AssetCache } from '../../rendering/AssetCache'
import { resolveGltfSrcHash, isEmoteAnchorGltfSrc } from '../../rendering/DclTextureResolver'
import { applyDclLocalTransform, type DclTransformValues } from '../../bridge/dclTransform'
import { readFileText } from '../localScene/localFileSystem'
import type { ProjectRoot } from '../localScene/projectRoot'
import { TERRAIN_COMPOSITE_ENTITY_ID } from './terrainComposite'

export const MAIN_COMPOSITE_PATH = 'assets/scene/main.composite'

type CompositeJson = {
  version: number
  components: Array<{
    name: string
    data: Record<string, { json: unknown }>
  }>
}

type CompositeTransform = DclTransformValues

function componentData(composite: CompositeJson, name: string): Record<string, { json: unknown }> {
  return composite.components.find((c) => c.name === name)?.data ?? {}
}

function transformDepth(
  entityId: number,
  transforms: Map<number, CompositeTransform>,
  cache: Map<number, number>
): number {
  const hit = cache.get(entityId)
  if (hit !== undefined) return hit
  const t = transforms.get(entityId)
  if (!t?.parent || t.parent === 0) {
    cache.set(entityId, 0)
    return 0
  }
  const depth = transformDepth(t.parent, transforms, cache) + 1
  cache.set(entityId, depth)
  return depth
}

function resolveParentObject(
  parentId: number | undefined,
  nodes: Map<number, THREE.Group>,
  compositeRoot: THREE.Group
): THREE.Object3D {
  if (!parentId || parentId === 0) return compositeRoot
  return nodes.get(parentId) ?? compositeRoot
}

export type CompositeSceneHandle = {
  root: THREE.Group
  entityCount: number
  gltfCount: number
  dispose(): void
}

/**
 * Static preview of scene items from main.composite — no scene script / ECS worker.
 */
export async function loadCompositeScene(
  scene: ResolvedScene,
  cache: AssetCache,
  threeScene: THREE.Scene,
  projectRoot: ProjectRoot,
  options?: {
    onProgress?: (msg: string) => void
    skipEntityIds?: ReadonlySet<number>
  }
): Promise<CompositeSceneHandle> {
  const onProgress = options?.onProgress
  const skipIds = options?.skipEntityIds ?? new Set<number>([TERRAIN_COMPOSITE_ENTITY_ID])

  onProgress?.('Reading main.composite…')
  const compositeText = await readFileText(projectRoot, MAIN_COMPOSITE_PATH)
  if (!compositeText?.trim()) {
    const root = new THREE.Group()
    root.name = 'composite-root'
    threeScene.add(root)
    return { root, entityCount: 0, gltfCount: 0, dispose: () => root.removeFromParent() }
  }

  const composite = JSON.parse(compositeText) as CompositeJson
  const transformData = componentData(composite, 'core::Transform')
  const gltfData = componentData(composite, 'core::GltfContainer')

  const transforms = new Map<number, CompositeTransform>()
  for (const [id, entry] of Object.entries(transformData)) {
    transforms.set(Number(id), entry.json as CompositeTransform)
  }

  const gltfs = new Map<number, { src: string }>()
  for (const [id, entry] of Object.entries(gltfData)) {
    const json = entry.json as { src?: string }
    const src = json.src?.trim()
    if (src) gltfs.set(Number(id), { src })
  }

  const entityIds = new Set<number>([...transforms.keys(), ...gltfs.keys()])
  for (const id of skipIds) entityIds.delete(id)

  const depthCache = new Map<number, number>()
  const sortedIds = [...entityIds].sort(
    (a, b) => transformDepth(a, transforms, depthCache) - transformDepth(b, transforms, depthCache)
  )

  const compositeRoot = new THREE.Group()
  compositeRoot.name = 'composite-root'
  const nodes = new Map<number, THREE.Group>()

  for (const entityId of sortedIds) {
    const group = new THREE.Group()
    group.name = `composite-entity-${entityId}`
    const t = transforms.get(entityId)
    if (t) {
      applyDclLocalTransform(group, t)
      resolveParentObject(t.parent, nodes, compositeRoot).add(group)
    } else {
      compositeRoot.add(group)
    }
    nodes.set(entityId, group)
  }

  const gltfJobs: Array<{ entityId: number; src: string; hash: string; url: string }> = []
  for (const [entityId, { src }] of gltfs) {
    if (skipIds.has(entityId)) continue
    if (isEmoteAnchorGltfSrc(src)) continue
    const hash = resolveGltfSrcHash(scene.content, src)
    if (!hash || hash.startsWith('local://')) continue
    const url = scene.assetUrl(hash)
    gltfJobs.push({ entityId, src, hash, url })
  }

  let loaded = 0
  onProgress?.(`Loading ${gltfJobs.length} model(s) from composite…`)

  await Promise.all(
    gltfJobs.map(async (job) => {
      const node = nodes.get(job.entityId)
      if (!node) return
      try {
        const model = await cache.clone(job.url, job.hash, { sceneGltf: true })
        model.name = `gltf-${job.entityId}`
        node.add(model)
      } catch (err) {
        console.warn('[editor] composite GLB failed', job.src, err)
      } finally {
        loaded++
        if (gltfJobs.length > 3 && loaded % 2 === 0) {
          onProgress?.(`Loading models (${loaded}/${gltfJobs.length})…`)
        }
      }
    })
  )

  threeScene.add(compositeRoot)
  onProgress?.(`Composite ready — ${sortedIds.length} entities, ${gltfJobs.length} models`)

  return {
    root: compositeRoot,
    entityCount: sortedIds.length,
    gltfCount: gltfJobs.length,
    dispose: () => {
      compositeRoot.removeFromParent()
    }
  }
}