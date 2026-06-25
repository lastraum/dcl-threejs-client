import * as THREE from 'three'
import type { Entity } from '@dcl/ecs'
import type { ProjectionView } from './ProjectionView'
import {

  buildPrimitiveGeometry,
  primitiveDoubleSided,
  hasAnimatedPlaneUvs,
  primitiveKind,
  primitiveMeshKey,
  updatePlaneGeometryUvs
} from './primitiveShapes'
import { MaterialApplier, type PbMaterial } from './material/MaterialApplier'
import type { AssetCache } from '../rendering/AssetCache'
import { prefetchSceneManifestAssets } from '../rendering/AssetCache'
import type { ResolvedScene } from '../dcl/content/types'
import { resolveGltfSrcHash, GLTF_LOCAL_PREFIX, isEmoteAnchorGltfSrc } from '../rendering/DclTextureResolver'
import { isMotionFocusActive, matchesMotionFocusSrc } from './motionFocus'
import { clientDebugLog } from '../client/debug/ClientDebugLog'
import { syncGltfInstanceRenderState } from '../collision/gltfRenderMeshes'
import type { MirrorComponents } from './mirrorComponents'
import type { ProjectionChangeKind } from './CrdtProjection'
import { removeLightSource } from './LightSourceSync'
import { buildTextShapeMesh, disposeTextShapeMesh, updateTextShapeMesh } from './TextShapeSync'
import type { SceneHydrationStats } from '../rendering/sceneHydration'
import type { AudioSourceBridge } from '../media/AudioSourceBridge'
import type { AudioStreamBridge } from '../media/AudioStreamBridge'
import type { VideoPlayerBridge } from '../media/VideoPlayerBridge'
import type { EntityStore } from './EntityStore'
import { applySceneDiff, type ApplySceneDiffOptions } from './entityStoreApply'
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

