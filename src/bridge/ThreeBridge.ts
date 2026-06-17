import * as THREE from 'three'
import type { Entity } from '@dcl/ecs'
import type { ProjectionView } from './ProjectionView'
import { buildPrimitiveGeometry, primitiveDoubleSided, primitiveMeshKey } from './primitiveShapes'
import { MaterialApplier, type PbMaterial } from './material/MaterialApplier'
import type { AssetCache } from '../rendering/AssetCache'
import { prefetchSceneManifestGlbs } from '../rendering/AssetCache'
import type { ResolvedScene } from '../dcl/content/types'
import { resolveGltfSrcHash, GLTF_LOCAL_PREFIX, isEmoteAnchorGltfSrc } from '../rendering/DclTextureResolver'
import { syncGltfInstanceRenderState } from '../collision/gltfRenderMeshes'
import type { MirrorComponents } from './mirrorComponents'
import type { ProjectionChangeKind } from './CrdtProjection'
import { removeLightSource } from './LightSourceSync'
import { buildTextShapeMesh, disposeTextShapeMesh, updateTextShapeMesh } from './TextShapeSync'
import type { SceneHydrationStats } from '../rendering/sceneHydration'
import type { VideoPlayerBridge } from '../media/VideoPlayerBridge'
import type { EntityStore } from './EntityStore'
import { applySceneDiff } from './entityStoreApply'
import { disposeOwnedObject3D } from '../rendering/sharedAsset'

function materialReferencesVideoPlayer(pb: PbMaterial, videoPlayerEntity: Entity): boolean {
  const materialCase = pb.material?.$case
  const inner =
    materialCase === 'pbr'
      ? pb.material!.pbr
      : materialCase === 'unlit'
        ? pb.material!.unlit
        : undefined
  if (!inner) return false

  const slots = [inner.texture, inner.alphaTexture]
  if (materialCase === 'pbr') {
    const pbr = pb.material!.pbr
    slots.push(pbr.emissiveTexture, pbr.bumpTexture)
  }

  for (const slot of slots) {
    if (slot?.tex?.$case === 'videoTexture' && slot.tex.videoTexture.videoPlayerEntity === (videoPlayerEntity as number)) {
      return true
    }
  }
  return false
}

function hashFromSrc(src: string, scene: ResolvedScene): string | null {
  return resolveGltfSrcHash(scene.content, src)
}

/** True when the clone has at least one mesh with triangle geometry (visible, invisible _collider, or mis-export art). */
function gltfInstanceHasGeometry(root: THREE.Object3D): boolean {
  let found = false
  root.traverse((obj) => {
    if (found || !(obj as THREE.Mesh).isMesh) return
    const mesh = obj as THREE.Mesh
    const pos = mesh.geometry?.getAttribute('position')
    if (!pos || pos.count < 3) return
    found = true
  })
  return found
}

function meshKey(entity: Entity): string {
  return `__mesh_${entity}`
}

function lightKey(entity: Entity): string {
  return `__light_${entity}`
}

function textKey(entity: Entity): string {
  return `__text_${entity}`
}

function enableMeshReceiveShadow(root: THREE.Object3D): void {
  root.traverse((child) => {
    if ((child as THREE.Mesh).isMesh) (child as THREE.Mesh).receiveShadow = true
  })
}

/** Sync mirror ECS state → Three.js scene graph (Phase 1 + 1b render components). */
export class ThreeBridge {
  private static readonly GLTF_BUDGET_PER_FRAME = 6
  private static readonly GLTF_HYDRATION_BUDGET_PER_FRAME = 80
  private static readonly GLTF_SOFT_HYDRATION_BUDGET_PER_FRAME = 24
  private static readonly MESH_PASS_BUDGET_MS = 8
  private static readonly MESH_PASS_HYDRATION_BUDGET_MS = 48
  /** Extra attach-only passes per hydration sync (transform/light already applied). */
  private static readonly HYDRATION_ATTACH_PASSES = 6
  private static readonly HYDRATION_ATTACH_TOTAL_MS = 72

