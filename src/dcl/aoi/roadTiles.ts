import * as THREE from 'three'
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js'
import { dclToThreePos, dclToThreeQuat } from '../../bridge/dclTransform'
import { clientDebugLog } from '../../client/debug/ClientDebugLog'
import { catalystContentAssetUrl } from '../../network/catalyst/CatalystClient'
import type { AssetCache } from '../../rendering/AssetCache'
import { PARCEL_SIZE } from '../content/types'
import { isClassicOpenRoadContent, type ActiveSceneEntity } from './fetchActiveEntities'
import { parcelSwSceneLocal } from './parcelAoi'
import { getExplorerRoadEntry, loadExplorerRoadCatalog } from './explorerRoadCatalog'

/**
 * Genesis City roads — Explorer client pipeline:
 * 1. SingleParcelRoadInfo.json → model + rotation per parcel
 * 2. roadAssemblies.json → per-model parts (RoadTile, RoadSide, Lamp, Bench, Hedge…)
 *    with local matrices (from unity-explorer RoadTilesAssembled prefabs)
 * 3. RoadRedesign FBX props under /roads/props/
 * 4. All parts batched as InstancedMesh (one draw call per mesh leaf × prop type)
 *
 * Does NOT run SDK6 game.js or bare catalyst OpenRoad-only GLBs as primary visual.
 */

const fbxLoader = new FBXLoader()
const propTemplateCache = new Map<string, Promise<THREE.Object3D | null>>()
const propLeafCache = new Map<string, Promise<PropMeshLeaf[]>>()
const propColliderCache = new Map<string, Promise<PropColliderLeaf[]>>()
const textureLoader = new THREE.TextureLoader()
const textureCache = new Map<string, Promise<THREE.Texture | null>>()

type AssemblyPart = { mesh: string; m: number[] }
type Assemblies = Record<string, AssemblyPart[]>

let assembliesPromise: Promise<Assemblies> | null = null
let assemblies: Assemblies | null = null

/** Per-prop albedo / normal / emissive under /roads/props/ (Explorer RoadRedesign). */
const PROP_MATERIALS: Record<
  string,
  {
    map?: string
    normalMap?: string
    emissiveMap?: string
    alphaMap?: string
    color?: number
    roughness?: number
    foliage?: boolean
  }
> = {
  RoadTile01: {
    map: 'RoadTiles_v01_basecolor.png',
    normalMap: 'RoadTiles_v01_normal.png',
    color: 0xb0b0b0,
    roughness: 0.85
  },
  // FBX material is RoadAssets_mat → RoadAssetsAtlas (curb studs / purple edge).
  RoadSideStraight: {
    map: 'RoadAssetsAtlas_basecolor.png',
    color: 0xffffff,
    roughness: 0.88
  },
  RoadSideDecor01: {
    map: 'RoadAssetsAtlas_basecolor.png',
    color: 0xffffff,
    roughness: 0.88
  },
  RoadSideL: {
    map: 'RoadAssetsAtlas_basecolor.png',
    color: 0xffffff,
    roughness: 0.88
  },
  RoadSideCornerSmall: {
    map: 'RoadAssetsAtlas_basecolor.png',
    color: 0xffffff,
    roughness: 0.88
  },
  RoadSideDeadend: {
    map: 'RoadAssetsAtlas_basecolor.png',
    color: 0xffffff,
    roughness: 0.88
  },
  RoadSideClosedOff: {
    map: 'RoadAssetsAtlas_basecolor.png',
    color: 0xffffff,
    roughness: 0.88
  },
  Lamp01: {
    map: 'Lamp_mat_baseColor.png',
    normalMap: 'Lamp_mat_normal.png',
    emissiveMap: 'Lamp_mat_emissive.png',
    color: 0xcccccc,
    roughness: 0.55
  },
  Bench01: {
    map: 'Bench_mat_baseColor.png',
    normalMap: 'Bench_mat_normal.png',
    color: 0x8b6914,
    roughness: 0.75
  },
  /**
   * Explorer HedgeLeaf mat: leaf atlas as albedo×alpha cutout, body tint multiplies.
   * FBX vertex colors are a red wind/mask channel — never use as RGB albedo.
   * Pink blooms: separate HedgeFlowersMiddleLarge + flower atlas.
   */
  HedgeMiddleLarge: {
    map: 'HedgeLeaf.png',
    alphaMap: 'HedgeLeaf.png',
    color: 0x4a9e45,
    roughness: 0.88,
    foliage: true
  },
  /** Autumn orange long hedge (Explorer mixes green/orange planters). */
  HedgeMiddleLargeOrange: {
    map: 'HedgeLeaf.png',
    alphaMap: 'HedgeLeaf.png',
    color: 0xe07a28,
    roughness: 0.88,
    foliage: true
  },
  HedgeBall: {
    map: 'HedgeLeaf.png',
    alphaMap: 'HedgeLeaf.png',
    color: 0x3d9140,
    roughness: 0.88,
    foliage: true
  },
  /** Autumn orange ball variant (Explorer mixes green/orange balls). */
  HedgeBallOrange: {
    map: 'HedgeLeaf.png',
    alphaMap: 'HedgeLeaf.png',
    color: 0xe07a28,
    roughness: 0.88,
    foliage: true
  },
  HedgeFlowersMiddleLarge: {
    map: 'HedgeFlower_color.png',
    normalMap: 'HedgeFlower_normal.png',
    color: 0xffffff,
    roughness: 0.85,
    foliage: true
  },
  PotTree: {
    map: 'PotMiddleLarge_mat_baseColor.png',
    color: 0x8a8070,
    roughness: 0.85
  },
  PotMiddleLarge: {
    map: 'PotMiddleLarge_mat_baseColor.png',
    color: 0xb0a090,
    roughness: 0.88
  },
  FountainBase: {
    map: 'RoadAtlas_basecolor.png',
    color: 0xa8a8a8,
    roughness: 0.7
  },
  FountainBottom: {
    map: 'RoadAtlas_basecolor.png',
    color: 0xa0a0a0,
    roughness: 0.7
  }
}

