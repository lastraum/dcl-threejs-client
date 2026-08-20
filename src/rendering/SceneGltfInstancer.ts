import * as THREE from 'three'
import type { Entity } from '@dcl/ecs'
import {
  isGltfInvisibleColliderMesh,
  isGltfInvisibleColliderName,
  isGltfVisibleClassMesh
} from '../collision/gltfColliderNaming'
import type { PhysicsColliderShapeDesc } from '../physics/PhysXWorld'
import { setMeshDesiredCastShadow } from './shadowCastPolicy'

/**
 * GPU instancing for scene GltfContainers that share a content hash.
 * Static (non-skinned) templates only — skinned / Animator entities stay on SkeletonUtils.clone.
 *
 * Dual path for colliders: render leaves go to InstancedMesh; `_collider` shapes are collected
 * once from the template (entity-local matrices) and stored on the entity so PhysX can place a
 * unique actor per instance without cloning the full GLB.
 *
 * GltfNodeModifiers: ThreeBridge.promoteInstancedGltfForModifiers detaches + re-clones
 * so material/shadow overrides never mutate sibling instances.
 */

export type InstancerMeshLeaf = {
  geometry: THREE.BufferGeometry
  material: THREE.Material | THREE.Material[]
  localMatrix: THREE.Matrix4
}

/** Template collider leaf — entity-local pose; actor world pose is entity.matrixWorld. */
export type InstanceColliderShape = PhysicsColliderShapeDesc & {
  /** Matches GltfColliderExtractor inv/vis filter. */
  kind: 'inv' | 'vis' | 'unnamed'
}

export const INSTANCE_COLLIDER_SHAPES_KEY = 'dclInstanceColliderShapes'

/** Pose graph hide: instance slots do not inherit Object3D.visible from ancestors. */
function poseAncestryVisible(obj: THREE.Object3D): boolean {
  let p: THREE.Object3D | null = obj.parent
  while (p) {
    if (!p.visible) return false
    p = p.parent
  }
  return true
}

type Bucket = {
  hash: string
  leaves: InstancerMeshLeaf[]
  /** Shared collider template for all entities in this bucket. */
  colliderShapes: InstanceColliderShape[]
  meshes: THREE.InstancedMesh[]
  /** entity → slot index */
  entityIndex: Map<Entity, number>
  /** free slot indices for reuse */
  free: number[]
  capacity: number
  /** high-water used slots (not compact) */
  used: number
  root: THREE.Group
  /** Per-instance RGB tint enabled (Material / scalar GltfNodeModifiers on boards). */
  instanceColorsReady: boolean
}

const _entityWorld = new THREE.Matrix4()
const _instance = new THREE.Matrix4()
const _shapeLocal = new THREE.Matrix4()
const _color = new THREE.Color()
const _boundBox = new THREE.Box3()
const _leafBox = new THREE.Box3()
const _boundSphere = new THREE.Sphere()

function geometryHasMorphTargets(geometry: THREE.BufferGeometry | undefined): boolean {
  if (!geometry?.morphAttributes) return false
  const ma = geometry.morphAttributes
  return !!(ma.position?.length || ma.normal?.length || ma.color?.length)
}

/**
 * InstancedMesh is for repeated low-leaf props (chairs, pipes). Multi-mesh
 * environment kits share one hash but one entity — GPU slots + combined leaf
 * bounds vanish the only copy (Object3D.visible does not hide InstancedMesh).
 */
export const MAX_INSTANCER_LEAVES = 12

export function templateIsInstancable(root: THREE.Object3D): boolean {
  let hasRenderMesh = false
  let hasSkinned = false
  let hasMorph = false
  let leaves = 0
  root.traverse((node) => {
    if (!(node as THREE.Mesh).isMesh) return
    if ((node as THREE.SkinnedMesh).isSkinnedMesh) {
      hasSkinned = true
      return
    }
    if (isGltfInvisibleColliderName(node.name)) return
    const mesh = node as THREE.Mesh
    if (geometryHasMorphTargets(mesh.geometry)) {
      hasMorph = true
      return
    }
    const pos = mesh.geometry?.getAttribute('position')
    if (pos && pos.count >= 3) {
      hasRenderMesh = true
      leaves++
    }
  })
  // Morph targets need per-instance morphTargetInfluences + AnimationMixer (weights tracks).
  // InstancedMesh shares geometry with morphAttributes but no influences → WebGL crash
  // (objectInfluences.length on undefined) — Dead Surge arrow.glb / blinking path arrows.
  return hasRenderMesh && !hasSkinned && !hasMorph && leaves <= MAX_INSTANCER_LEAVES
}