  private readonly store: EntityStore
  /** Phase 2 — entities whose GLB/mesh/material still needs an attach pass (budgeted, retried). */
  private readonly pendingMeshEntities = new Set<Entity>()
  /** Entities with a Material component still needing full texture apply after hydration defer. */
  private readonly pendingMaterialEntities = new Set<Entity>()
  private readonly materials: MaterialApplier
  private hydrationMode = false
  private readonly loggedUnresolvedSrcs = new Set<string>()
  private softHydrationUntil = 0
  private gltfBudgetRemaining = ThreeBridge.GLTF_BUDGET_PER_FRAME
  private readonly emptyGltfHashes = new Set<string>()
  /** Log once per src — emote anchor GLBs often have no render geometry. */
  private readonly loggedEmptyGltfSrcs = new Set<string>()
  private readonly loggedGltfAttachFailures = new Set<string>()
  private onGltfAttached: (() => void) | null = null
  private videoPlayerBridge: VideoPlayerBridge | null = null
  private skipTransformApply?: (entity: Entity) => boolean

  constructor(
    private readonly sceneConfig: ResolvedScene,
    private readonly cache: AssetCache,
    store: EntityStore,
    private readonly ecs: MirrorComponents
  ) {
    this.store = store
    this.materials = new MaterialApplier(sceneConfig, cache)
  }

  getEntityStore(): EntityStore {
    return this.store
  }

  getEntityNodes(): Map<Entity, THREE.Group> {
    return this.store.nodes
  }

  setVideoPlayerBridge(bridge: VideoPlayerBridge): void {
    this.videoPlayerBridge = bridge
    this.materials.setVideoTextureResolver((entity) => bridge.getTexture(entity as Entity))
    bridge.onTextureReady = (videoPlayerEntity) => {
      this.invalidateMaterialsForVideoPlayer(videoPlayerEntity)
    }
  }

  /** Fired after a hydration attach burst — sync + cook colliders for newly attached GLTFs. */
  setOnGltfAttached(callback: (() => void) | null): void {
    this.onGltfAttached = callback
  }

  /** Skip inbound Transform apply for renderer-owned poses (AvatarAttach). */
  setSkipTransformApply(fn: ((entity: Entity) => boolean) | null): void {
    this.skipTransformApply = fn ?? undefined
  }

  private notifyGltfAttached(): void {
    this.onGltfAttached?.()
  }

  private notifyMeshComponent(entity: Entity, componentId: number): void {
    this.store.notifyComponentChange(entity, componentId, 'put')
  }

  private invalidateMaterialsForVideoPlayer(videoPlayerEntity: Entity): void {
    const { Material } = this.ecs
    this.store.forEachSceneEntity((entity) => {
      if (materialReferencesVideoPlayer(Material.get(entity) as PbMaterial, videoPlayerEntity)) {
        this.materials.clearEntity(entity)
      }
    })
  }

  /** Lift the per-frame GLTF spawn cap while `waitForSceneAssets` runs. */
  setAssetHydrationMode(enabled: boolean): void {
    const wasHydration = this.hydrationMode
    this.hydrationMode = enabled
    if (wasHydration && !enabled) this.queueAllMaterialEntities()
  }

  isAssetHydrationMode(): boolean {
    return this.hydrationMode
  }

  /** Keep a higher spawn cap briefly after the loading screen hides. */
  extendSoftHydration(durationMs: number): void {
    this.softHydrationUntil = Math.max(this.softHydrationUntil, performance.now() + durationMs)
    window.setTimeout(() => this.queueAllMaterialEntities(), durationMs)
  }

  private resolveGltfBudget(): number {
    if (this.hydrationMode) return ThreeBridge.GLTF_HYDRATION_BUDGET_PER_FRAME
    if (performance.now() < this.softHydrationUntil) return ThreeBridge.GLTF_SOFT_HYDRATION_BUDGET_PER_FRAME
    return ThreeBridge.GLTF_BUDGET_PER_FRAME
  }

