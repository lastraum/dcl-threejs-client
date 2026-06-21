import * as THREE from 'three'
import type { Entity } from '@dcl/ecs'
import type { EntityStore } from './EntityStore'
import type { MirrorComponents } from './mirrorComponents'
import type { StaticEntityRegistry } from './StaticEntityRegistry'
import { isEmoteAnchorGltfSrc } from '../rendering/DclTextureResolver'

const INITIAL_CAPACITY = 64
const MAX_CAPACITY = 2048

type TemplateMesh = {
  geometry: THREE.BufferGeometry
  material: THREE.Material | THREE.Material[]
  localMatrix: THREE.Matrix4
}

type SrcBatch = {
  srcKey: string
  holder: THREE.Group
  templates: TemplateMesh[]
  instanced: THREE.InstancedMesh[]
  entityToSlot: Map<Entity, number>
  freeSlots: number[]
  count: number
}

/**
 * Renders duplicate frozen GLTF props via InstancedMesh (same src, no per-entity modifiers).
 * Decorative only — excludes pointer/collider/animator entities.
 */
export class GltfInstancedPool {
  private readonly root: THREE.Group
  private readonly batches = new Map<string, SrcBatch>()
  private readonly entityBatch = new Map<Entity, string>()
  private readonly matrixScratch = new THREE.Matrix4()
  private readonly entityWorld = new THREE.Matrix4()

  constructor(parent: THREE.Object3D) {
    this.root = new THREE.Group()
    this.root.name = '__gltf_instanced_pool__'
    parent.add(this.root)
  }

  canInstance(
    entity: Entity,
    src: string,
    staticRegistry: StaticEntityRegistry,
    components: MirrorComponents
  ): boolean {
    if (!staticRegistry.isFrozen(entity)) return false
    const { Animator, Tween, TweenState, GltfContainer, PointerEvents, MeshCollider, Material } =
      components
    if (Animator.has(entity) || Tween.has(entity) || TweenState.has(entity)) return false
    if (PointerEvents.has(entity) || MeshCollider.has(entity)) return false
    if (Material.has(entity)) return false
    const trimmed = src.trim()
    if (!trimmed || isEmoteAnchorGltfSrc(trimmed)) return false
    if (!GltfContainer.has(entity)) return false
    return true
  }

  isInstanced(entity: Entity): boolean {
    return this.entityBatch.has(entity)
  }

  registerFromClone(entity: Entity, srcKey: string, clone: THREE.Object3D, entityNode: THREE.Group): boolean {
    if (this.entityBatch.has(entity)) return true

    let batch = this.batches.get(srcKey)
    if (!batch) {
      const created = this.createBatch(srcKey, clone)
      if (!created) return false
      batch = created
      this.batches.set(srcKey, batch)
    }

    const slot = this.allocateSlot(batch)
    if (slot < 0) return false

    batch.entityToSlot.set(entity, slot)
    this.entityBatch.set(entity, srcKey)
    entityNode.userData.gltfInstanced = true
    entityNode.userData.gltfSrcKey = srcKey
    entityNode.userData.gltfInstanceSlot = slot

    entityNode.updateMatrixWorld(true)
    this.writeSlotMatrices(batch, slot, entityNode)

    return true
  }

  release(entity: Entity): void {
    const srcKey = this.entityBatch.get(entity)
    if (!srcKey) return
    const batch = this.batches.get(srcKey)
    if (!batch) {
      this.entityBatch.delete(entity)
      return
    }
    const slot = batch.entityToSlot.get(entity)
    if (slot !== undefined) {
      batch.entityToSlot.delete(entity)
      batch.freeSlots.push(slot)
      this.hideSlot(batch, slot)
    }
    this.entityBatch.delete(entity)
    if (batch.entityToSlot.size === 0) {
      this.disposeBatch(batch)
      this.batches.delete(srcKey)
    }
  }

  syncEntityTransform(entity: Entity, store: EntityStore): void {
    const srcKey = this.entityBatch.get(entity)
    if (!srcKey) return
    const batch = this.batches.get(srcKey)
    if (!batch) return
    const slot = batch.entityToSlot.get(entity)
    if (slot === undefined) return
    const node = store.getNode(entity)
    if (!node) return
    node.updateMatrixWorld(true)
    this.writeSlotMatrices(batch, slot, node)
  }

