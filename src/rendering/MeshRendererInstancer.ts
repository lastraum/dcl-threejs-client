import * as THREE from 'three'
import type { Entity } from '@dcl/ecs'
import { releasePrimitiveGeometry } from '../bridge/primitiveShapes'

/**
 * GPU instancing for dense MeshRenderer boards (land tiles, grids).
 * Bucket = shared geometry + shared material (or instanceColor palette).
 * Entity host keeps a marker Group named like private meshes (`__mesh_${id}`).
 *
 * Eligibility is decided by ThreeBridge (component checklist) — this class only manages GPU slots.
 */

export const MESH_RENDERER_INSTANCE_MARKER = 'dclMeshRendererInstance'
export const MESH_RENDERER_INSTANCE_BUCKET_KEY = 'dclMeshRendererBucket'

type Bucket = {
  key: string
  geometry: THREE.BufferGeometry
  material: THREE.Material
  mesh: THREE.InstancedMesh
  entityIndex: Map<Entity, number>
  free: number[]
  capacity: number
  used: number
  /** Optional per-instance color (land recolors without rebucket). */
  useInstanceColor: boolean
  root: THREE.Group
}

const _mat = new THREE.Matrix4()
const _color = new THREE.Color()

const INITIAL_CAP = 64

export class MeshRendererInstancer {
  private readonly buckets = new Map<string, Bucket>()
  private readonly entityBucket = new Map<Entity, string>()
  private diagLogged = false

  constructor(private readonly getHostRoot: () => THREE.Object3D) {}

  /** Bucket count + total live instances (debug HUD / console). */
  stats(): { buckets: number; instances: number } {
    let instances = 0
    for (const b of this.buckets.values()) instances += b.entityIndex.size
    return { buckets: this.buckets.size, instances }
  }

  has(entity: Entity): boolean {
    return this.entityBucket.has(entity)
  }

  bucketKey(entity: Entity): string | undefined {
    return this.entityBucket.get(entity)
  }

  /**
   * Register entity as an instance.
   * Prefer **color-in-bucket** (material.color) — reliable. Optional instanceColor for same-bucket recolor.
   * If entity is already in a *different* bucket, returns false (caller must detach first).
   */
  attach(
    entity: Entity,
    entityObj: THREE.Group,
    bucketKey: string,
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
    meshKey: string,
    opts?: { color?: { r: number; g: number; b: number }; useInstanceColor?: boolean }
  ): boolean {
    const existingKey = this.entityBucket.get(entity)
    if (existingKey) {
      if (existingKey !== bucketKey) return false
      this.update(entity, entityObj)
      if (opts?.color && opts.useInstanceColor) {
        this.setInstanceColor(entity, opts.color.r, opts.color.g, opts.color.b)
      }
      return true
    }

    const useInstanceColor = opts?.useInstanceColor === true
    let bucket = this.buckets.get(bucketKey)
    if (!bucket) {
      bucket = this.createBucket(bucketKey, geometry, material, useInstanceColor)
      this.buckets.set(bucketKey, bucket)
    }

    const index = this.allocIndex(bucket)
    bucket.entityIndex.set(entity, index)
    this.entityBucket.set(entity, bucketKey)

    const marker = new THREE.Group()
    marker.name = meshKey
    marker.userData[MESH_RENDERER_INSTANCE_MARKER] = true
    marker.userData.dclInstanceMarker = true
    entityObj.add(marker)
    entityObj.userData.dclMeshRendererInstanced = true
    entityObj.userData[MESH_RENDERER_INSTANCE_BUCKET_KEY] = bucketKey

    this.writeMatrix(bucket, index, entityObj)
    if (opts?.color && bucket.useInstanceColor) {
      _color.setRGB(opts.color.r, opts.color.g, opts.color.b)
      bucket.mesh.setColorAt(index, _color)
      if (bucket.mesh.instanceColor) bucket.mesh.instanceColor.needsUpdate = true
    }
    if (!this.diagLogged && this.entityBucket.size >= 32) {
      this.diagLogged = true
      const col =
        'color' in bucket.material
          ? (bucket.material as THREE.MeshBasicMaterial).color.getHexString()
          : '—'
      console.info(
        `[MeshRendererInstancer] live buckets=${this.buckets.size} instances=${this.entityBucket.size} sampleKey=${bucketKey.slice(0, 64)} mat#${col}`
      )
    }
    return true
  }