  private meshPassBudgetMs(): number {
    return this.hydrationMode || performance.now() < this.softHydrationUntil
      ? ThreeBridge.MESH_PASS_HYDRATION_BUDGET_MS
      : ThreeBridge.MESH_PASS_BUDGET_MS
  }

  /** Defer texture loads only during the loading-screen hydration burst — not soft GLTF cap. */
  private shouldDeferMaterials(): boolean {
    return this.hydrationMode
  }

  private shouldDeferTextures(): boolean {
    return this.hydrationMode || performance.now() < this.softHydrationUntil
  }

  private entityVisualRoot(entity: Entity, obj: THREE.Group): THREE.Object3D | null {
    const mk = meshKey(entity)
    return obj.getObjectByName(mk) ?? null
  }

  private queueAllMaterialEntities(): void {
    const { Material } = this.ecs
    for (const [entity, obj] of this.store.nodes) {
      if (!this.store.isSceneOwned(entity)) continue
      if (!Material.has(entity)) continue
      if (!this.entityVisualRoot(entity, obj)) continue
      const pb = Material.get(entity) as PbMaterial
      if (this.materials.needsReapply(entity, pb)) this.pendingMaterialEntities.add(entity)
    }
  }

  private entityNeedsMaterialWork(entity: Entity, obj: THREE.Group): boolean {
    const { Material } = this.ecs
    if (!Material.has(entity)) return false
    const visual = this.entityVisualRoot(entity, obj)
    if (!visual) return false
    return this.materials.needsReapply(entity, Material.get(entity) as PbMaterial)
  }

  private entityNeedsMeshWork(
    entity: Entity,
    obj: THREE.Group,
    opts: { includeMaterial?: boolean } = {}
  ): boolean {
    const includeMaterial = opts.includeMaterial !== false
    const { GltfContainer, MeshRenderer, TextShape } = this.ecs

    if (GltfContainer.has(entity)) {
      const src = GltfContainer.get(entity).src?.trim()
      if (!src) return false
      if (isEmoteAnchorGltfSrc(src)) {
        const srcKey = hashFromSrc(src, this.sceneConfig) ?? src
        const mesh = obj.getObjectByName(meshKey(entity))
        return !mesh || obj.userData.gltfSrcKey !== srcKey
      }
      const hash = hashFromSrc(src, this.sceneConfig)
      if (!hash) return false
      if (hash.startsWith(GLTF_LOCAL_PREFIX)) return false
      if (this.emptyGltfHashes.has(hash)) return false
      const cacheKey = this.gltfCacheKey(hash)
      if (this.cache.hasGivenUp(cacheKey)) return false
      const mesh = obj.getObjectByName(meshKey(entity))
      if (!mesh || obj.userData.gltfSrcKey !== hash) return true
      return !gltfInstanceHasGeometry(mesh)
    }

    if (TextShape.has(entity) && !obj.getObjectByName(textKey(entity))) return true

    if (MeshRenderer.has(entity)) {
      const mk = meshKey(entity)
      const primitive = obj.getObjectByName(mk)
      const key = primitiveMeshKey(MeshRenderer.get(entity))
      if (!(primitive instanceof THREE.Mesh) || primitive.userData.primitiveMeshKey !== key) return true
    }

    if (includeMaterial && this.entityNeedsMaterialWork(entity, obj)) return true

    return false
  }

  private gltfCacheKey(hash: string): string {
    return hash.startsWith(GLTF_LOCAL_PREFIX) ? hash.slice(GLTF_LOCAL_PREFIX.length) : hash
  }

  private gltfAttachPriority(entity: Entity): 'ready' | 'waiting' | 'blocked' | 'other' {
    const { GltfContainer } = this.ecs
    if (!GltfContainer.has(entity)) return 'other'
    const src = GltfContainer.get(entity).src?.trim()
    if (!src) return 'other'
    const hash = hashFromSrc(src, this.sceneConfig)
    if (!hash || hash.startsWith(GLTF_LOCAL_PREFIX)) return 'other'
    if (this.emptyGltfHashes.has(hash)) return 'blocked'
    const cacheKey = this.gltfCacheKey(hash)
    if (this.cache.hasCached(cacheKey)) return 'ready'
    return 'waiting'
  }