/**
 * Collect `_collider` / visible-physics leaves once per content hash (entity-local matrices).
 * PhysX places one actor per instance using these shapes + that entity's matrixWorld.
 */
export function collectTemplateColliderShapes(
  root: THREE.Object3D,
  contentHash: string
): InstanceColliderShape[] {
  const out: InstanceColliderShape[] = []
  root.updateMatrixWorld(true)
  const rootInv = new THREE.Matrix4().copy(root.matrixWorld).invert()

  root.traverse((node) => {
    if (!(node instanceof THREE.Mesh)) return
    if ((node as THREE.SkinnedMesh).isSkinnedMesh) return

    // Ancestry-first (Explorer): `_collider` group children are inv even without leaf `_collider` name.
    let kind: InstanceColliderShape['kind'] | null = null
    if (isGltfInvisibleColliderMesh(node, root)) kind = 'inv'
    else if (isGltfVisibleClassMesh(node, root)) kind = 'vis'
    else if (node.name.length === 0) kind = 'unnamed'
    else return

    const sourceGeo = node.geometry
    const posAttr = sourceGeo?.getAttribute('position')
    if (!posAttr || posAttr.count < 3) return

    node.updateMatrixWorld(true)
    _shapeLocal.copy(node.matrixWorld).premultiply(rootInv)
    out.push({
      fingerprint: `gltf:${kind}:inst:${contentHash}:${out.length}:${node.name}:${sourceGeo.uuid}`,
      geometry: sourceGeo,
      localMatrix: _shapeLocal.clone(),
      kind
    })
  })
  return out
}

/** Collect render mesh leaves (shared geometry/materials) relative to template root. */
export function collectInstancerLeaves(root: THREE.Object3D): InstancerMeshLeaf[] {
  const out: InstancerMeshLeaf[] = []
  root.updateMatrixWorld(true)
  const rootInv = new THREE.Matrix4().copy(root.matrixWorld).invert()

  root.traverse((node) => {
    if (!(node as THREE.Mesh).isMesh) return
    if ((node as THREE.SkinnedMesh).isSkinnedMesh) return
    if (isGltfInvisibleColliderName(node.name)) return
    const mesh = node as THREE.Mesh
    if (!mesh.geometry) return
    const pos = mesh.geometry.getAttribute('position')
    if (!pos || pos.count < 3) return
    const localMatrix = new THREE.Matrix4().multiplyMatrices(rootInv, mesh.matrixWorld)
    out.push({
      geometry: mesh.geometry,
      material: mesh.material,
      localMatrix
    })
  })
  return out
}

export class SceneGltfInstancer {
  private readonly buckets = new Map<string, Bucket>()
  private readonly entityHash = new Map<Entity, string>()

  constructor(private readonly getHostRoot: () => THREE.Object3D) {}

  has(entity: Entity): boolean {
    return this.entityHash.has(entity)
  }

  /** All entities currently in a GPU instance bucket. */
  entities(): Iterable<Entity> {
    return this.entityHash.keys()
  }

  stats(): { buckets: number; instances: number; draws: number } {
    let draws = 0
    for (const b of this.buckets.values()) draws += b.meshes.length
    return { buckets: this.buckets.size, instances: this.entityHash.size, draws }
  }