  syncAll(store: EntityStore): void {
    for (const entity of this.entityBatch.keys()) {
      this.syncEntityTransform(entity, store)
    }
  }

  dispose(): void {
    for (const batch of this.batches.values()) this.disposeBatch(batch)
    this.batches.clear()
    this.entityBatch.clear()
    this.root.removeFromParent()
  }

  private createBatch(srcKey: string, clone: THREE.Object3D): SrcBatch | null {
    const templates: TemplateMesh[] = []
    clone.updateMatrixWorld(true)
    clone.traverse((obj) => {
      const mesh = obj as THREE.Mesh
      if (!mesh.isMesh || !mesh.geometry) return
      const pos = mesh.geometry.getAttribute('position')
      if (!pos || pos.count < 3) return
      const localMatrix = new THREE.Matrix4()
      mesh.updateMatrixWorld(true)
      localMatrix.copy(mesh.matrixWorld)
      templates.push({
        geometry: mesh.geometry,
        material: mesh.material,
        localMatrix
      })
    })
    if (!templates.length) return null

    const holder = new THREE.Group()
    holder.name = `__instanced_${srcKey.slice(0, 12)}`
    const instanced: THREE.InstancedMesh[] = []
    for (let i = 0; i < templates.length; i++) {
      const tpl = templates[i]!
      const im = new THREE.InstancedMesh(tpl.geometry, tpl.material, INITIAL_CAPACITY)
      im.name = `__inst_${i}`
      im.count = 0
      im.frustumCulled = true
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
      holder.add(im)
      instanced.push(im)
    }
    this.root.add(holder)

    return {
      srcKey,
      holder,
      templates,
      instanced,
      entityToSlot: new Map(),
      freeSlots: [],
      count: 0
    }
  }

  private allocateSlot(batch: SrcBatch): number {
    if (batch.freeSlots.length) return batch.freeSlots.pop()!
    if (batch.count >= MAX_CAPACITY) return -1
    const slot = batch.count++
    if (batch.count > batch.instanced[0]!.instanceMatrix.count) {
      this.growBatch(batch)
    }
    for (const im of batch.instanced) im.count = batch.count
    return slot
  }

  private growBatch(batch: SrcBatch): void {
    const nextCap = Math.min(MAX_CAPACITY, Math.max(INITIAL_CAPACITY, batch.count * 2))
    for (let i = 0; i < batch.templates.length; i++) {
      const old = batch.instanced[i]!
      const tpl = batch.templates[i]!
      const grown = new THREE.InstancedMesh(tpl.geometry, tpl.material, nextCap)
      grown.name = old.name
      grown.count = batch.count
      grown.frustumCulled = true
      grown.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
      for (let s = 0; s < batch.count; s++) {
        old.getMatrixAt(s, this.matrixScratch)
        grown.setMatrixAt(s, this.matrixScratch)
      }
      batch.holder.remove(old)
      old.dispose()
      batch.holder.add(grown)
      batch.instanced[i] = grown
    }
  }

  private writeSlotMatrices(batch: SrcBatch, slot: number, entityNode: THREE.Object3D): void {
    entityNode.updateMatrixWorld(true)
    this.entityWorld.copy(entityNode.matrixWorld)
    for (let i = 0; i < batch.templates.length; i++) {
      const tpl = batch.templates[i]!
      const im = batch.instanced[i]!
      this.matrixScratch.copy(this.entityWorld).multiply(tpl.localMatrix)
      im.setMatrixAt(slot, this.matrixScratch)
      im.instanceMatrix.needsUpdate = true
    }
  }

  private hideSlot(batch: SrcBatch, slot: number): void {
    this.matrixScratch.makeScale(0, 0, 0)
    for (const im of batch.instanced) {
      im.setMatrixAt(slot, this.matrixScratch)
      im.instanceMatrix.needsUpdate = true
    }
  }

  private disposeBatch(batch: SrcBatch): void {
    for (const im of batch.instanced) {
      batch.holder.remove(im)
      im.dispose()
    }
    batch.holder.removeFromParent()
  }
}