  private meshEntitiesForPass(sorted: Entity[], includeMaterial = true): Entity[] {
    const needsWork: Entity[] = []
    for (const entity of sorted) {
      const obj = this.store.nodes.get(entity)
      if (!obj || !this.entityNeedsMeshWork(entity, obj, { includeMaterial })) continue
      needsWork.push(entity)
    }
    if (!this.shouldDeferMaterials()) return needsWork

    const ready: Entity[] = []
    const waiting: Entity[] = []
    const blocked: Entity[] = []
    const other: Entity[] = []
    for (const entity of needsWork) {
      const priority = this.gltfAttachPriority(entity)
      if (priority === 'ready') ready.push(entity)
      else if (priority === 'waiting') waiting.push(entity)
      else if (priority === 'blocked') blocked.push(entity)
      else other.push(entity)
    }

    return [...ready, ...waiting, ...other, ...blocked]
  }

  /** Run mesh attach work; returns how many GLTF attach slots were consumed this pass. */
  private async runMeshAttachPass(
    sorted: Entity[],
    meshEcs: Pick<MirrorComponents, 'MeshRenderer' | 'Material' | 'GltfContainer' | 'TextShape'>,
    deferMaterials: boolean,
    touchMaterials = true
  ): Promise<number> {
    const budgetStart = this.gltfBudgetRemaining
    const meshEntities = this.meshEntitiesForPass(sorted, touchMaterials)
    const meshPassStart = performance.now()
    for (const entity of meshEntities) {
      if (performance.now() - meshPassStart >= this.meshPassBudgetMs()) break
      const obj = this.store.nodes.get(entity)!
      await this.syncMesh(entity, obj, meshEcs, deferMaterials, touchMaterials)
    }
    return budgetStart - this.gltfBudgetRemaining
  }

  private async runHydrationAttachPasses(
    sorted: Entity[],
    meshEcs: Pick<MirrorComponents, 'MeshRenderer' | 'Material' | 'GltfContainer' | 'TextShape'>,
    deferMaterials: boolean,
    touchMaterials = true
  ): Promise<void> {
    const burstStart = performance.now()
    for (let pass = 0; pass < ThreeBridge.HYDRATION_ATTACH_PASSES; pass++) {
      if (performance.now() - burstStart >= ThreeBridge.HYDRATION_ATTACH_TOTAL_MS) break
      this.gltfBudgetRemaining = this.resolveGltfBudget()
      const attached = await this.runMeshAttachPass(sorted, meshEcs, deferMaterials, touchMaterials)
      // Collider extract + PhysX cook run once per hydration tick (sceneHydration onCollidersCook),
      // not here — per-attach sync+cook blocked the attach burst on multi-shape trimesh cooks.
      if (attached === 0 && pass > 0) break
    }
  }

  getHydrationStats(_view: ProjectionView): SceneHydrationStats {
    const { GltfContainer } = this.ecs
    let entityCount = 0
    let gltfEntities = 0
    let gltfLoaded = 0
    let gltfAbandoned = 0
    let gltfUnresolved = 0

    this.store.forEachSceneEntity((entity, obj) => {
      entityCount++
      if (!GltfContainer.has(entity)) return

      const src = GltfContainer.get(entity).src?.trim()
      if (!src) return

      const hash = hashFromSrc(src, this.sceneConfig)
      if (!hash) {
        gltfUnresolved++
        if (!this.loggedUnresolvedSrcs.has(src)) {
          this.loggedUnresolvedSrcs.add(src)
          console.debug('[ThreeBridge] unresolved GltfContainer.src:', src)
        }
        return
      }

      if (hash.startsWith(GLTF_LOCAL_PREFIX)) return

      gltfEntities++
      if (this.emptyGltfHashes.has(hash)) {
        gltfAbandoned++
        return
      }
      const cacheKey = this.gltfCacheKey(hash)
      if (this.cache.hasGivenUp(cacheKey)) {
        gltfAbandoned++
        return
      }
      const mesh = obj.getObjectByName(meshKey(entity))
      if (mesh && obj.userData.gltfSrcKey === hash && gltfInstanceHasGeometry(mesh)) gltfLoaded++
    })

    const assetStats = this.cache.getLoadStats()
    return {
      entityCount,
      gltfEntities,
      gltfLoaded,
      gltfPending: gltfEntities - gltfLoaded,
      gltfAbandoned,
      gltfUnresolved,
      gltfInflight: assetStats.gltfInflight,
      textureInflight: assetStats.textureInflight
    }
  }

