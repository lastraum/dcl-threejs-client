import * as THREE from 'three'
import type { Entity } from '@dcl/ecs'
import { isGltfInvisibleColliderName } from '../collision/gltfColliderNaming'

/**
 * GPU instancing for scene GltfContainers that share a content hash.
 * Static (non-skinned) templates only — skinned / Animator entities stay on SkeletonUtils.clone.
 *
 * GltfNodeModifiers (future): promote instance → private clone on first modifier write
 * so edits never mutate sibling instances.
 */

export type InstancerMeshLeaf = {
  geometry: THREE.BufferGeometry
  material: THREE.Material | THREE.Material[]
  localMatrix: THREE.Matrix4
}

type Bucket = {
  hash: string
  leaves: InstancerMeshLeaf[]
  meshes: THREE.InstancedMesh[]
  /** entity → slot index */
  entityIndex: Map<Entity, number>
  /** free slot indices for reuse */
  free: number[]
  capacity: number
  /** high-water used slots (not compact) */
  used: number
  root: THREE.Group
}

const _entityWorld = new THREE.Matrix4()
const _instance = new THREE.Matrix4()

export function templateIsInstancable(root: THREE.Object3D): boolean {
  let hasRenderMesh = false
  let hasSkinned = false
  root.traverse((node) => {
    if (!(node as THREE.Mesh).isMesh) return
    if ((node as THREE.SkinnedMesh).isSkinnedMesh) {
      hasSkinned = true
      return
    }
    if (isGltfInvisibleColliderName(node.name)) return
    const mesh = node as THREE.Mesh
    const pos = mesh.geometry?.getAttribute('position')
    if (pos && pos.count >= 3) hasRenderMesh = true
  })
  return hasRenderMesh && !hasSkinned
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
      bucket = this.createBucket(hash, leaves)
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

    this.writeMatrix(bucket, index, entityObj)

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

  /** Refresh instance matrices for a set of entities (after transform apply). */
  updateEntities(entities: Iterable<Entity>, nodes: Map<Entity, THREE.Group>): void {
    for (const entity of entities) {
      if (!this.entityHash.has(entity)) continue
      const obj = nodes.get(entity)
      if (obj) this.update(entity, obj)
    }
  }

  detach(entity: Entity): void {
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
    }
  }

  dispose(): void {
    for (const hash of [...this.buckets.keys()]) this.disposeBucket(hash)
    this.entityHash.clear()
  }

  private createBucket(hash: string, leaves: InstancerMeshLeaf[]): Bucket {
    const capacity = 32
    const root = new THREE.Group()
    root.name = `gltf-instances:${hash.slice(0, 16)}`
    root.userData.dclGltfInstanceBucket = hash
    this.getHostRoot().add(root)

    const meshes: THREE.InstancedMesh[] = []
    for (let i = 0; i < leaves.length; i++) {
      const leaf = leaves[i]!
      const mesh = new THREE.InstancedMesh(leaf.geometry, leaf.material, capacity)
      mesh.name = `inst:${i}`
      mesh.count = 0
      mesh.castShadow = false
      mesh.receiveShadow = true
      mesh.frustumCulled = true
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
      meshes,
      entityIndex: new Map(),
      free: [],
      capacity,
      used: 0,
      root
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
      const mesh = new THREE.InstancedMesh(leaf.geometry, leaf.material, nextCap)
      mesh.name = old.name
      mesh.count = bucket.used
      mesh.castShadow = old.castShadow
      mesh.receiveShadow = old.receiveShadow
      mesh.frustumCulled = true
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
      mesh.instanceMatrix.needsUpdate = true
      bucket.root.add(mesh)
      old.removeFromParent()
      old.dispose()
      newMeshes.push(mesh)
    }
    bucket.meshes = newMeshes
    bucket.capacity = nextCap
  }

  private writeMatrix(bucket: Bucket, index: number, entityObj: THREE.Group): void {
    entityObj.updateMatrixWorld(true)
    _entityWorld.copy(entityObj.matrixWorld)
    for (let i = 0; i < bucket.meshes.length; i++) {
      const leaf = bucket.leaves[i]!
      const mesh = bucket.meshes[i]!
      _instance.multiplyMatrices(_entityWorld, leaf.localMatrix)
      mesh.setMatrixAt(index, _instance)
      mesh.instanceMatrix.needsUpdate = true
      mesh.computeBoundingSphere()
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