  /**
   * Register entity as an instance of `hash`. Writes marker under entityObj for mesh identity.
   * Returns triangle count attributed once per hash leaf * (not × instance count for inventory).
   */
  attach(
    entity: Entity,
    entityObj: THREE.Group,
    hash: string,
    templateRoot: THREE.Object3D,
    meshKey: string
  ): { ok: boolean; templateTris: number } {
    if (this.entityHash.has(entity)) {
      this.update(entity, entityObj)
      return { ok: true, templateTris: 0 }
    }

    let bucket = this.buckets.get(hash)
    if (!bucket) {
      const leaves = collectInstancerLeaves(templateRoot)
      if (!leaves.length) return { ok: false, templateTris: 0 }
      const colliderShapes = collectTemplateColliderShapes(templateRoot, hash)
      bucket = this.createBucket(hash, leaves, colliderShapes)
      this.buckets.set(hash, bucket)
    }

    const index = this.allocIndex(bucket)
    bucket.entityIndex.set(entity, index)
    this.entityHash.set(entity, hash)

    // Marker so ThreeBridge treats entity as attached (no geometry under entity).
    const marker = new THREE.Group()
    marker.name = meshKey
    marker.userData.dclInstanceMarker = true
    entityObj.add(marker)
    entityObj.userData.dclInstanced = true
    entityObj.userData.gltfSrcKey = hash
    // Shared template colliders — PhysX places one actor per entity at matrixWorld.
    entityObj.userData[INSTANCE_COLLIDER_SHAPES_KEY] = bucket.colliderShapes

    this.writeMatrix(bucket, index, entityObj)
    this.refreshBucketBounds(bucket)

    let templateTris = 0
    for (const leaf of bucket.leaves) {
      const idx = leaf.geometry.index
      if (idx) templateTris += idx.count / 3
      else {
        const pos = leaf.geometry.getAttribute('position')
        if (pos) templateTris += pos.count / 3
      }
    }
    entityObj.userData.dclAttachedTris = 0
    entityObj.userData.dclInstanceTemplateTris = templateTris

    return { ok: true, templateTris }
  }

  update(entity: Entity, entityObj: THREE.Group): void {
    const hash = this.entityHash.get(entity)
    if (!hash) return
    const bucket = this.buckets.get(hash)
    if (!bucket) return
    const index = bucket.entityIndex.get(entity)
    if (index === undefined) return
    this.writeMatrix(bucket, index, entityObj)
  }

  /** Extract: instance matrix from a world matrix (billboard) — pose quat untouched. */
  writeWorldMatrix(entity: Entity, world: THREE.Matrix4): boolean {
    const hash = this.entityHash.get(entity)
    if (!hash) return false
    const bucket = this.buckets.get(hash)
    if (!bucket) return false
    const index = bucket.entityIndex.get(entity)
    if (index === undefined) return false
    for (let i = 0; i < bucket.meshes.length; i++) {
      const leaf = bucket.leaves[i]!
      const mesh = bucket.meshes[i]!
      mesh.updateWorldMatrix(true, false)
      _instance.copy(mesh.matrixWorld).invert().multiply(world).multiply(leaf.localMatrix)
      mesh.setMatrixAt(index, _instance)
      mesh.instanceMatrix.needsUpdate = true
    }
    return true
  }

  /**
   * Refresh instance matrices after Transform apply.
   * InstancedMesh stores **world** matrices — when a parent moves, every instanced
   * descendant must rewrite even if that child entity was not in the CRDT diff
   * (common during hydration parent reparent / plaza group moves).
   */
  updateEntities(entities: Iterable<Entity>, nodes: Map<Entity, THREE.Group>): void {
    const dirtyNodes = new Set<THREE.Object3D>()
    for (const entity of entities) {
      const obj = nodes.get(entity)
      if (obj) dirtyNodes.add(obj)
    }
    if (dirtyNodes.size === 0) return

    const refreshed = new Set<Entity>()
    for (const entity of entities) {
      if (!this.entityHash.has(entity)) continue
      const obj = nodes.get(entity)
      if (!obj) continue
      this.update(entity, obj)
      refreshed.add(entity)
    }

    // Descendants of dirty parents (world matrix inherited — not in CRDT upsert list).
    for (const entity of this.entityHash.keys()) {
      if (refreshed.has(entity)) continue
      const obj = nodes.get(entity)
      if (!obj) continue
      let p: THREE.Object3D | null = obj.parent
      while (p) {
        if (dirtyNodes.has(p)) {
          this.update(entity, obj)
          refreshed.add(entity)
          break
        }
        p = p.parent
      }
    }

    const hashes = new Set<string>()
    for (const entity of refreshed) {
      const h = this.entityHash.get(entity)
      if (h) hashes.add(h)
    }
    for (const h of hashes) {
      const b = this.buckets.get(h)
      if (b) this.refreshBucketBounds(b)
    }
  }

  /** Full rewrite — call after hydration seal / large hierarchy rebuild. */
  updateAll(nodes: Map<Entity, THREE.Group>): void {
    for (const entity of this.entityHash.keys()) {
      const obj = nodes.get(entity)
      if (obj) this.update(entity, obj)
    }
    for (const bucket of this.buckets.values()) this.refreshBucketBounds(bucket)
  }