  /**
   * Fire off network requests for every `.glb` in the scene content manifest.
   * Does not block — downloads proceed in parallel while attach budgets control scene-graph work.
   */
  private sceneManifestPrefetched = false
  prefetchSceneGlbs(): void {
    if (this.sceneManifestPrefetched) return
    this.sceneManifestPrefetched = true
    prefetchSceneManifestGlbs(this.cache, this.sceneConfig)
  }

  async sync(view: ProjectionView): Promise<void> {
    this.gltfBudgetRemaining = this.resolveGltfBudget()
    const { Transform, MeshRenderer, Material, GltfContainer, TextShape } = this.ecs
    const meshEcs = { MeshRenderer, Material, GltfContainer, TextShape }
    const deferMaterials = this.shouldDeferMaterials()

    const fullDiff = new Map<Entity, Map<number, ProjectionChangeKind>>()
    const active = new Set<Entity>()

    for (const [entity] of view.getEntitiesWith(Transform)) {
      if (entity === view.RootEntity || entity === view.PlayerEntity || entity === view.CameraEntity) {
        continue
      }
      active.add(entity)
      const comps = new Map<number, ProjectionChangeKind>()
      comps.set(Transform.componentId, 'put')
      fullDiff.set(entity, comps)
    }

    const applied = applySceneDiff(this.store, fullDiff, view, this.ecs, [], {
      notifySecondary: false,
      skipTransformApply: this.skipTransformApply
    })

    // Post-hydration safety resync: reconcile transforms / orphan nodes only — never re-touch materials.
    const touchMaterials = this.hydrationMode
    if (this.hydrationMode) {
      await this.runHydrationAttachPasses(applied.upserts, meshEcs, deferMaterials, touchMaterials)
      await this.runMaterialPass(Material)
    } else {
      await this.runMeshAttachPass(applied.upserts, meshEcs, deferMaterials, touchMaterials)
    }

    for (const [entity] of this.store.nodes) {
      if (!this.store.isSceneOwned(entity)) continue
      if (!active.has(entity)) this.removeEntityNode(entity)
    }
    this.pendingMeshEntities.clear()
  }

  /**
   * Phase 2 — diff mode is safe to drive only when assets aren't actively streaming.
   * During hydration the full walk handles the high-churn spawn burst.
   */
  canConsumeDiff(): boolean {
    return !this.hydrationMode
  }