  update(entity: Entity, entityObj: THREE.Group): void {
    const key = this.entityBucket.get(entity)
    if (!key) return
    const bucket = this.buckets.get(key)
    if (!bucket) return
    const index = bucket.entityIndex.get(entity)
    if (index === undefined) return
    this.writeMatrix(bucket, index, entityObj)
  }

  updateEntities(entities: Iterable<Entity>, nodes: Map<Entity, THREE.Group>): void {
    for (const entity of entities) {
      if (!this.entityBucket.has(entity)) continue
      const obj = nodes.get(entity)
      if (obj) this.update(entity, obj)
    }
  }

  /**
   * @returns true when the instance color buffer was written (caller can mark Material applied).
   */
  setInstanceColor(entity: Entity, r: number, g: number, b: number): boolean {
    const key = this.entityBucket.get(entity)
    if (!key) return false
    const bucket = this.buckets.get(key)
    if (!bucket?.useInstanceColor) return false
    const index = bucket.entityIndex.get(entity)
    if (index === undefined) return false
    _color.setRGB(r, g, b)
    bucket.mesh.setColorAt(index, _color)
    // Three requires needsUpdate after batch color writes — always set (not only if buffer existed).
    if (bucket.mesh.instanceColor) {
      bucket.mesh.instanceColor.needsUpdate = true
      bucket.mesh.instanceColor.version++
    }
    return true
  }

  /** Map InstancedMesh + instanceId → entity (pointer raycast). */
  entityFromInstanceHit(mesh: THREE.Object3D, instanceId: number): Entity | null {
    for (const bucket of this.buckets.values()) {
      if (bucket.mesh !== mesh) continue
      for (const [entity, index] of bucket.entityIndex) {
        if (index === instanceId) return entity
      }
      return null
    }
    return null
  }

  /** All InstancedMeshes (for PE raycast target list). */
  getAllInstanceMeshes(): THREE.InstancedMesh[] {
    return [...this.buckets.values()].map((b) => b.mesh)
  }

  detach(entity: Entity, entityObj?: THREE.Group): void {
    if (entityObj) {
      delete entityObj.userData.dclMeshRendererInstanced
      delete entityObj.userData[MESH_RENDERER_INSTANCE_BUCKET_KEY]
      const doomed: THREE.Object3D[] = []
      for (const child of entityObj.children) {
        if (child.userData[MESH_RENDERER_INSTANCE_MARKER] || child.userData.dclInstanceMarker) {
          doomed.push(child)
        }
      }
      for (const child of doomed) entityObj.remove(child)
    }

    const key = this.entityBucket.get(entity)
    this.entityBucket.delete(entity)
    if (!key) return
    const bucket = this.buckets.get(key)
    if (!bucket) return
    const index = bucket.entityIndex.get(entity)
    if (index === undefined) return
    bucket.entityIndex.delete(entity)
    bucket.free.push(index)
    // Hide slot + reset color so round-reset / entity recycle cannot leave painted tiles.
    _mat.makeScale(0, 0, 0)
    bucket.mesh.setMatrixAt(index, _mat)
    bucket.mesh.instanceMatrix.needsUpdate = true
    if (bucket.useInstanceColor) {
      _color.setRGB(1, 1, 1)
      bucket.mesh.setColorAt(index, _color)
      if (bucket.mesh.instanceColor) {
        bucket.mesh.instanceColor.needsUpdate = true
        bucket.mesh.instanceColor.version++
      }
    }
    if (bucket.entityIndex.size === 0) this.disposeBucket(key)
  }

  dispose(): void {
    for (const key of [...this.buckets.keys()]) this.disposeBucket(key)
    this.entityBucket.clear()
  }