  detach(entity: Entity, entityObj?: THREE.Group): void {
    if (entityObj) {
      delete entityObj.userData.dclInstanced
      delete entityObj.userData[INSTANCE_COLLIDER_SHAPES_KEY]
      // Remove empty instance marker so __mesh_* can be rebuilt as a real clone.
      // Leaving the marker made getObjectByName prefer an empty Group → 0 colliders.
      const doomed: THREE.Object3D[] = []
      for (const child of entityObj.children) {
        if (child.userData.dclInstanceMarker || child.name.startsWith('__mesh_')) {
          doomed.push(child)
        }
      }
      for (const child of doomed) {
        entityObj.remove(child)
        // Marker is an empty Group — no shared geometry/materials to dispose.
      }
    }
    const hash = this.entityHash.get(entity)
    if (!hash) return
    const bucket = this.buckets.get(hash)
    this.entityHash.delete(entity)
    if (!bucket) return
    const index = bucket.entityIndex.get(entity)
    if (index === undefined) return
    bucket.entityIndex.delete(entity)
    bucket.free.push(index)
    // Hide free slot (zero scale)
    _instance.makeScale(0, 0, 0)
    for (const mesh of bucket.meshes) {
      mesh.setMatrixAt(index, _instance)
      mesh.instanceMatrix.needsUpdate = true
    }
    if (bucket.entityIndex.size === 0) {
      this.disposeBucket(hash)
    } else {
      this.refreshBucketBounds(bucket)
    }
  }

  /** Content hash for an instanced entity (if any). */
  getEntityHash(entity: Entity): string | undefined {
    return this.entityHash.get(entity)
  }

  /**
   * Per-instance albedo tint (pixelwars tile boards, land flippers).
   * Scalar Material / color-only GltfNodeModifiers use this — do not promote to private clone.
   * Multiplies mesh material.color (whitened once when colors are first used).
   */
  setInstanceColor(entity: Entity, r: number, g: number, b: number): boolean {
    const hash = this.entityHash.get(entity)
    if (!hash) return false
    const bucket = this.buckets.get(hash)
    if (!bucket) return false
    const index = bucket.entityIndex.get(entity)
    if (index === undefined) return false

    this.ensureInstanceColors(bucket)
    _color.setRGB(r, g, b)
    for (const mesh of bucket.meshes) {
      mesh.setColorAt(index, _color)
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
    }
    return true
  }

  /** Map InstancedMesh + instanceId → entity (pointer raycast). */
  entityFromInstanceHit(mesh: THREE.Object3D, instanceId: number): Entity | null {
    for (const bucket of this.buckets.values()) {
      for (const im of bucket.meshes) {
        if (im !== mesh) continue
        for (const [entity, index] of bucket.entityIndex) {
          if (index === instanceId) return entity
        }
        return null
      }
    }
    return null
  }

  /** All InstancedMeshes (PE raycast targets). */
  getAllInstanceMeshes(): THREE.InstancedMesh[] {
    const out: THREE.InstancedMesh[] = []
    for (const bucket of this.buckets.values()) out.push(...bucket.meshes)
    return out
  }

  /** InstancedMeshes that actually host these entities (never the full board). */
  meshesForEntities(entities: Iterable<Entity>): THREE.InstancedMesh[] {
    const seen = new Set<THREE.InstancedMesh>()
    for (const entity of entities) {
      const hash = this.entityHash.get(entity)
      if (!hash) continue
      const bucket = this.buckets.get(hash)
      if (!bucket) continue
      for (const mesh of bucket.meshes) seen.add(mesh)
    }
    return [...seen]
  }

  dispose(): void {
    for (const hash of [...this.buckets.keys()]) this.disposeBucket(hash)
    this.entityHash.clear()
  }

  /**
   * Lazy-enable instanceColor buffers. Whitens leaf materials so tint is the ECS albedo
   * (otherwise template gray × tint looks muddy).
   */
  private ensureInstanceColors(bucket: Bucket): void {
    if (bucket.instanceColorsReady) return
    bucket.instanceColorsReady = true
    for (const mesh of bucket.meshes) {
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
      for (const m of mats) {
        if (m && 'color' in m && (m as THREE.MeshStandardMaterial).color) {
          ;(m as THREE.MeshStandardMaterial).color.setRGB(1, 1, 1)
        }
      }
      for (let s = 0; s < bucket.capacity; s++) {
        mesh.setColorAt(s, _color.setRGB(1, 1, 1))
      }
      if (mesh.instanceColor) {
        mesh.instanceColor.setUsage(THREE.DynamicDrawUsage)
        mesh.instanceColor.needsUpdate = true
      }
    }
  }