  /**
   * Phase 2 (REARCHITECTURE_PLAN.md §5.2) — patch only the entities/components named in the
   * projection diff instead of walking the whole engine every frame. Transform / visibility /
   * light mutate store nodes via `applySceneDiff`; component values still read from ProjectionView.
   * Tweened entities are re-applied every frame because their Transform is interpolated
   * renderer-locally and never appears in the worker diff.
   */
  async consumeDiff(diff: Map<Entity, Map<number, ProjectionChangeKind>>, view: ProjectionView): Promise<void> {
    this.gltfBudgetRemaining = this.resolveGltfBudget()
    const { MeshRenderer, Material, GltfContainer, TextShape, Tween, AvatarAttach } = this.ecs
    const meshEcs = { MeshRenderer, Material, GltfContainer, TextShape }
    const deferMaterials = this.shouldDeferMaterials()

    const tweenRefresh: Entity[] = []
    for (const [entity] of view.getEntitiesWith(Tween)) {
      if (AvatarAttach.has(entity) || this.skipTransformApply?.(entity)) continue
      tweenRefresh.push(entity)
    }

    const applied = applySceneDiff(this.store, diff, view, this.ecs, tweenRefresh, {
      skipTransformApply: this.skipTransformApply
    })

    for (const entity of applied.removals) {
      this.removeEntityNode(entity)
    }
    for (const entity of applied.meshDirty) {
      this.pendingMeshEntities.add(entity)
      if (Material.has(entity)) {
        const pb = Material.get(entity) as PbMaterial
        if (this.materials.needsReapply(entity, pb)) this.pendingMaterialEntities.add(entity)
      }
    }

    await this.runDiffMeshPass(meshEcs, deferMaterials)
    await this.runMaterialPass(Material)
  }

  /** Budgeted attach pass over the standing pending-mesh set (drained as entities finish). */
  private async runDiffMeshPass(
    meshEcs: Pick<MirrorComponents, 'MeshRenderer' | 'Material' | 'GltfContainer' | 'TextShape'>,
    deferMaterials: boolean
  ): Promise<void> {
    if (!this.pendingMeshEntities.size) return

    // Drop entities that no longer need mesh work (attached, abandoned, or removed).
    for (const entity of [...this.pendingMeshEntities]) {
      const obj = this.store.nodes.get(entity)
      if (!obj || !this.entityNeedsMeshWork(entity, obj)) this.pendingMeshEntities.delete(entity)
    }
    if (!this.pendingMeshEntities.size) return

    const ordered = this.meshEntitiesForPass([...this.pendingMeshEntities])
    const passStart = performance.now()
    for (const entity of ordered) {
      if (performance.now() - passStart >= this.meshPassBudgetMs()) break
      const obj = this.store.nodes.get(entity)
      if (!obj) {
        this.pendingMeshEntities.delete(entity)
        continue
      }
      await this.syncMesh(entity, obj, meshEcs, deferMaterials, true)
      // GLB still downloading → stays queued; otherwise it's done.
      if (!this.entityNeedsMeshWork(entity, obj)) this.pendingMeshEntities.delete(entity)
    }
  }

  /** Budgeted full material apply for entities queued during hydration defer. */
  private async runMaterialPass(Material: MirrorComponents['Material']): Promise<void> {
    if (!this.pendingMaterialEntities.size) return
    const deferTextures = this.shouldDeferTextures()
    const passStart = performance.now()

    for (const entity of [...this.pendingMaterialEntities]) {
      if (performance.now() - passStart >= this.meshPassBudgetMs()) break
      const obj = this.store.nodes.get(entity)
      if (!obj || !Material.has(entity)) {
        this.pendingMaterialEntities.delete(entity)
        continue
      }
      const visual = this.entityVisualRoot(entity, obj)
      if (!visual) continue

      const pb = Material.get(entity) as PbMaterial
      if (deferTextures) {
        this.materials.applyScalarsToObject3D(visual, entity, pb)
        if (!this.materials.needsReapply(entity, pb)) this.pendingMaterialEntities.delete(entity)
        continue
      }
      await this.materials.applyToObject3D(visual, entity, pb)
      this.notifyMeshComponent(entity, Material.componentId)
      if (!this.materials.needsReapply(entity, pb)) this.pendingMaterialEntities.delete(entity)
    }
  }

  private removeEntityNode(entity: Entity): void {
    if (!this.store.isSceneOwned(entity)) return
    this.pendingMeshEntities.delete(entity)
    this.pendingMaterialEntities.delete(entity)
    const obj = this.store.getNode(entity)
    if (!obj) return
    this.materials.clearEntity(entity)
    this.videoPlayerBridge?.disposeEntity(entity)
    this.removeEntityVisuals(entity, obj)
    this.store.deleteEntity(entity)
  }