/** Animation-only GLBs — hide meshes but keep armature for Animator / scene-emote rigs. */
function hideGltfRenderMeshes(root: THREE.Object3D): void {
  root.traverse((obj) => {
    if ((obj as THREE.Mesh).isMesh) {
      obj.visible = false
      obj.frustumCulled = false
    }
  })
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

function particleKey(entity: Entity): string {
  return `__particles_${entity}`
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
  private onGltfAttached: ((entity: Entity) => void) | null = null
  private videoPlayerBridge: VideoPlayerBridge | null = null
  private audioSourceBridge: AudioSourceBridge | null = null
  private audioStreamBridge: AudioStreamBridge | null = null
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

  /**
   * Tracked sprite-pool recycle slot — live ECS guard so stale flags never suppress colliders
   * on entities that gained MeshCollider / PointerEvents.
   */
  isAnimatedSpriteSlot(entity: Entity): boolean {
    return this.store.isSpritePool(entity) && this.isSpritePoolEntity(entity)
  }

  /** Only suspended pool slots skip secondary notifies — not every animated plane in the scene. */
  private skipSpriteSecondaryNotify = (entity: Entity): boolean => this.isAnimatedSpriteSlot(entity)

  private sceneDiffOptions(extra?: Partial<ApplySceneDiffOptions>): ApplySceneDiffOptions {
    return {
      skipTransformApply: this.skipTransformApply,
      skipSecondaryNotify: this.skipSpriteSecondaryNotify,
      ...extra
    }
  }

  /** Sprite recycle path only — transformless MeshRenderer/Material between DELETE and revive. */
  private spritePoolDiffOptions(extra?: Partial<ApplySceneDiffOptions>): ApplySceneDiffOptions {
    return {
      ...this.sceneDiffOptions(),
      allowTransformless: (entity) => this.store.allowTransformless(entity),
      ...extra
    }
  }

  private isReservedSceneEntity(entity: Entity, view: ProjectionView): boolean {
    return (
      entity === view.RootEntity || entity === view.PlayerEntity || entity === view.CameraEntity
    )
  }

  /**
   * DCL sprite pool pattern — plane + animated UVs, non-interactive (any scene).
   */
  private isSpritePoolEntity(entity: Entity): boolean {
    const { MeshRenderer, PointerEvents, MeshCollider } = this.ecs
    if (!MeshRenderer.has(entity) || !hasAnimatedPlaneUvs(MeshRenderer.get(entity))) return false
    return !PointerEvents.has(entity) && !MeshCollider.has(entity)
  }

  private isSpriteDiffEntity(
    entity: Entity,
    view: ProjectionView,
    Transform: MirrorComponents['Transform']
  ): boolean {
    if (this.isReservedSceneEntity(entity, view)) return false
    if (this.isSpritePoolEntity(entity)) return true
    return (
      !Transform.has(entity) &&
      this.store.has(entity) &&
      this.store.isSpritePool(entity) &&
      this.store.isSuspended(entity)
    )
  }

  /** Peel sprite-pool churn off the main async consumeDiff path. */
  partitionSpriteDiff(
    diff: Map<Entity, Map<number, ProjectionChangeKind>>,
    view: ProjectionView
  ): {
    spriteDiff: Map<Entity, Map<number, ProjectionChangeKind>>
    sceneDiff: Map<Entity, Map<number, ProjectionChangeKind>>
  } {
    this.pruneMisclassifiedSpriteSlots()
    const { Transform } = this.ecs
    const spriteDiff = new Map<Entity, Map<number, ProjectionChangeKind>>()
    const sceneDiff = new Map<Entity, Map<number, ProjectionChangeKind>>()
    for (const [entity, comps] of diff) {
      if (this.isSpriteDiffEntity(entity, view, Transform)) {
        spriteDiff.set(entity, comps)
      } else {
        sceneDiff.set(entity, comps)
      }
    }
    return { spriteDiff, sceneDiff }
  }

  /**
   * Sync-only sprite pool path — transform + in-place UV; no async mesh/material passes,
   * no EntityStore secondary notifications (collider / pointer).
   */
  consumeSpriteDiff(
    diff: Map<Entity, Map<number, ProjectionChangeKind>>,
    view: ProjectionView
  ): void {
    if (!diff.size) return
    const { MeshRenderer, Material } = this.ecs

    this.primeSpritePoolSlotsFromDiff(diff, view, MeshRenderer)

    const applied = applySceneDiff(this.store, diff, view, this.ecs, [], this.spritePoolDiffOptions())

    const materialTouch = new Set<Entity>()

    for (const entity of applied.removals) {
      this.suspendSpriteSlot(entity)
    }

    for (const entity of applied.meshDirty) {
      this.store.reviveSceneEntity(entity)
      this.trackSpritePoolEntity(entity)
      this.syncSpritePlaneVisual(entity, Material, true)
      this.applyAnimatedPlaneUvs(entity)
      materialTouch.add(entity)
    }

    for (const entity of applied.upserts) {
      if (applied.meshDirty.includes(entity)) continue
      if (!MeshRenderer.has(entity)) continue
      this.store.reviveSceneEntity(entity)
      this.trackSpritePoolEntity(entity)
      this.syncSpritePlaneVisual(entity, Material, true)
      this.applyAnimatedPlaneUvs(entity)
      materialTouch.add(entity)
    }

    for (const [entity, comps] of diff) {
      if (!this.store.isSpritePool(entity)) continue
      if (!comps.has(Material.componentId) || !Material.has(entity)) continue
      this.syncSpritePlaneVisual(entity, Material, true)
      materialTouch.add(entity)
    }

    if (materialTouch.size) {
      void this.runSpriteMaterialPass([...materialTouch], Material)
    }

    this.syncBillboardFlagsFromDiff(diff, this.ecs.Billboard)
  }

  setVideoPlayerBridge(bridge: VideoPlayerBridge): void {
    this.videoPlayerBridge = bridge
    this.materials.setVideoTextureResolver((entity) => bridge.getTexture(entity as Entity))
    bridge.onTextureReady = (videoPlayerEntity) => {
      this.invalidateMaterialsForVideoPlayer(videoPlayerEntity)
    }
  }

  setAvatarTextureResolver(resolver: (userId: string) => Promise<THREE.Texture | null>): void {
    this.materials.setAvatarTextureResolver(resolver)
    this.queueAllMaterialEntities()
  }

  setAudioSourceBridge(bridge: AudioSourceBridge): void {
    this.audioSourceBridge = bridge
  }

  setAudioStreamBridge(bridge: AudioStreamBridge): void {
    this.audioStreamBridge = bridge
  }

  /** Fired after a GLB lands on an entity — incremental collider extract for that entity only. */
  setOnGltfAttached(callback: ((entity: Entity) => void) | null): void {
    this.onGltfAttached = callback
  }

  /** Skip inbound Transform apply for renderer-owned poses (AvatarAttach). */
  setSkipTransformApply(fn: ((entity: Entity) => boolean) | null): void {
    this.skipTransformApply = fn ?? undefined
  }

  private notifyGltfAttached(entity: Entity): void {
    this.onGltfAttached?.(entity)
  }

  private notifyMeshComponent(entity: Entity, componentId: number): void {
    if (this.isAnimatedSpriteSlot(entity)) return
    this.store.notifyComponentChange(entity, componentId, 'put')
  }

  private invalidateMaterialsForVideoPlayer(videoPlayerEntity: Entity): void {
    const { Material } = this.ecs
    this.store.forEachSceneEntity((entity) => {
      if (!Material.has(entity)) return
      const pb = Material.get(entity) as PbMaterial
      if (!materialReferencesVideoPlayer(pb, videoPlayerEntity)) return
      this.materials.clearEntity(entity)
      this.pendingMaterialEntities.add(entity)
    })
    void this.runMaterialPass(Material)
  }

  private hydrationPrimeDone = false

  /** Lift the per-frame GLTF spawn cap while `waitForSceneAssets` runs. */
  setAssetHydrationMode(enabled: boolean): void {
    const wasHydration = this.hydrationMode
    this.hydrationMode = enabled
    if (!enabled) this.hydrationPrimeDone = false
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

  /** Scale mesh drain when a large pending queue would otherwise stall GLTF attach + colliders. */
  private meshDrainBudgetMs(): number {
    const base = this.meshPassBudgetMs()
    const pending = this.pendingMeshEntities.size
    if (pending > 200) return Math.max(base, 16)
    if (pending > 50) return Math.max(base, 12)
    return base
  }

  /** Defer texture loads only during the loading-screen hydration burst — not soft GLTF cap. */
  private shouldDeferMaterials(): boolean {
    return this.hydrationMode
  }

  private shouldDeferTextures(): boolean {
    return this.hydrationMode
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
      const visual = this.entityVisualRoot(entity, obj)
      if (visual && this.materials.needsReapply(entity, pb, visual)) this.pendingMaterialEntities.add(entity)
    }
  }

  private entityNeedsMaterialWork(entity: Entity, obj: THREE.Group): boolean {
    const { Material } = this.ecs
    if (!Material.has(entity)) return false
    const visual = this.entityVisualRoot(entity, obj)
    if (!visual) return false
    return this.materials.needsReapply(entity, Material.get(entity) as PbMaterial, visual)
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
      if (isEmoteAnchorGltfSrc(src) && !this.ecs.Animator.has(entity)) {
        if (obj.userData.emoteAnchor) return false
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
      if (obj.userData.animationRig) return false
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
    if (this.cache.hasCached(cacheKey) || this.cache.isResolving(cacheKey)) return 'ready'
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
      // Collider extract runs on the hydration tick (syncCollision), not per attach —
      // per-attach PhysX cook blocked the attach burst on multi-shape trimesh cooks.
      if (attached === 0 && pass > 0) break
    }
  }

  getHydrationStats(view: ProjectionView): SceneHydrationStats {
    const { GltfContainer, Transform } = this.ecs
    const { RootEntity, PlayerEntity, CameraEntity } = view
    let entityCount = 0
    let gltfContainers = 0
    let gltfEntities = 0
    let gltfLoaded = 0
    let gltfAbandoned = 0
    let gltfUnresolved = 0

    const isReserved = (entity: Entity) =>
      entity === RootEntity || entity === PlayerEntity || entity === CameraEntity

    // Count from projection (worker CRDT) — store nodes lag behind during hydration bursts.
    for (const [entity] of view.getEntitiesWith(Transform)) {
      if (isReserved(entity)) continue
      entityCount++
    }

    for (const [entity] of view.getEntitiesWith(GltfContainer)) {
      if (isReserved(entity)) continue
      gltfContainers++

      const src = GltfContainer.get(entity).src?.trim()
      if (!src) continue

      const hash = hashFromSrc(src, this.sceneConfig)
      if (!hash) {
        gltfUnresolved++
        if (!this.loggedUnresolvedSrcs.has(src)) {
          this.loggedUnresolvedSrcs.add(src)
          console.debug('[ThreeBridge] unresolved GltfContainer.src:', src)
        }
        continue
      }

      if (hash.startsWith(GLTF_LOCAL_PREFIX)) continue

      gltfEntities++
      if (this.emptyGltfHashes.has(hash)) {
        gltfAbandoned++
        continue
      }
      const cacheKey = this.gltfCacheKey(hash)
      if (this.cache.hasGivenUp(cacheKey)) {
        gltfAbandoned++
        continue
      }
      const obj = this.store.getNode(entity)
      if (!obj) continue
      const mesh = obj.getObjectByName(meshKey(entity))
      if (mesh && obj.userData.gltfSrcKey === hash && gltfInstanceHasGeometry(mesh)) gltfLoaded++
    }

    const assetStats = this.cache.getLoadStats()
    return {
      entityCount,
      gltfContainers,
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
    prefetchSceneManifestAssets(this.cache, this.sceneConfig)
  }

  /**
   * Start parse for every scene GLTF on the projection — same `load()` path as IDB/memory hits.
   * Manifest prefetch only warms bytes; attach still goes through load → parse → cache → clone.
   */
  private primeGltfParses(
    view: ProjectionView,
    GltfContainer: MirrorComponents['GltfContainer']
  ): void {
    const { RootEntity, PlayerEntity, CameraEntity } = view
    for (const [entity] of view.getEntitiesWith(GltfContainer)) {
      if (entity === RootEntity || entity === PlayerEntity || entity === CameraEntity) continue
      const src = GltfContainer.get(entity).src?.trim()
      if (!src) continue
      const hash = hashFromSrc(src, this.sceneConfig)
      if (!hash || hash.startsWith(GLTF_LOCAL_PREFIX)) continue
      const cacheKey = this.gltfCacheKey(hash)
      if (
        this.cache.hasCached(cacheKey) ||
        this.cache.isResolving(cacheKey) ||
        this.cache.hasGivenUp(cacheKey) ||
        this.emptyGltfHashes.has(hash)
      ) {
        continue
      }
      const url = this.sceneConfig.assetUrl(hash)
      void this.cache.load(url, hash, { quiet: true }).catch(() => {})
    }
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
      skipTransformApply: this.skipTransformApply,
      skipSecondaryNotify: this.skipSpriteSecondaryNotify
    })

    // Hydration full-walk: reconcile transforms / orphan nodes only — never re-touch materials.
    const touchMaterials = this.hydrationMode
    if (this.hydrationMode) {
      if (!this.hydrationPrimeDone) {
        this.primeGltfParses(view, GltfContainer)
        this.hydrationPrimeDone = true
      }
      await this.runHydrationAttachPasses(applied.upserts, meshEcs, deferMaterials, touchMaterials)
      await this.runMaterialPass(Material)
    } else {
      await this.runMeshAttachPass(applied.upserts, meshEcs, deferMaterials, touchMaterials)
    }

    for (const [entity] of this.store.nodes) {
      if (!this.store.isSceneOwned(entity)) continue
      if (!active.has(entity)) {
        if (this.store.isSpritePool(entity) || this.store.isSuspended(entity)) continue
        this.removeEntityNode(entity)
      }
    }
    this.refreshTrackedEntityFlags()
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
  /** Drain deferred mesh work when the projection diff is empty — materials use sync-frame tickDeferredMaterials. */
  async drainPendingWork(): Promise<void> {
    if (!this.pendingMeshEntities.size) return
    const { MeshRenderer, Material, GltfContainer, TextShape } = this.ecs
    const meshEcs = { MeshRenderer, Material, GltfContainer, TextShape }
    const deferMaterials = this.shouldDeferMaterials()
    await this.runDiffMeshPass(meshEcs, deferMaterials)
  }

  async consumeDiff(
    diff: Map<Entity, Map<number, ProjectionChangeKind>>,
    view: ProjectionView,
    tweenRefresh: Entity[] = []
  ): Promise<void> {
    if (!diff.size) return
    this.gltfBudgetRemaining = this.resolveGltfBudget()
    const { MeshRenderer, Material, GltfContainer, TextShape, Billboard, AvatarAttach } = this.ecs
    const meshEcs = { MeshRenderer, Material, GltfContainer, TextShape }
    const deferMaterials = this.shouldDeferMaterials()

    this.primeSpritePoolSlotsFromDiff(diff, view, MeshRenderer)

    const filteredTween = tweenRefresh.filter(
      (entity) => !AvatarAttach.has(entity) && !this.skipTransformApply?.(entity)
    )

    const applied = applySceneDiff(
      this.store,
      diff,
      view,
      this.ecs,
      filteredTween,
      this.sceneDiffOptions()
    )

    this.syncBillboardFlagsFromDiff(diff, Billboard)
    for (const entity of applied.upserts) {
      if (Billboard.has(entity)) this.store.setBillboard(entity, true)
    }

    for (const entity of applied.removals) {
      if (this.isSpritePoolEntity(entity) || (this.store.isSpritePool(entity) && this.store.isSuspended(entity))) {
        this.suspendSpriteSlot(entity)
      } else {
        this.removeEntityNode(entity)
      }
    }
    for (const entity of applied.meshDirty) {
      this.pendingMeshEntities.add(entity)
      this.trackSpritePoolEntity(entity)
      if (Material.has(entity)) {
        const pb = Material.get(entity) as PbMaterial
        const obj = this.store.nodes.get(entity)
        const visual = obj ? this.entityVisualRoot(entity, obj) : null
        if (visual && this.materials.needsReapply(entity, pb, visual)) this.pendingMaterialEntities.add(entity)
      }
    }

    await this.runDiffMeshPass(meshEcs, deferMaterials)
    for (const entity of applied.meshDirty) this.applyAnimatedPlaneUvs(entity)
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
    const budgetMs = this.meshDrainBudgetMs()
    for (const entity of ordered) {
      if (performance.now() - passStart >= budgetMs) break
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

  /** Register sprite slots before applySceneDiff so DELETE_ENTITY skips collider/pointer notifies. */
  private primeSpritePoolSlotsFromDiff(
    diff: Map<Entity, Map<number, ProjectionChangeKind>>,
    view: ProjectionView,
    MeshRenderer: MirrorComponents['MeshRenderer']
  ): void {
    for (const [entity, comps] of diff) {
      if (this.isReservedSceneEntity(entity, view)) continue
      if (this.store.isSpritePool(entity)) continue
      const meshChange = comps.get(MeshRenderer.componentId)
      if (meshChange !== 'put') continue
      if (this.isSpritePoolEntity(entity)) this.store.setSpritePool(entity, true)
    }
  }

  private trackSpritePoolEntity(entity: Entity): void {
    this.store.setSpritePool(entity, this.isSpritePoolEntity(entity))
  }

  /** Drop interactive animated planes (plants) that were never sprite-pool candidates. */
  private pruneMisclassifiedSpriteSlots(): void {
    this.store.forEachSpritePool((entity) => {
      if (!this.isSpritePoolEntity(entity)) this.store.setSpritePool(entity, false)
    })
  }

  private syncBillboardFlagsFromDiff(
    diff: Map<Entity, Map<number, ProjectionChangeKind>>,
    Billboard: MirrorComponents['Billboard']
  ): void {
    for (const [entity, comps] of diff) {
      const change = comps.get(Billboard.componentId)
      if (change === 'put') this.store.setBillboard(entity, true)
      else if (change === 'delete') this.store.setBillboard(entity, false)
    }
  }

  /** Reconcile billboard tracked flags from live ECS (hydration + post-diff). */
  reconcileBillboardFlags(): void {
    const { Billboard } = this.ecs
    this.store.forEachSceneEntity((entity) => {
      this.store.setBillboard(entity, Billboard.has(entity))
    })
  }

  /** Hydration full-walk — reconcile billboard tracked set after bulk spawn. */
  private refreshTrackedEntityFlags(): void {
    this.reconcileBillboardFlags()
  }

  private applyAnimatedPlaneUvs(entity: Entity): void {
    const { MeshRenderer } = this.ecs
    if (!MeshRenderer.has(entity)) return
    const spec = MeshRenderer.get(entity)
    const planeUvsEarly = spec.mesh?.$case === 'plane' ? spec.mesh.plane?.uvs : undefined
    if (!planeUvsEarly || planeUvsEarly.length < 8) return
    const obj = this.store.nodes.get(entity)
    if (!obj) return

    const mk = meshKey(entity)
    const primitive = obj.getObjectByName(mk) as THREE.Mesh | undefined
    if (!primitive?.isMesh) return

    const key = primitiveMeshKey(spec)
    if (primitive.userData.primitiveMeshKey === key) return
    if (updatePlaneGeometryUvs(primitive.geometry, planeUvsEarly)) {
      primitive.userData.primitiveMeshKey = key
    }
  }

  /**
   * Hot path — only tracked sprite planes, not every MeshRenderer in Genesis.
   * Runs on the sync frame so UV updates are not gated behind async syncRenderer.
   */
  syncAnimatedPlaneUvs(): void {
    this.store.forEachSpritePool((entity) => {
      if (!this.isSpritePoolEntity(entity)) {
        this.store.setSpritePool(entity, false)
        return
      }
      this.applyAnimatedPlaneUvs(entity)
    })
  }

  private materialTickBusy = false

  /** Retry deferred sprite/material textures without blocking the render loop. */
  tickDeferredMaterials(budgetMs = 8, maxEntities = 8): void {
    if (this.materialTickBusy) return
    if (!this.pendingMaterialEntities.size) return
    // After hydration, apply deferred textures even if the global defer gate is still set.
    const deferTextures = this.shouldDeferTextures() && this.hydrationMode
    if (deferTextures) return
    this.materialTickBusy = true
    void this.runMaterialPass(this.ecs.Material, budgetMs, maxEntities, deferTextures)
      .catch((err) => console.warn('[ThreeBridge] deferred material pass failed', err))
      .finally(() => {
        this.materialTickBusy = false
      })
  }

  /** Budgeted full material apply for entities queued during hydration defer. */
  private async runMaterialPass(
    Material: MirrorComponents['Material'],
    budgetMs = this.meshPassBudgetMs(),
    maxEntities = Number.POSITIVE_INFINITY,
    deferTextures = this.shouldDeferTextures() && this.hydrationMode
  ): Promise<void> {
    if (!this.pendingMaterialEntities.size) return
    const passStart = performance.now()
    let processed = 0

    // FIFO — avoid O(n log n) mesh traversals in the sort comparator every drain pass.
    const ordered = [...this.pendingMaterialEntities]

    for (const entity of ordered) {
      if (processed >= maxEntities) break
      if (performance.now() - passStart >= budgetMs) break
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
        if (!this.materials.needsReapply(entity, pb, visual)) this.pendingMaterialEntities.delete(entity)
        continue
      }
      await this.materials.applyToObject3D(visual, entity, pb)
      this.notifyMeshComponent(entity, Material.componentId)
      if (!this.materials.needsReapply(entity, pb, visual)) this.pendingMaterialEntities.delete(entity)
      processed++
    }
  }

  /**
   * DCL sprite pool — hide visuals and keep the EntityStore node across DELETE_ENTITY
   * so recycled ids do not emit store destroy/create (avoids collider + pointer full walks).
   */
  private suspendSpriteSlot(entity: Entity): void {
    if (!this.store.isSceneOwned(entity)) return
    this.store.suspendSceneEntity(entity)
    this.pendingMeshEntities.delete(entity)
    this.pendingMaterialEntities.delete(entity)
    const obj = this.store.getNode(entity)
    if (!obj) return
    this.removeEntityVisuals(entity, obj)
  }

  /** Build or UV-patch a sprite plane synchronously — never notifies collision/pointer. */
  private syncSpritePlaneVisual(
    entity: Entity,
    Material: MirrorComponents['Material'],
    touchMaterials: boolean
  ): void {
    const { MeshRenderer } = this.ecs
    if (!MeshRenderer.has(entity)) return
    const obj = this.store.getNode(entity)
    if (!obj) return

    const spec = MeshRenderer.get(entity)
    const mk = meshKey(entity)
    const key = primitiveMeshKey(spec)
    const planeUvs = spec.mesh?.$case === 'plane' ? spec.mesh.plane?.uvs : undefined
    let primitive = obj.getObjectByName(mk) as THREE.Mesh | undefined

    if (
      primitive?.isMesh &&
      primitive.userData.primitiveMeshKey !== key &&
      planeUvs?.length &&
      updatePlaneGeometryUvs(primitive.geometry, planeUvs)
    ) {
      primitive.userData.primitiveMeshKey = key
    } else if (!primitive?.isMesh || primitive.userData.primitiveMeshKey !== key) {
      if (primitive) {
        primitive.geometry.dispose()
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
      primitive.userData.entity = entity
      obj.add(primitive)
      this.notifyMeshComponent(entity, MeshRenderer.componentId)
    }

    if (!touchMaterials || !Material.has(entity) || !primitive?.isMesh) return
    const pb = Material.get(entity) as PbMaterial
    if (this.materials.needsReapply(entity, pb, primitive)) {
      this.materials.applyScalarsToObject3D(primitive, entity, pb)
      this.pendingMaterialEntities.add(entity)
    }
  }

  /** Texture apply for campfire pool — never notifies collision/pointer. */
  private async runSpriteMaterialPass(
    entities: Entity[],
    Material: MirrorComponents['Material']
  ): Promise<void> {
    for (const entity of entities) {
      if (!this.store.isSpritePool(entity) || !Material.has(entity)) continue
      const obj = this.store.getNode(entity)
      if (!obj) continue
      const visual = this.entityVisualRoot(entity, obj)
      if (!visual) continue
      const pb = Material.get(entity) as PbMaterial
      if (!this.materials.needsReapply(entity, pb, visual)) {
        this.pendingMaterialEntities.delete(entity)
        continue
      }
      await this.materials.applyToObject3D(visual, entity, pb)
      if (!this.materials.needsReapply(entity, pb, visual)) {
        this.pendingMaterialEntities.delete(entity)
      }
    }
  }

  private removeEntityNode(entity: Entity): void {
    if (!this.store.isSceneOwned(entity)) return
    this.pendingMeshEntities.delete(entity)
    this.pendingMaterialEntities.delete(entity)
    this.store.setSpritePool(entity, false)
    this.store.setBillboard(entity, false)
    this.store.setTween(entity, false)
    const obj = this.store.getNode(entity)
    if (!obj) return
    this.materials.clearEntity(entity)
    this.videoPlayerBridge?.disposeEntity(entity)
    this.audioSourceBridge?.disposeEntity(entity)
    this.audioStreamBridge?.disposeEntity(entity)
    this.removeEntityVisuals(entity, obj)
    this.store.deleteEntity(entity)
  }

  /** Tear down bridge-owned resources (entity graph cleared via `EntityStore.dispose`). */
  dispose(): void {
    this.videoPlayerBridge?.dispose()
    this.videoPlayerBridge = null
    this.audioSourceBridge?.dispose()
    this.audioSourceBridge = null
    this.audioStreamBridge?.dispose()
    this.audioStreamBridge = null
    this.pendingMeshEntities.clear()
    this.pendingMaterialEntities.clear()
  }

  private removeEntityVisuals(entity: Entity, obj: THREE.Group): void {
    const mk = meshKey(entity)
    const tk = textKey(entity)
    const lk = lightKey(entity)
    const pk = particleKey(entity)
    for (const name of [mk, tk, pk]) {
      const child = obj.getObjectByName(name)
      if (!child) continue
      if (name === tk) disposeTextShapeMesh(child)
      else if (name === pk && (child as THREE.Mesh).isMesh) {
        const mesh = child as THREE.Mesh
        mesh.geometry.dispose()
        const mat = mesh.material
        if (Array.isArray(mat)) mat.forEach((m) => m.dispose())
        else mat.dispose()
      } else disposeOwnedObject3D(child)
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

      if (!hash) return

      if (!mesh || obj.userData.gltfSrcKey !== srcKey) {
        if (mesh) {
          disposeOwnedObject3D(mesh)
          obj.remove(mesh)
        }

        const isLocal = hash.startsWith(GLTF_LOCAL_PREFIX)
        const url = isLocal ? hash.slice(GLTF_LOCAL_PREFIX.length) : this.sceneConfig.assetUrl(hash)

        if (this.gltfBudgetRemaining <= 0) return

        this.gltfBudgetRemaining--
        try {
          // Single pipeline for cold / IDB / memory: clone → load → bytes (prefetch/IDB/network) → parse → cache.
          const clone = await this.cache.clone(url, isLocal ? url : hash, { sceneGltf: true })
          obj.userData.gltfSrcKey = srcKey
          const hasGeometry = gltfInstanceHasGeometry(clone)
          if (!hasGeometry) {
            const wantsAnimatorRig = this.ecs.Animator.has(entity)
            if (wantsAnimatorRig) {
              const cached = await this.cache.load(url, isLocal ? url : hash)
              if (cached.animations.length > 0) {
                clone.name = mk
                hideGltfRenderMeshes(clone)
                obj.userData.animationRig = true
                obj.add(clone)
                mesh = clone
                this.notifyMeshComponent(entity, GltfContainer.componentId)
                this.notifyGltfAttached(entity)
                return
              }
            }
            if (isEmoteAnchorGltfSrc(src)) {
              this.gltfBudgetRemaining++
              this.emptyGltfHashes.add(hash)
              disposeOwnedObject3D(clone)
              const anchor = new THREE.Group()
              anchor.name = mk
              obj.userData.emoteAnchor = true
              obj.add(anchor)
              mesh = anchor
              this.notifyMeshComponent(entity, GltfContainer.componentId)
              return
            }
            this.gltfBudgetRemaining++
            this.emptyGltfHashes.add(hash)
            disposeOwnedObject3D(clone)
            if (!this.loggedEmptyGltfSrcs.has(src)) {
              this.loggedEmptyGltfSrcs.add(src)
              console.warn('[ThreeBridge] GLB has no renderable geometry — skipping', src)
            }
            return
          }
          clone.name = mk
          if (isEmoteAnchorGltfSrc(src) && !this.ecs.Animator.has(entity)) {
            hideGltfRenderMeshes(clone)
            obj.userData.emoteAnchor = true
          } else {
            syncGltfInstanceRenderState(clone)
            enableMeshReceiveShadow(clone)
          }
          obj.add(clone)
          mesh = clone
          this.notifyMeshComponent(entity, GltfContainer.componentId)
          this.notifyGltfAttached(entity)
          if (isMotionFocusActive() && matchesMotionFocusSrc(src)) {
            const loaded = await this.cache.load(url, isLocal ? url : hash)
            const clipNames = loaded.animations.map((c) => c.name)
            clientDebugLog.log(
              'motion',
              `Blimp GLB attached — entity ${entity} · clips [${clipNames.join(', ') || '(none)'}] · ECS Animator ${this.ecs.Animator.has(entity) ? 'yes' : 'no — default auto-play first clip (ArmatureAction propellers)'}`,
              { level: clipNames.length ? 'info' : 'warn', alsoConsole: true }
            )
          }
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

      if (touchMaterials && Material.has(entity) && mesh) {
        const pb = Material.get(entity) as PbMaterial
        if (!this.materials.needsReapply(entity, pb, mesh)) {
          /* material already matches ECS — skip destructive re-apply on hydration full-walk */
        } else if (deferMaterials || this.shouldDeferTextures()) {
          this.pendingMaterialEntities.add(entity)
          this.materials.applyScalarsToObject3D(mesh, entity, pb)
        } else {
          await this.materials.applyToObject3D(mesh, entity, pb)
          this.notifyMeshComponent(entity, Material.componentId)
          if (!this.materials.needsReapply(entity, pb, mesh)) this.pendingMaterialEntities.delete(entity)
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
      this.trackSpritePoolEntity(entity)
      const key = primitiveMeshKey(spec)
      let primitive = obj.getObjectByName(mk) as THREE.Mesh | undefined
      const meshKind = primitiveKind(spec)
      const planeUvs = spec.mesh?.$case === 'plane' ? spec.mesh.plane?.uvs : undefined

      if (
        primitive &&
        (primitive as THREE.Mesh).isMesh &&
        meshKind === 'plane' &&
        primitive.userData.primitiveMeshKey !== key &&
        planeUvs?.length &&
        updatePlaneGeometryUvs(primitive.geometry, planeUvs)
      ) {
        primitive.userData.primitiveMeshKey = key
      } else if (!primitive || !(primitive as THREE.Mesh).isMesh || primitive.userData.primitiveMeshKey !== key) {
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
        if (!this.materials.needsReapply(entity, pb, primitive)) {
          /* material already matches ECS — skip destructive re-apply on hydration full-walk */
        } else if (deferMaterials || this.shouldDeferTextures()) {
          this.pendingMaterialEntities.add(entity)
          this.materials.applyScalarsToObject3D(primitive, entity, pb)
        } else {
          await this.materials.applyToObject3D(primitive, entity, pb)
          this.notifyMeshComponent(entity, Material.componentId)
          if (!this.materials.needsReapply(entity, pb, primitive)) this.pendingMaterialEntities.delete(entity)
        }
      }
    }
  }
}