  private createBucket(
    hash: string,
    leaves: InstancerMeshLeaf[],
    colliderShapes: InstanceColliderShape[]
  ): Bucket {
    const capacity = 32
    const root = new THREE.Group()
    root.name = `gltf-instances:${hash.slice(0, 16)}`
    root.userData.dclGltfInstanceBucket = hash
    this.getHostRoot().add(root)

    const meshes: THREE.InstancedMesh[] = []
    for (let i = 0; i < leaves.length; i++) {
      const leaf = leaves[i]!
      // Clone materials so whitening for instanceColor never mutates the AssetCache template.
      const mat = Array.isArray(leaf.material)
        ? leaf.material.map((m) => m.clone())
        : leaf.material.clone()
      const mesh = new THREE.InstancedMesh(leaf.geometry, mat, capacity)
      mesh.name = `inst:${i}`
      mesh.count = 0
      // Ultra only (gltfDefaultCaster): high/medium stay receive-only so plaza instancing
      // does not fill the sun map. Private clones + Material still use their own cast path.
      setMeshDesiredCastShadow(mesh, true, 'environment', { gltfDefaultCaster: true })
      mesh.receiveShadow = true
      // Mesh-local sphere is filled by refreshBucketBounds after the first write.
      // Do not use a world-space AABB here — Three applies matrixWorld on top.
      mesh.frustumCulled = true
      mesh.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 0)
      // Zero all slots initially
      _instance.makeScale(0, 0, 0)
      for (let s = 0; s < capacity; s++) mesh.setMatrixAt(s, _instance)
      mesh.instanceMatrix.needsUpdate = true
      root.add(mesh)
      meshes.push(mesh)
    }