const materialCache = new Map<string, Promise<THREE.MeshStandardMaterial>>()

/** One renderable mesh leaf from a prop FBX (shared geometry + material). */
export type PropMeshLeaf = {
  key: string
  meshName: string
  geometry: THREE.BufferGeometry
  material: THREE.Material
  /** Relative to baked prop root. */
  localMatrix: THREE.Matrix4
}

/** FBX `*_collider` mesh in prop-local space (shared across instances). */
export type PropColliderLeaf = {
  key: string
  meshName: string
  geometry: THREE.BufferGeometry
  localMatrix: THREE.Matrix4
}

export type RoadTilePlacement = {
  entityId: string
  parcelKey: string
  model: string
  rotation: { x: number; y: number; z: number; w: number }
  catalystHash?: string
  catalystFile?: string
  source: 'explorer-catalog' | 'catalyst-fallback'
}

/** Reserved PhysX entity ids for AOI road furniture (positive — not landscape walls). */
export const ROAD_AOI_COLLIDER_ENTITY_BASE = 21_000_000
/**
 * Span for stable hashed road entity ids.
 * Must not overlap GLTF base 20_000_000 or small primary MeshCollider ECS ids.
 */
export const ROAD_AOI_COLLIDER_ID_SPAN = 8_000_000

/**
 * Stable PhysX entity id for a road prop instance across AOI rebuilds.
 * Sequential ids (old path) forced a full 400-actor remove+recook every parcel edge change.
 */