  private createBucket(
    key: string,
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
    useInstanceColor: boolean
  ): Bucket {
    const host = this.getHostRoot()
    const root = new THREE.Group()
    root.name = `meshRenderer-instances:${key.slice(0, 48)}`
    host.add(root)

    const mat = material.clone()
    if (useInstanceColor && 'vertexColors' in mat) {
      ;(mat as THREE.MeshBasicMaterial | THREE.MeshStandardMaterial).vertexColors = false
    }
    // instanceColor multiplies material.color — force white base when using that path.
    // Color-in-bucket path keeps material.color as the tile albedo (set by caller).
    if (useInstanceColor && 'color' in mat && (mat as THREE.MeshBasicMaterial).color) {
      ;(mat as THREE.MeshBasicMaterial).color.setRGB(1, 1, 1)
    }

    const mesh = new THREE.InstancedMesh(geometry, mat, INITIAL_CAP)
    mesh.castShadow = false
    mesh.receiveShadow = true
    // Instance matrices place tiles across the whole scene; geometry bounds at origin would
    // frustum-cull the entire board when the camera is elsewhere.
    mesh.frustumCulled = false
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    if (useInstanceColor) {
      for (let i = 0; i < INITIAL_CAP; i++) {
        mesh.setColorAt(i, _color.setRGB(1, 1, 1))
      }
      if (mesh.instanceColor) mesh.instanceColor.setUsage(THREE.DynamicDrawUsage)
    }
    // Hide unused slots
    _mat.makeScale(0, 0, 0)
    for (let i = 0; i < INITIAL_CAP; i++) mesh.setMatrixAt(i, _mat)
    mesh.instanceMatrix.needsUpdate = true
    // Large bounds so raycasts / helpers that consult sphere still work.
    mesh.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 1e6)
    root.add(mesh)

    return {
      key,
      geometry,
      material: mat,
      mesh,
      entityIndex: new Map(),
      free: [],
      capacity: INITIAL_CAP,
      used: 0,
      useInstanceColor,
      root
    }
  }

  private allocIndex(bucket: Bucket): number {
    if (bucket.free.length) return bucket.free.pop()!
    if (bucket.used < bucket.capacity) return bucket.used++
    this.growBucket(bucket)
    return bucket.used++
  }

  private growBucket(bucket: Bucket): void {
    const nextCap = bucket.capacity * 2
    const old = bucket.mesh
    const mesh = new THREE.InstancedMesh(bucket.geometry, bucket.material, nextCap)
    mesh.castShadow = false
    mesh.receiveShadow = true
    mesh.frustumCulled = false
    mesh.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 1e6)
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    if (bucket.useInstanceColor) {
      for (let i = 0; i < nextCap; i++) mesh.setColorAt(i, _color.setRGB(1, 1, 1))
      if (mesh.instanceColor) mesh.instanceColor.setUsage(THREE.DynamicDrawUsage)
    }
    for (let i = 0; i < bucket.capacity; i++) {
      old.getMatrixAt(i, _mat)
      mesh.setMatrixAt(i, _mat)
      if (bucket.useInstanceColor && old.instanceColor && mesh.instanceColor) {
        old.getColorAt(i, _color)
        mesh.setColorAt(i, _color)
      }
    }
    _mat.makeScale(0, 0, 0)
    for (let i = bucket.capacity; i < nextCap; i++) mesh.setMatrixAt(i, _mat)
    mesh.instanceMatrix.needsUpdate = true
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
    bucket.root.add(mesh)
    old.removeFromParent()
    old.dispose()
    bucket.mesh = mesh
    bucket.capacity = nextCap
  }

  private writeMatrix(bucket: Bucket, index: number, entityObj: THREE.Group): void {
    if (!entityObj.visible) {
      _mat.makeScale(0, 0, 0)
      bucket.mesh.setMatrixAt(index, _mat)
      bucket.mesh.instanceMatrix.needsUpdate = true
      return
    }
    entityObj.updateMatrix()
    entityObj.updateMatrixWorld(true)
    // InstancedMesh is under host root — write world matrix (host usually identity).
    bucket.mesh.updateMatrixWorld(true)
    _mat.copy(bucket.mesh.matrixWorld).invert().multiply(entityObj.matrixWorld)
    bucket.mesh.setMatrixAt(index, _mat)
    bucket.mesh.instanceMatrix.needsUpdate = true
  }

  private disposeBucket(key: string): void {
    const bucket = this.buckets.get(key)
    if (!bucket) return
    this.buckets.delete(key)
    bucket.mesh.removeFromParent()
    bucket.mesh.dispose()
    bucket.material.dispose()
    releasePrimitiveGeometry(bucket.geometry)
    bucket.root.removeFromParent()
  }
}