    return {
      hash,
      leaves,
      colliderShapes,
      meshes,
      entityIndex: new Map(),
      free: [],
      capacity,
      used: 0,
      root,
      instanceColorsReady: false
    }
  }

  private allocIndex(bucket: Bucket): number {
    if (bucket.free.length) {
      const index = bucket.free.pop()!
      this.ensureCount(bucket, index + 1)
      return index
    }
    if (bucket.used >= bucket.capacity) this.growBucket(bucket)
    const index = bucket.used++
    this.ensureCount(bucket, bucket.used)
    return index
  }

  private ensureCount(bucket: Bucket, minCount: number): void {
    for (const mesh of bucket.meshes) {
      if (mesh.count < minCount) {
        mesh.count = Math.min(minCount, bucket.capacity)
        mesh.instanceMatrix.needsUpdate = true
      }
    }
  }

  private growBucket(bucket: Bucket): void {
    const nextCap = bucket.capacity * 2
    const newMeshes: THREE.InstancedMesh[] = []
    for (let i = 0; i < bucket.leaves.length; i++) {
      const leaf = bucket.leaves[i]!
      const old = bucket.meshes[i]!
      // Keep the (possibly whitened) material already on the old mesh.
      const mesh = new THREE.InstancedMesh(leaf.geometry, old.material, nextCap)
      mesh.name = old.name
      mesh.count = bucket.used
      setMeshDesiredCastShadow(mesh, true, 'environment', { gltfDefaultCaster: true })
      mesh.receiveShadow = true
      mesh.frustumCulled = true
      mesh.boundingSphere = old.boundingSphere?.clone() ?? new THREE.Sphere(new THREE.Vector3(0, 0, 0), 0)
      _instance.makeScale(0, 0, 0)
      for (let s = 0; s < nextCap; s++) {
        if (s < bucket.capacity) {
          old.getMatrixAt(s, _instance)
          mesh.setMatrixAt(s, _instance)
        } else {
          _instance.makeScale(0, 0, 0)
          mesh.setMatrixAt(s, _instance)
        }
      }
      if (bucket.instanceColorsReady) {
        for (let s = 0; s < nextCap; s++) {
          if (s < bucket.capacity && old.instanceColor) {
            old.getColorAt(s, _color)
            mesh.setColorAt(s, _color)
          } else {
            mesh.setColorAt(s, _color.setRGB(1, 1, 1))
          }
        }
        if (mesh.instanceColor) {
          mesh.instanceColor.setUsage(THREE.DynamicDrawUsage)
          mesh.instanceColor.needsUpdate = true
        }
      }
      mesh.instanceMatrix.needsUpdate = true
      bucket.root.add(mesh)
      old.removeFromParent()
      old.dispose()
      newMeshes.push(mesh)
    }
    bucket.meshes = newMeshes
    bucket.capacity = nextCap
    this.refreshBucketBounds(bucket)
  }

  /**
   * Mesh-local bounding sphere per leaf — Three.js copies this and applies matrixWorld.
   *
   * Previous world-space AABB from mesh[0] translations double-transformed (or missed
   * other leaves' local offsets) and culled plaza Building_*.glb slots. Each leaf has
   * its own instance matrices (entity × leaf.localMatrix, then meshWorld⁻¹).
   */
  private refreshBucketBounds(bucket: Bucket): void {
    for (let i = 0; i < bucket.meshes.length; i++) {
      const mesh = bucket.meshes[i]!
      const geo = mesh.geometry
      if (!geo.boundingBox) geo.computeBoundingBox()
      const srcBox = geo.boundingBox
      if (!srcBox) {
        mesh.frustumCulled = false
        continue
      }
      _boundBox.makeEmpty()
      let any = false
      for (const index of bucket.entityIndex.values()) {
        mesh.getMatrixAt(index, _instance)
        const te = _instance.elements
        // Hidden slots are zero-scale at origin — including them inflates the sphere
        // to (0,0,0) and either never-culls or culls the real cluster.
        if (te[0] === 0 && te[5] === 0 && te[10] === 0) continue
        _leafBox.copy(srcBox).applyMatrix4(_instance)
        _boundBox.union(_leafBox)
        any = true
      }
      if (!mesh.boundingSphere) mesh.boundingSphere = new THREE.Sphere()
      if (!any) {
        mesh.boundingSphere.center.set(0, 0, 0)
        mesh.boundingSphere.radius = 0
      } else {
        _boundBox.getBoundingSphere(_boundSphere)
        mesh.boundingSphere.copy(_boundSphere)
        mesh.boundingSphere.radius += 2
      }
      mesh.frustumCulled = true
    }
  }

  private writeMatrix(bucket: Bucket, index: number, entityObj: THREE.Group): void {
    // InstancedMesh lives under drawRoot, not the pose group — Object3D.visible on
    // this entity or any ancestor does not hide the GPU slot by itself.
    if (!entityObj.visible || !poseAncestryVisible(entityObj)) {
      _instance.makeScale(0, 0, 0)
      for (const mesh of bucket.meshes) {
        mesh.setMatrixAt(index, _instance)
        mesh.instanceMatrix.needsUpdate = true
      }
      return
    }
    // Ancestors only — writeMatrix often runs before poseRoot.flush. force=false
    // left instance matrices at identity / last-frame parent (giant plaza banners).
    entityObj.updateMatrix()
    entityObj.updateWorldMatrix(true, false)
    _entityWorld.copy(entityObj.matrixWorld)
    for (let i = 0; i < bucket.meshes.length; i++) {
      const leaf = bucket.leaves[i]!
      const mesh = bucket.meshes[i]!
      // InstancedMesh multiplies instanceMatrix by its own matrixWorld — write
      // instance-local matrices (identity host → same as world * leaf).
      mesh.updateWorldMatrix(true, false)
      _instance.copy(mesh.matrixWorld).invert()
      _instance.multiply(_entityWorld).multiply(leaf.localMatrix)
      mesh.setMatrixAt(index, _instance)
      mesh.instanceMatrix.needsUpdate = true
      // Do NOT computeBoundingSphere per write — O(instances×leaves) on boards and
      // starved Material/instanceColor apply while walking (flips only catch up when idle).
    }
  }

  private disposeBucket(hash: string): void {
    const bucket = this.buckets.get(hash)
    if (!bucket) return
    for (const mesh of bucket.meshes) {
      mesh.removeFromParent()
      mesh.dispose()
    }
    bucket.root.removeFromParent()
    this.buckets.delete(hash)
  }
}