  /** Tear down bridge-owned resources (entity graph cleared via `EntityStore.dispose`). */
  dispose(): void {
    this.videoPlayerBridge?.dispose()
    this.videoPlayerBridge = null
    this.pendingMeshEntities.clear()
    this.pendingMaterialEntities.clear()
  }

  private removeEntityVisuals(entity: Entity, obj: THREE.Group): void {
    const mk = meshKey(entity)
    const tk = textKey(entity)
    const lk = lightKey(entity)
    for (const name of [mk, tk]) {
      const child = obj.getObjectByName(name)
      if (!child) continue
      if (name === tk) disposeTextShapeMesh(child)
      else disposeOwnedObject3D(child)
      obj.remove(child)
    }
    removeLightSource(obj, lk)
  }

  private async syncMesh(
    entity: Entity,
    obj: THREE.Group,
    ecs: Pick<MirrorComponents, 'MeshRenderer' | 'Material' | 'GltfContainer' | 'TextShape'>,
    deferMaterials = false,
    touchMaterials = true
  ): Promise<void> {
    const { MeshRenderer, Material, GltfContainer, TextShape } = ecs
    const mk = meshKey(entity)
    const tk = textKey(entity)

    if (TextShape.has(entity)) {
      const spec = TextShape.get(entity)
      let textMesh = obj.getObjectByName(tk) as THREE.Mesh | undefined
      if (!textMesh) {
        const stale = obj.getObjectByName(mk)
      if (stale) {
        disposeOwnedObject3D(stale)
        obj.remove(stale)
        }
        textMesh = buildTextShapeMesh(spec)
        textMesh.name = tk
        obj.add(textMesh)
        this.notifyMeshComponent(entity, TextShape.componentId)
      } else {
        updateTextShapeMesh(textMesh, spec)
        this.notifyMeshComponent(entity, TextShape.componentId)
      }
      return
    }

    const staleText = obj.getObjectByName(tk)
    if (staleText) {
      disposeTextShapeMesh(staleText)
      obj.remove(staleText)
    }

    if (GltfContainer.has(entity)) {
      const { src } = GltfContainer.get(entity)
      const hash = hashFromSrc(src, this.sceneConfig)
      const srcKey = hash ?? src.trim()
      let mesh = obj.getObjectByName(mk) as THREE.Object3D | undefined

      if (isEmoteAnchorGltfSrc(src)) {
        if (!mesh || obj.userData.gltfSrcKey !== srcKey) {
          if (mesh) {
            disposeOwnedObject3D(mesh)
            obj.remove(mesh)
          }
          const anchor = new THREE.Group()
          anchor.name = mk
          obj.userData.gltfSrcKey = srcKey
          obj.userData.emoteAnchor = true
          obj.add(anchor)
          this.notifyMeshComponent(entity, GltfContainer.componentId)
        }
        return
      }

      if (!hash) return

      if (!mesh || obj.userData.gltfSrcKey !== srcKey) {
        if (mesh) {
          disposeOwnedObject3D(mesh)
          obj.remove(mesh)
        }

        const isLocal = hash.startsWith(GLTF_LOCAL_PREFIX)
        const url = isLocal ? hash.slice(GLTF_LOCAL_PREFIX.length) : this.sceneConfig.assetUrl(hash)
        const cacheKey = this.gltfCacheKey(hash)
        if (!this.cache.hasCached(cacheKey)) {
          this.cache.ensureLoading(url, isLocal ? undefined : hash)
          return
        }

        if (this.gltfBudgetRemaining <= 0) return

        this.gltfBudgetRemaining--
        try {
          const clone = await this.cache.clone(url, isLocal ? url : hash)
          obj.userData.gltfSrcKey = srcKey
          if (!gltfInstanceHasGeometry(clone)) {
            this.gltfBudgetRemaining++
            if (isEmoteAnchorGltfSrc(src)) {
              const anchor = new THREE.Group()
              anchor.name = mk
              obj.userData.gltfSrcKey = srcKey
              obj.userData.emoteAnchor = true
              obj.add(anchor)
              disposeOwnedObject3D(clone)
              return
            }
            this.emptyGltfHashes.add(hash)
            disposeOwnedObject3D(clone)
            if (!this.loggedEmptyGltfSrcs.has(src)) {
              this.loggedEmptyGltfSrcs.add(src)
              console.warn('[ThreeBridge] GLB has no renderable geometry — skipping', src)
            }
            return
          }
          clone.name = mk
          syncGltfInstanceRenderState(clone)
          enableMeshReceiveShadow(clone)
          obj.add(clone)
          mesh = clone
          this.notifyMeshComponent(entity, GltfContainer.componentId)
          this.notifyGltfAttached()
        } catch (err) {
          this.gltfBudgetRemaining++
          obj.userData.gltfSrcKey = srcKey
          if (!this.loggedGltfAttachFailures.has(src)) {
            this.loggedGltfAttachFailures.add(src)
            console.warn('[ThreeBridge] GLB attach failed', src, err)
          }
          return
        }
      }

      if (mesh) syncGltfInstanceRenderState(mesh)

      if (touchMaterials && Material.has(entity) && mesh) {
        const pb = Material.get(entity) as PbMaterial
        if (!this.materials.needsReapply(entity, pb)) {
          /* material already matches ECS — skip destructive re-apply on full resync */
        } else if (deferMaterials || this.shouldDeferTextures()) {
          this.pendingMaterialEntities.add(entity)
          this.materials.applyScalarsToObject3D(mesh, entity, pb)
        } else {
          await this.materials.applyToObject3D(mesh, entity, pb)
          this.notifyMeshComponent(entity, Material.componentId)
          if (!this.materials.needsReapply(entity, pb)) this.pendingMaterialEntities.delete(entity)
        }
      }
      return
    }

    delete obj.userData.gltfSrcKey
    const staleGltf = obj.getObjectByName(mk)
    if (staleGltf && staleGltf.userData.primitiveKind === undefined) {
      disposeOwnedObject3D(staleGltf)
      obj.remove(staleGltf)
    }

    if (MeshRenderer.has(entity)) {
      const spec = MeshRenderer.get(entity)
      const key = primitiveMeshKey(spec)
      let primitive = obj.getObjectByName(mk) as THREE.Mesh | undefined

      if (!primitive || !(primitive as THREE.Mesh).isMesh || primitive.userData.primitiveMeshKey !== key) {
        if (primitive) {
          ;(primitive as THREE.Mesh).geometry.dispose()
          obj.remove(primitive)
        }
        const doubleSided = primitiveDoubleSided(spec)
        primitive = new THREE.Mesh(
          buildPrimitiveGeometry(spec),
          new THREE.MeshStandardMaterial({
            color: 0xffffff,
            side: doubleSided ? THREE.DoubleSide : THREE.FrontSide
          })
        )
        primitive.name = mk
        primitive.userData.primitiveMeshKey = key
        primitive.userData.primitiveDoubleSided = doubleSided
        primitive.castShadow = false
        primitive.receiveShadow = true
        obj.add(primitive)
        this.notifyMeshComponent(entity, MeshRenderer.componentId)
      }

      if (touchMaterials && Material.has(entity)) {
        const pb = Material.get(entity) as PbMaterial
        if (!this.materials.needsReapply(entity, pb)) {
          /* material already matches ECS — skip destructive re-apply on full resync */
        } else if (deferMaterials || this.shouldDeferTextures()) {
          this.pendingMaterialEntities.add(entity)
          this.materials.applyScalarsToObject3D(primitive, entity, pb)
        } else {
          await this.materials.applyToObject3D(primitive, entity, pb)
          this.notifyMeshComponent(entity, Material.componentId)
          if (!this.materials.needsReapply(entity, pb)) this.pendingMaterialEntities.delete(entity)
        }
      }
    }
  }
}