export function stableRoadColliderEntityId(instanceKey: string): number {
  let h = 2166136261
  for (let i = 0; i < instanceKey.length; i++) {
    h ^= instanceKey.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return ROAD_AOI_COLLIDER_ENTITY_BASE + ((h >>> 0) % ROAD_AOI_COLLIDER_ID_SPAN)
}

export type InstancedRoadBuildResult = {
  root: THREE.Group
  parcelCount: number
  instanceCount: number
  drawBuckets: number
  fallbackClones: number
  /**
   * Physics descs using real FBX collider meshes (not boxes).
   * Shared geometry fingerprints → PhysX cook cache reuses trimeshes.
   */
  colliders: import('../../physics/PhysXWorld').PhysicsColliderDesc[]
}

export function isClassicOpenRoadTile(ent: ActiveSceneEntity): boolean {
  if (getExplorerRoadEntry(ent.base) || getExplorerRoadEntry(ent.pointers[0] ?? '')) {
    return true
  }
  return isClassicOpenRoadContent(ent)
}

export async function ensureExplorerRoadsReady(): Promise<void> {
  await Promise.all([loadExplorerRoadCatalog(), loadRoadAssemblies()])
}

async function loadRoadAssemblies(): Promise<Assemblies> {
  if (assemblies) return assemblies
  if (assembliesPromise) return assembliesPromise
  assembliesPromise = (async () => {
    const res = await fetch('/roads/layouts/roadAssemblies.json')
    if (!res.ok) throw new Error(`roadAssemblies.json ${res.status}`)
    const data = (await res.json()) as Assemblies
    assemblies = data
    console.info(
      `[roads] Explorer assemblies loaded — ${Object.keys(data).length} road types`
    )
    return data
  })().catch((err) => {
    assembliesPromise = null
    console.warn('[roads] assemblies load failed', err)
    assemblies = {}
    return assemblies
  })
  return assembliesPromise
}

export async function resolveRoadTilePlacement(
  ent: ActiveSceneEntity,
  _contentUrl: string
): Promise<RoadTilePlacement | null> {
  await loadExplorerRoadCatalog()
  const parcels = ent.parcels.length ? ent.parcels : ent.pointers
  const parcelKey = (parcels[0] ?? ent.base).trim()
  const entry = getExplorerRoadEntry(parcelKey) ?? getExplorerRoadEntry(ent.base)
  if (entry) {
    return {
      entityId: ent.id,
      parcelKey,
      model: entry.model,
      rotation: entry.rotation,
      source: 'explorer-catalog'
    }
  }
  if (!isClassicOpenRoadContent(ent)) return null
  const glb = findCatalystRoadGlb(ent)
  if (!glb) return null
  return {
    entityId: ent.id,
    parcelKey,
    model: glb.file.replace(/\.glb$/i, ''),
    rotation: { x: 0, y: 0, z: 0, w: 1 },
    catalystHash: glb.hash,
    catalystFile: glb.file,
    source: 'catalyst-fallback'
  }
}

function assemblyPartsForModel(model: string): AssemblyPart[] | null {
  return (
    assemblies?.[model] ??
    assemblies?.['OpenRoad_0'] ??
    assemblies?.['OpenRoad_A'] ??
    null
  )
}

/**
 * Batch all road parcels into InstancedMeshes — one draw call per prop mesh leaf.
 * Also emits PhysicsColliderDesc[] from real FBX `*_collider` meshes (shared cook).
 */
export async function buildInstancedRoadLayer(opts: {
  placements: RoadTilePlacement[]
  primaryBase: string
  cache: AssetCache
  contentBaseUrl: string
}): Promise<InstancedRoadBuildResult> {
  await loadRoadAssemblies()

  const root = new THREE.Group()
  root.name = 'aoi-roads-instanced'

  const buckets = new Map<string, { leaf: PropMeshLeaf; matrices: THREE.Matrix4[] }>()
  const colliders: import('../../physics/PhysXWorld').PhysicsColliderDesc[] = []
  /** Detect rare stable-id collisions within one build. */
  const usedColliderEntities = new Set<number>()
  const fallbackRoot = new THREE.Group()
  fallbackRoot.name = 'aoi-roads-catalyst-fallback'

  const rootPos = new THREE.Vector3()
  const rootQuat = new THREE.Quaternion()
  const rootMat = new THREE.Matrix4()
  const partMat = new THREE.Matrix4()
  const baseMat = new THREE.Matrix4()
  const finalMat = new THREE.Matrix4()
  const lp = new THREE.Vector3()
  const lq = new THREE.Quaternion()
  const ls = new THREE.Vector3()

  let instanceCount = 0
  let fallbackClones = 0
  let parcelCount = 0

  const pushLeaves = (leaves: PropMeshLeaf[], worldProp: THREE.Matrix4) => {
    for (const leaf of leaves) {
      let bucket = buckets.get(leaf.key)
      if (!bucket) {
        bucket = { leaf, matrices: [] }
        buckets.set(leaf.key, bucket)
      }
      finalMat.multiplyMatrices(worldProp, leaf.localMatrix)
      bucket.matrices.push(finalMat.clone())
      instanceCount++
    }
  }

  const pushColliders = async (
    meshName: string,
    worldProp: THREE.Matrix4,
    instanceKey: string
  ) => {
    const leaves = await loadPropColliderLeaves(meshName)
    if (!leaves.length) return
    // Shared geom fingerprint across instances → PhysX geometryToPxMesh cache hit.
    const shapes = leaves.map((c) => ({
      fingerprint: `road-col:${c.key}`,
      geometry: c.geometry,
      localMatrix: c.localMatrix.clone()
    }))
    const geomKey = shapes.map((s) => s.fingerprint).join('|')
    let entity = stableRoadColliderEntityId(instanceKey)
    // Extremely rare hash collision within one build — linear probe.
    while (usedColliderEntities.has(entity)) entity++
    usedColliderEntities.add(entity)
    colliders.push({
      entity,
      kind: 'gltf-multi',
      fingerprint: `road-aoi:v1-inst:${geomKey}`,
      matrix: worldProp.clone(),
      shapes
    })
  }

  // Preload assembly parts + Explorer companions (planter + flower strip).
  const neededMeshes = new Set<string>()
  for (const p of opts.placements) {
    const parts = assemblyPartsForModel(p.model)
    if (!parts) continue
    for (const part of parts) {
      neededMeshes.add(part.mesh)
      for (const extra of explorerCompanionMeshes(part.mesh)) neededMeshes.add(extra)
    }
  }
  await Promise.all(
    [...neededMeshes].map(async (m) => {
      await loadPropMeshLeaves(m)
      await loadPropColliderLeaves(m)
    })
  )

  for (const p of opts.placements) {
    const parts = assemblyPartsForModel(p.model)
    if (!parts?.length) {
      if (p.catalystHash) {
        const clone = await tryCatalystFallback(p, opts)
        if (clone) {
          fallbackRoot.add(clone)
          fallbackClones++
          parcelCount++
        }
      }
      continue
    }

    const sw = parcelSwSceneLocal(p.parcelKey, opts.primaryBase)
    const half = PARCEL_SIZE / 2
    dclToThreePos(sw.x + half, 0, sw.z + half, rootPos)
    dclToThreeQuat(p.rotation.x, p.rotation.y, p.rotation.z, p.rotation.w, rootQuat)
    rootMat.compose(rootPos, rootQuat, new THREE.Vector3(1, 1, 1))

    let placedAny = false
    for (const part of parts) {
      // Green/orange foliage variants (Explorer mixes both).
      const visualName = foliageVisualName(part.mesh, p.parcelKey)
      const leaves = await loadPropMeshLeaves(visualName)
      if (!leaves.length) continue

      const local = new THREE.Matrix4().fromArray(part.m)
      local.decompose(lp, lq, ls)
      // Unity/DCL → Three: flip X on position + quat conjugate
      partMat.compose(
        new THREE.Vector3(-lp.x, lp.y, lp.z),
        new THREE.Quaternion(-lq.x, lq.y, lq.z, -lq.w),
        ls
      )
      baseMat.multiplyMatrices(rootMat, partMat)
      pushLeaves(leaves, baseMat)
      await pushColliders(part.mesh, baseMat, `${p.parcelKey}|${part.mesh}`)
      placedAny = true

      // Explorer prefabs parent planter + flower strip under long hedges.
      for (const extra of explorerCompanionMeshes(part.mesh)) {
        const extraLeaves = await loadPropMeshLeaves(extra)
        if (extraLeaves.length) pushLeaves(extraLeaves, baseMat)
        await pushColliders(extra, baseMat, `${p.parcelKey}|${extra}`)
      }
    }

    if (placedAny) parcelCount++
  }

  for (const { leaf, matrices } of buckets.values()) {
    if (!matrices.length) continue
    const mesh = new THREE.InstancedMesh(leaf.geometry, leaf.material, matrices.length)
    mesh.name = `road-inst:${leaf.key}`
    // Roads dominate castSh (~hundreds of instanced leaves). Receive only — sun soft
    // shadow pass was ~3× submitTris on plaza with adaptive quality off.
    mesh.castShadow = false
    mesh.receiveShadow = true
    mesh.frustumCulled = true

    for (let i = 0; i < matrices.length; i++) {
      mesh.setMatrixAt(i, matrices[i]!)
    }
    mesh.instanceMatrix.needsUpdate = true
    mesh.computeBoundingSphere()
    root.add(mesh)
  }

  if (fallbackRoot.children.length) root.add(fallbackRoot)

  root.userData.roadParcels = parcelCount
  root.userData.roadInstances = instanceCount
  root.userData.roadDrawBuckets = buckets.size
  root.userData.roadColliders = colliders.length

  clientDebugLog.consoleOnly(
    'info',
    `[roads] instanced parcels=${parcelCount} instances=${instanceCount} draws=${buckets.size}` +
      ` colliders=${colliders.length}` +
      (fallbackClones ? ` catalystFallback=${fallbackClones}` : '')
  )

  return {
    root,
    parcelCount,
    instanceCount,
    drawBuckets: buckets.size,
    fallbackClones,
    colliders
  }
}

function hashParcelKey(key: string): number {
  let h = 2166136261
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

async function tryCatalystFallback(
  p: RoadTilePlacement,
  opts: { cache: AssetCache; contentBaseUrl: string; primaryBase: string }
): Promise<THREE.Object3D | null> {
  if (!p.catalystHash) return null
  try {
    const url = catalystContentAssetUrl(opts.contentBaseUrl, p.catalystHash)
    const { root: glb } = await opts.cache.load(url, p.catalystHash)
    const clone = glb.clone(true)
    clone.traverse((n) => {
      if (n instanceof THREE.Mesh && /collider/i.test(n.name)) n.visible = false
    })
    const sw = parcelSwSceneLocal(p.parcelKey, opts.primaryBase)
    const half = PARCEL_SIZE / 2
    const pos = new THREE.Vector3()
    const quat = new THREE.Quaternion()
    dclToThreePos(sw.x + half, 0, sw.z + half, pos)
    dclToThreeQuat(p.rotation.x, p.rotation.y, p.rotation.z, p.rotation.w, quat)
    const wrap = new THREE.Group()
    wrap.name = `aoi-road-catalyst:${p.parcelKey}`
    wrap.position.copy(pos)
    wrap.quaternion.copy(quat)
    wrap.add(clone)
    wrap.userData.roadSource = 'catalyst-glb-fallback'
    return wrap
  } catch {
    return null
  }
}

/**
 * @deprecated Prefer buildInstancedRoadLayer — kept for single-parcel debug.
 */
export async function buildRoadTileObject(opts: {
  cache: AssetCache
  contentBaseUrl: string
  placement: RoadTilePlacement
  primaryBase: string
}): Promise<THREE.Object3D | null> {
  const built = await buildInstancedRoadLayer({
    placements: [opts.placement],
    primaryBase: opts.primaryBase,
    cache: opts.cache,
    contentBaseUrl: opts.contentBaseUrl
  })
  return built.parcelCount > 0 || built.fallbackClones > 0 ? built.root : null
}

export type { PhysicsColliderDesc as RoadPhysicsColliderDesc } from '../../physics/PhysXWorld'

/**
 * Explorer RoadTilesAssembled companions not listed as separate assembly parts
 * but present as children on the Unity prefab.
 */
function explorerCompanionMeshes(meshName: string): string[] {
  // Unity RoadTilesAssembled parents planter + flower strip under long hedges.
  // HedgeBall has no separate pot mesh in RoadRedesign props (only long PotMiddleLarge /
  // tall PotTree — wrong shape); ball planters are part of Explorer scene variants.
  if (meshName === 'HedgeMiddleLarge') {
    return ['PotMiddleLarge', 'HedgeFlowersMiddleLarge']
  }
  return []
}

/** Color variants reuse base FBX with a different material. */
function fbxAssetName(meshName: string): string {
  if (meshName === 'HedgeBallOrange') return 'HedgeBall'
  if (meshName === 'HedgeMiddleLargeOrange') return 'HedgeMiddleLarge'
  return meshName
}

/** Pick green vs orange foliage variant (Explorer mixes both). */
function foliageVisualName(meshName: string, parcelKey: string): string {
  if (meshName === 'HedgeBall') {
    return hashParcelKey(parcelKey) % 2 === 1 ? 'HedgeBallOrange' : 'HedgeBall'
  }
  if (meshName === 'HedgeMiddleLarge') {
    // Slightly fewer orange long hedges than green.
    return hashParcelKey(parcelKey) % 5 === 0 ? 'HedgeMiddleLargeOrange' : 'HedgeMiddleLarge'
  }
  return meshName
}

async function loadPropMeshLeaves(meshName: string): Promise<PropMeshLeaf[]> {
  let p = propLeafCache.get(meshName)
  if (p) return p
  p = (async () => {
    const template = await loadPropFbx(meshName)
    if (!template) return []
    return collectPropMeshLeaves(template, meshName)
  })()
  propLeafCache.set(meshName, p)
  return p
}

async function loadPropColliderLeaves(meshName: string): Promise<PropColliderLeaf[]> {
  const asset = fbxAssetName(meshName)
  let p = propColliderCache.get(asset)
  if (p) return p
  p = (async () => {
    const template = await loadPropFbx(meshName)
    if (!template) return []
    return collectPropColliderLeaves(template, asset)
  })()
  propColliderCache.set(asset, p)
  return p
}

function collectPropMeshLeaves(root: THREE.Object3D, meshName: string): PropMeshLeaf[] {
  root.updateMatrixWorld(true)
  const rootInverse = new THREE.Matrix4().copy(root.matrixWorld).invert()
  const out: PropMeshLeaf[] = []
  let i = 0
  root.traverse((node) => {
    if (!(node instanceof THREE.Mesh) || !node.geometry) return
    if (/collider/i.test(node.name) || !node.visible) return
    const localMatrix = new THREE.Matrix4().multiplyMatrices(rootInverse, node.matrixWorld)
    const material = Array.isArray(node.material) ? node.material[0]! : node.material
    out.push({
      key: `${meshName}#${i++}:${node.name || 'mesh'}`,
      meshName,
      geometry: node.geometry,
      material,
      localMatrix
    })
  })
  return out
}

function collectPropColliderLeaves(root: THREE.Object3D, meshName: string): PropColliderLeaf[] {
  root.updateMatrixWorld(true)
  const rootInverse = new THREE.Matrix4().copy(root.matrixWorld).invert()
  const out: PropColliderLeaf[] = []
  let i = 0
  root.traverse((node) => {
    if (!(node instanceof THREE.Mesh) || !node.geometry) return
    if (!/collider/i.test(node.name)) return
    const pos = node.geometry.getAttribute('position')
    if (!pos || pos.count < 3) return
    const localMatrix = new THREE.Matrix4().multiplyMatrices(rootInverse, node.matrixWorld)
    out.push({
      key: `${meshName}#col${i++}:${node.name}`,
      meshName,
      geometry: node.geometry,
      localMatrix
    })
  })
  return out
}

/**
 * Keep only the highest-detail **render** mesh (LOD0).
 * Collider meshes stay in the graph (hidden) for PhysX extraction.
 */
function keepOnlyLod0(root: THREE.Object3D): void {
  const meshes: THREE.Mesh[] = []
  root.traverse((n) => {
    if (n instanceof THREE.Mesh) meshes.push(n)
  })
  if (!meshes.length) return

  const colliders = meshes.filter((m) => /collider/i.test(m.name))
  for (const m of colliders) m.visible = false

  const renderMeshes = meshes.filter((m) => !/collider/i.test(m.name))
  const hasLodNaming = renderMeshes.some((m) => /LOD\d/i.test(m.name))
  if (!hasLodNaming) return

  let keep = renderMeshes.filter((m) => /_?LOD0\b/i.test(m.name))
  if (!keep.length) {
    const ranked = renderMeshes
      .map((m) => {
        const hit = m.name.match(/LOD(\d)/i)
        return { m, lod: hit ? parseInt(hit[1]!, 10) : 99 }
      })
      .sort((a, b) => a.lod - b.lod)
    if (ranked[0]) keep = [ranked[0].m]
  }

  const keepSet = new Set(keep)
  for (const m of renderMeshes) {
    if (!keepSet.has(m)) {
      m.visible = false
      m.removeFromParent()
    }
  }
}

function loadPropFbx(meshName: string): Promise<THREE.Object3D | null> {
  // HedgeBallOrange shares FBX with HedgeBall but different material — separate template.
  let p = propTemplateCache.get(meshName)
  if (p) return p
  p = (async () => {
    const asset = fbxAssetName(meshName)
    const url = `/roads/props/${asset}.fbx`
    try {
      const obj = await fbxLoader.loadAsync(url)
      // Keep collider meshes (hidden); strip lower render LODs.
      keepOnlyLod0(obj)
      normalizePropTemplate(obj)
      // FBX embeds broken/black Phong materials (missing Windows texture paths).
      await applyExplorerRoadMaterial(obj, meshName)
      // Bake normalize into a clean template (includes hidden colliders).
      const g = new THREE.Group()
      g.name = `road-prop:${meshName}`
      g.add(obj)
      g.updateMatrixWorld(true)
      const baked = new THREE.Group()
      baked.name = g.name
      while (g.children.length) {
        const ch = g.children[0]!
        g.updateMatrixWorld(true)
        const mw = new THREE.Matrix4()
        mw.copy(ch.matrixWorld)
        g.remove(ch)
        ch.matrix.identity()
        ch.position.set(0, 0, 0)
        ch.quaternion.identity()
        ch.scale.set(1, 1, 1)
        ch.applyMatrix4(mw)
        baked.add(ch)
      }
      return baked
    } catch (err) {
      console.warn(`[roads] prop FBX failed ${meshName}`, err)
      return null
    }
  })()
  propTemplateCache.set(meshName, p)
  return p
}

/** Bump when material/LOD/collider pipeline changes so caches don't stick. */
const ROAD_TEX_VER = 'v5-leaf-atlas-col'

function loadRoadTexture(
  file: string,
  opts?: { colorSpace?: THREE.ColorSpace; flipY?: boolean }
): Promise<THREE.Texture | null> {
  const colorSpace = opts?.colorSpace ?? THREE.SRGBColorSpace
  // Keep flipY true — matches prior road atlas look (asphalt/sidewalk OK).
  const flipY = opts?.flipY ?? true
  const cacheKey = `${file}|cs=${colorSpace}|fy=${flipY ? 1 : 0}|${ROAD_TEX_VER}`
  let p = textureCache.get(cacheKey)
  if (p) return p
  p = new Promise((resolve) => {
    textureLoader.load(
      `/roads/props/${file}?${ROAD_TEX_VER}`,
      (tex) => {
        tex.colorSpace = colorSpace
        // Atlases tile; prop cards clamp so edges don't smear.
        const clamp = /Hedge|Flower|Leaf|Lamp|Bench|Pot/i.test(file)
        tex.wrapS = tex.wrapT = clamp
          ? THREE.ClampToEdgeWrapping
          : THREE.RepeatWrapping
        tex.flipY = flipY
        tex.needsUpdate = true
        resolve(tex)
      },
      undefined,
      () => {
        console.warn(`[roads] texture miss ${file}`)
        resolve(null)
      }
    )
  })
  textureCache.set(cacheKey, p)
  return p
}

async function getRoadMaterial(
  meshName: string,
  opts?: { role?: 'foliage' | 'flowers' | 'pot' | 'default' }
): Promise<THREE.MeshStandardMaterial> {
  const role = opts?.role ?? 'default'
  const cacheKey = `${meshName}:${role}:${ROAD_TEX_VER}`
  let p = materialCache.get(cacheKey)
  if (p) return p
  p = (async () => {
    const baseSpec = PROP_MATERIALS[meshName] ?? { color: 0x888888, roughness: 0.85 }
    const isFlowerMesh =
      role === 'flowers' || /flower/i.test(meshName)
    const isFoliageBody =
      !isFlowerMesh &&
      (role === 'foliage' || !!baseSpec.foliage || /hedge|leaf/i.test(meshName))

    // --- Explorer flower strip: pink/red blooms with alpha cutout ---
    if (isFlowerMesh) {
      const [map, normalMap] = await Promise.all([
        loadRoadTexture('HedgeFlower_color.png'),
        loadRoadTexture('HedgeFlower_normal.png', { colorSpace: THREE.NoColorSpace })
      ])
      return new THREE.MeshStandardMaterial({
        color: 0xffffff,
        map: map ?? undefined,
        normalMap: normalMap ?? undefined,
        roughness: 0.9,
        metalness: 0,
        side: THREE.DoubleSide,
        alphaTest: 0.35,
        transparent: false,
        depthWrite: true,
        // Vertex colors are a wind/mask channel — never multiply as RGB.
        vertexColors: false
      })
    }

    // --- Explorer hedge body: leaf atlas albedo × tint + alpha cutout cards ---
    if (isFoliageBody) {
      const leafFile = baseSpec.map ?? baseSpec.alphaMap ?? 'HedgeLeaf.png'
      const leaf = await loadRoadTexture(leafFile)
      // White RGB × body tint → green/orange leaves; alpha channel cuts cards.
      const bodyColor = baseSpec.color ?? 0x3f8f3a
      return new THREE.MeshStandardMaterial({
        color: new THREE.Color(bodyColor),
        map: leaf ?? undefined,
        alphaMap: leaf ?? undefined,
        roughness: baseSpec.roughness ?? 0.88,
        metalness: 0,
        side: THREE.DoubleSide,
        alphaTest: leaf ? 0.35 : 0,
        transparent: false,
        depthWrite: true,
        vertexColors: false
      })
    }

    const spec = role === 'pot' ? PROP_MATERIALS.PotMiddleLarge! : baseSpec
    const [map, normalMap, emissiveMap] = await Promise.all([
      spec.map ? loadRoadTexture(spec.map) : Promise.resolve(null),
      spec.normalMap
        ? loadRoadTexture(spec.normalMap, { colorSpace: THREE.NoColorSpace })
        : Promise.resolve(null),
      spec.emissiveMap ? loadRoadTexture(spec.emissiveMap) : Promise.resolve(null)
    ])
    const hasEmissive = !!emissiveMap
    return new THREE.MeshStandardMaterial({
      color: map ? 0xffffff : (spec.color ?? 0x888888),
      map: map ?? undefined,
      normalMap: normalMap ?? undefined,
      emissiveMap: emissiveMap ?? undefined,
      emissive: hasEmissive ? new THREE.Color(0xfff2d0) : new THREE.Color(0x000000),
      emissiveIntensity: hasEmissive ? 2.4 : 0,
      roughness: spec.roughness ?? 0.85,
      metalness: role === 'pot' ? 0.12 : hasEmissive ? 0.15 : 0.05,
      side: THREE.FrontSide,
      vertexColors: false
    })
  })()
  materialCache.set(cacheKey, p)
  return p
}

/** Replace FBX black/broken materials with Explorer RoadRedesign textures. */
async function applyExplorerRoadMaterial(
  root: THREE.Object3D,
  meshName: string
): Promise<void> {
  const isFlower = /flower/i.test(meshName)
  const isHedge = /hedge/i.test(meshName) && !isFlower
  const isPot = /pot/i.test(meshName)

  const mat = await getRoadMaterial(meshName, {
    role: isFlower ? 'flowers' : isHedge ? 'foliage' : isPot ? 'pot' : 'default'
  })

  root.traverse((node) => {
    if (!(node instanceof THREE.Mesh)) return
    if (/collider/i.test(node.name)) return
    const prev = node.material
    if (Array.isArray(prev)) {
      for (const m of prev) m.dispose?.()
    } else {
      prev?.dispose?.()
    }
    node.material = mat
    node.castShadow = false
    node.receiveShadow = true
  })
}

function normalizePropTemplate(root: THREE.Object3D): void {
  root.updateMatrixWorld(true)
  // Bounds from visible render meshes only (hidden colliders still scale with root).
  const box = new THREE.Box3()
  let hasVis = false
  root.traverse((n) => {
    if (n instanceof THREE.Mesh && n.visible && n.geometry) {
      box.expandByObject(n)
      hasVis = true
    }
  })
  if (!hasVis || box.isEmpty()) {
    box.setFromObject(root)
    if (box.isEmpty()) return
  }
  const size = new THREE.Vector3()
  box.getSize(size)
  const maxDim = Math.max(size.x, size.y, size.z)
  // cm-scale imports → meters
  if (maxDim > 80) {
    root.scale.multiplyScalar(0.01)
    root.updateMatrixWorld(true)
    box.makeEmpty()
    root.traverse((n) => {
      if (n instanceof THREE.Mesh && n.visible && n.geometry) box.expandByObject(n)
    })
    if (box.isEmpty()) box.setFromObject(root)
  } else if (maxDim > 0 && maxDim < 0.05) {
    root.scale.multiplyScalar(100)
    root.updateMatrixWorld(true)
    box.makeEmpty()
    root.traverse((n) => {
      if (n instanceof THREE.Mesh && n.visible && n.geometry) box.expandByObject(n)
    })
    if (box.isEmpty()) box.setFromObject(root)
  }
  // Feet on y=0 for prop; keep author XZ origin (instance matrix places it)
  const minY = box.min.y
  if (Number.isFinite(minY)) root.position.y -= minY
}

function findCatalystRoadGlb(
  ent: ActiveSceneEntity
): { file: string; hash: string } | null {
  const classic = ent.content.filter((c) => {
    const base = c.file.split('/').pop() ?? c.file
    return /^(OpenRoad_|OpenFork_|OpenCorner_|Road_|DeadEnd_|Fork_|Corner_|EmptyFork_)/i.test(
      base
    )
  })
  if (!classic.length) return null
  const fromTitle = ent.title.match(
    /(OpenRoad_\w+|OpenFork_\w+|OpenCorner_\w+|Road_\w+|DeadEnd_\w+|Fork_\w+|Corner_\w+|EmptyFork_\w+)/i
  )
  if (fromTitle) {
    const want = `${fromTitle[1]}.glb`.toLowerCase()
    const hit = classic.find((c) => (c.file.split('/').pop() ?? '').toLowerCase() === want)
    if (hit) return hit
  }
  return classic[0]!
}

export function extractRoadModelFromTitle(title: string): string | null {
  const m = title.match(
    /(OpenRoad_\w+|OpenFork_\w+|OpenCorner_\w+|Road_\w+|DeadEnd_\w+|Fork_\w+|Corner_\w+|EmptyFork_\w+)/i
  )
  return m?.[1] ?? null
}

export function findRoadGlbFile(
  ent: ActiveSceneEntity
): { file: string; hash: string } | null {
  return findCatalystRoadGlb(ent)
}

export function sdk6RoadAngle(rotationDeg: number): number {
  const d = ((Math.round(rotationDeg) % 360) + 360) % 360
  return (d * Math.PI) / 180 / 2
}
