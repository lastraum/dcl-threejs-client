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
import { syncGltfInstanceRenderState } from '../collision/gltfRenderMeshes'
import type { MirrorComponents } from './mirrorComponents'
import type { ProjectionChangeKind } from './CrdtProjection'
import { removeLightSource } from './LightSourceSync'
import {
  buildTextShapeMesh,
  disposeTextShapeMesh,
  textShapeSignature,
  updateTextShapeMesh
} from './TextShapeSync'
import type { SceneHydrationStats } from '../rendering/sceneHydration'
import type { AudioSourceBridge } from '../media/AudioSourceBridge'
import type { AudioStreamBridge } from '../media/AudioStreamBridge'
import type { VideoPlayerBridge } from '../media/VideoPlayerBridge'
import type { EntityStore } from './EntityStore'
import { applySceneDiff, type ApplySceneDiffOptions } from './entityStoreApply'
import { applyDclLocalTransform, resolveTransformParent, type DclTransformValues } from './dclTransform'
import { disposeOwnedObject3D } from '../rendering/sharedAsset'
import { enableSceneGltfVertexColors } from '../rendering/LandscapeAssetSanitizer'
import { applySceneGltfEmissives } from '../rendering/sceneGltfEmissives'
import { cloneGltfInstance } from '../rendering/skinnedMeshInstance'
import { SceneGltfInstancer, templateIsInstancable } from '../rendering/SceneGltfInstancer'
import {
  applyGltfNodeModifiersToEntity,
  gltfNodeModifiersReferenceVideo,
  restoreGltfNodeModifierOriginals
} from './GltfNodeModifiersSync'
import type { PBGltfNodeModifiers } from '@dcl/ecs/dist/components/generated/pb/decentraland/sdk/components/gltf_node_modifiers.gen'

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

/** Per-src hash memo — uncached resolve is O(content map) and was ~4.7s for 3k pending/frame. */
const hashFromSrcCache = new WeakMap<ResolvedScene, Map<string, string | null>>()

function hashFromSrc(src: string, scene: ResolvedScene): string | null {
  let map = hashFromSrcCache.get(scene)
  if (!map) {
    map = new Map()
    hashFromSrcCache.set(scene, map)
  }
  const key = src.trim()
  if (map.has(key)) return map.get(key)!
  const hash = resolveGltfSrcHash(scene.content, key)
  map.set(key, hash)
  return hash
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

/** GltfContainer / MeshRenderer default: cast + receive (Unity MeshRenderer + material.proto cast_shadows=true). */
function enableMeshShadows(root: THREE.Object3D): void {
  root.traverse((child) => {
    if (!(child as THREE.Mesh).isMesh) return
    const mesh = child as THREE.Mesh
    mesh.castShadow = true
    mesh.receiveShadow = true
  })
}

function countObjectTriangles(root: THREE.Object3D): number {
  let tris = 0
  root.traverse((obj) => {
    if (!(obj as THREE.Mesh).isMesh) return
    const geom = (obj as THREE.Mesh).geometry
    if (!geom) return
    const idx = geom.index
    if (idx) tris += idx.count / 3
    else {
      const pos = geom.getAttribute('position')
      if (pos) tris += pos.count / 3
    }
  })
  return tris
}

/** Sync mirror ECS state → Three.js scene graph (Phase 1 + 1b render components). */
export class ThreeBridge {
  /** Runtime attach slots — keep ≤1 heavy unit per play frame (P0 mesh frame law). */
  private static readonly GLTF_BUDGET_PER_FRAME = 1
  private static readonly GLTF_HYDRATION_BUDGET_PER_FRAME = 80
  private static readonly GLTF_SOFT_HYDRATION_BUDGET_PER_FRAME = 1
  private static readonly MESH_PASS_BUDGET_MS = 6
  private static readonly MESH_PASS_HYDRATION_BUDGET_MS = 48
  private static readonly HYDRATION_ATTACH_PASSES = 6
  private static readonly HYDRATION_ATTACH_TOTAL_MS = 72
  /**
   * P0 frame law (not streaming): SkeletonUtils.clone of large templates can take seconds.
   * Those attach via a serial idle queue so rAF/UI stay alive. Scene still gets every entity.
   * Always applied (including hydration) — one unbounded clone freezes the whole frame.
   */
  private static readonly LARGE_TEMPLATE_TRIS = 80_000
  /** rAF frames to yield after each large clone before the next (keeps select UI alive). */
  private static readonly LARGE_ATTACH_YIELD_FRAMES = 3

  private readonly store: EntityStore
  /** Phase 2 — entities whose GLB/mesh/material still needs an attach pass (budgeted, retried). */
  private readonly pendingMeshEntities = new Set<Entity>()
  /** Entities with a Material component still needing full texture apply after hydration defer. */
  private readonly pendingMaterialEntities = new Set<Entity>()
  /** Entities with GltfNodeModifiers pending apply (video screens on GLB meshes). */
  private readonly pendingGltfNodeModEntities = new Set<Entity>()
  private readonly materials: MaterialApplier
  private hydrationMode = false
  private readonly loggedUnresolvedSrcs = new Set<string>()
  private softHydrationUntil = 0
  private gltfBudgetRemaining = ThreeBridge.GLTF_BUDGET_PER_FRAME
  private readonly emptyGltfHashes = new Set<string>()
  private readonly loggedEmptyGltfSrcs = new Set<string>()
  private readonly loggedGltfAttachFailures = new Set<string>()
  private onGltfAttached: ((entity: Entity) => void) | null = null
  /** Source-capture sink for host LWW (GltfContainerLoadingState → encoder). */
  private recordLww: ((componentId: number, entity: Entity, value: unknown) => void) | null = null
  /** entity → last LoadingState written (dirty-only; avoids CREATE spam). */
  private readonly gltfLoadingStates = new Map<Entity, number>()
  private videoPlayerBridge: VideoPlayerBridge | null = null
  private audioSourceBridge: AudioSourceBridge | null = null
  private audioStreamBridge: AudioStreamBridge | null = null
  private skipTransformApply?: (entity: Entity) => boolean
  /** Live player/camera roots for Transform.parent = PlayerEntity / CameraEntity. */
  private reservedTransformAnchors: import('./dclTransform').ReservedTransformAnchors | null =
    null
  /** Dedup idle parse kicks (content-map never bulk-parsed; per-entity only). */
  private readonly loadScheduled = new Set<string>()
  /** Serial large-clone queue — never run multiple multi-second clones back-to-back. */
  private readonly largeAttachQueue: Entity[] = []
  private readonly largeAttachQueued = new Set<Entity>()
  private largeAttachDraining = false
  private attachedSceneGltfCount = 0
  private attachedSceneTris = 0
  /**
   * Pending-mesh drain cursor — NEVER full-scan thousands of pending entities per frame.
   * Smoke showed gltfAttach=1/3365 with renderer≈4.7s from O(pending×content) hash walks.
   */
  private pendingMeshCursor = 0
  /** Sample size when grouping pending by hash (not a hard full-set walk every frame). */
  private static readonly MESH_DRAIN_HASH_SAMPLE = 512
  private static readonly MESH_DRAIN_HARD_MS = 10
  /** Ready instance/clone attaches per drain — tiles share hash and are cheap. */
  private static readonly MESH_DRAIN_MAX_ATTACH = 64
  /** Unique cold hashes to kick parse on per drain (diversity before mass tiles). */
  private static readonly MESH_DRAIN_MAX_COLD_HASHES = 4
  private readonly instancer: SceneGltfInstancer

  constructor(
    private readonly sceneConfig: ResolvedScene,
    private readonly cache: AssetCache,
    store: EntityStore,
    private readonly ecs: MirrorComponents
  ) {
    this.store = store
    this.materials = new MaterialApplier(sceneConfig, cache)
    this.instancer = new SceneGltfInstancer(() => this.store.root)
  }

  /**
   * Transform CRDT / Tween motion hits per instanced entity — sustained motion promotes
   * to a private clone so hierarchy TRS drives the mesh (death coins bob/spin, projectiles).
   * Static multi-instance tiles only get 1–2 puts and stay on GPU InstancedMesh.
   */
  private readonly instanceMotionHits = new Map<Entity, number>()
  private static readonly INSTANCE_MOTION_PROMOTE_HITS = 3

  /** After Transform apply — refresh GPU instance matrices for instanced GltfContainers. */
  syncInstancedTransforms(entities: Iterable<Entity>): void {
    const toUpdate: Entity[] = []
    for (const entity of entities) {
      if (!this.instancer.has(entity)) {
        this.instanceMotionHits.delete(entity)
        continue
      }
      const hits = (this.instanceMotionHits.get(entity) ?? 0) + 1
      this.instanceMotionHits.set(entity, hits)
      // Script-animated props (Transform.getMutable every tick / continuous Tween) —
      // private clone follows the entity group without relying on per-frame instance rewrites.
      if (hits >= ThreeBridge.INSTANCE_MOTION_PROMOTE_HITS) {
        const obj = this.store.nodes.get(entity)
        if (obj) this.promoteInstancedForMotion(entity, obj)
        continue
      }
      toUpdate.push(entity)
    }
    if (toUpdate.length) this.instancer.updateEntities(toUpdate, this.store.nodes)
  }

  /**
   * Drop InstancedMesh slot and re-queue as SkeletonUtils clone — motion-driven props
   * (collectible bob/spin, flying projectiles) need hierarchy tracking, not static instances.
   */
  private promoteInstancedForMotion(entity: Entity, obj: THREE.Group): void {
    this.instancer.detach(entity, obj)
    this.instanceMotionHits.delete(entity)
    delete obj.userData.dclInstanced
    delete obj.userData.gltfSrcKey
    delete obj.userData.dclForceIdleAttach
    obj.userData.dclForceCloneAttach = true
    this.pendingMeshEntities.add(entity)
  }

  /**
   * Entities with Transform.parent = PlayerEntity / CameraEntity.
   * Maintained on CRDT apply — do NOT scan all Transforms every frame.
   */
  private readonly reservedParentedEntities = new Set<Entity>()

  /** Note a reserved parent from CRDT apply (or full reconcile). */
  noteReservedParentedEntity(entity: Entity, parent: Entity | undefined, view: ProjectionView): void {
    if (
      parent === view.PlayerEntity ||
      parent === view.CameraEntity
    ) {
      this.reservedParentedEntities.add(entity)
    } else {
      this.reservedParentedEntities.delete(entity)
    }
  }

  /**
   * Re-parent the reserved-parent set under live player/camera roots.
   * Always re-apply local pose: gun aim mutates PE-child rotation every frame and
   * applySceneDiff can lag a tick behind; without this the mesh freezes/detaches.
   */
  syncReservedParentedTransforms(view: ProjectionView): void {
    this.lastReservedParentView = view
    const anchors = this.reservedTransformAnchors
    if (!anchors) return

    // Weapons equip mid-match — catch PE parents that arrived without a CRDT note.
    this.reservedRescanCounter++
    if (this.reservedRescanCounter % 45 === 0) {
      this.collectReservedParented(view)
    }

    if (this.reservedParentedEntities.size === 0) return

    const { Transform } = this.ecs
    const { PlayerEntity, CameraEntity } = view
    let reparented = 0
    const needChildFix: Entity[] = []
    for (const entity of this.reservedParentedEntities) {
      if (!Transform.has(entity)) {
        this.reservedParentedEntities.delete(entity)
        continue
      }
      const t = Transform.get(entity) as DclTransformValues
      const parent = t.parent as Entity | undefined
      if (parent !== PlayerEntity && parent !== CameraEntity) {
        this.reservedParentedEntities.delete(entity)
        continue
      }
      // Transform-only PE roots (weapon holster) must get a node even before a child GLB lands.
      const obj = this.store.getOrCreateNode(entity)
      const desired = resolveTransformParent(
        parent,
        view,
        this.store.nodes,
        this.store.root,
        anchors
      )
      if (obj.parent !== desired) {
        desired.add(obj)
        reparented++
        needChildFix.push(entity)
      }
      if (!this.skipTransformApply?.(entity)) {
        applyDclLocalTransform(obj, t)
      }
    }

    // Holster children (gun model under gun root) — only after a real PE reparent, not every rescan
    // (full Transform walk is O(entities) and large scenes already pay enough per frame).
    if (needChildFix.length > 0) {
      for (const entity of needChildFix) {
        this.ensureDirectChildrenParented(entity, view)
      }
    }

    if (reparented > 0 && !this.loggedPeWeaponAttach) {
      this.loggedPeWeaponAttach = true
      const root = anchors.getPlayerRoot()
      console.info(
        `[attach] PE-parented ×${this.reservedParentedEntities.size} → ` +
          `playerRoot=${root ? root.name || 'root' : 'null'} reparented=${reparented}`
      )
    }
  }

  private reservedRescanCounter = 0

  /** Scan Transforms for parent = PlayerEntity / CameraEntity. */
  private collectReservedParented(view: ProjectionView): void {
    const { Transform } = this.ecs
    for (const [entity, t] of view.getEntitiesWith(Transform)) {
      if (entity === view.RootEntity || entity === view.PlayerEntity || entity === view.CameraEntity) {
        continue
      }
      const parent = (t as DclTransformValues).parent as Entity | undefined
      this.noteReservedParentedEntity(entity, parent, view)
    }
  }

  /**
   * After a PE holster moves under the player root, re-parent direct Transform children
   * (weapon mesh entity) so they do not stay on sceneRoot from an earlier orphan apply.
   */
  private ensureDirectChildrenParented(parentEntity: Entity, view: ProjectionView): void {
    const parentNode = this.store.nodes.get(parentEntity)
    if (!parentNode) return
    const { Transform } = this.ecs
    for (const [entity, t] of view.getEntitiesWith(Transform)) {
      if ((t as DclTransformValues).parent !== parentEntity) continue
      const obj = this.store.getOrCreateNode(entity)
      if (obj.parent !== parentNode) {
        parentNode.add(obj)
      }
      if (!this.skipTransformApply?.(entity)) {
        applyDclLocalTransform(obj, t as DclTransformValues)
      }
    }
  }

  /** One-shot when player root becomes available (initCapsule) — fix early CRDT parents. */
  reparentAllReservedParented(view: ProjectionView): void {
    this.reservedParentedEntities.clear()
    this.collectReservedParented(view)
    this.syncReservedParentedTransforms(view)
  }

  /** Full instanced world-matrix rewrite (post-hydration / hierarchy seal). */
  refreshAllInstancedTransforms(): void {
    this.store.root.updateMatrixWorld(true)
    this.instancer.updateAll(this.store.nodes)
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

  setReservedTransformAnchors(
    anchors: import('./dclTransform').ReservedTransformAnchors | null,
    view?: ProjectionView
  ): void {
    this.reservedTransformAnchors = anchors
    // Anchors usually appear after first player-parent CRDT — one full pass, not per-frame scan.
    if (anchors && view) this.reparentAllReservedParented(view)
  }

  private sceneDiffOptions(extra?: Partial<ApplySceneDiffOptions>): ApplySceneDiffOptions {
    return {
      skipTransformApply: this.skipTransformApply,
      skipSecondaryNotify: this.skipSpriteSecondaryNotify,
      reservedAnchors: this.reservedTransformAnchors,
      onReservedParent: (entity, parent, view) => {
        this.noteReservedParentedEntity(entity, parent, view)
      },
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

  /** Host LWW capture (GltfContainerLoadingState → CrdtEncoder.recordLww). */
  setRecordLww(fn: ((componentId: number, entity: Entity, value: unknown) => void) | null): void {
    this.recordLww = fn
  }

  /** Skip inbound Transform apply for renderer-owned poses (AvatarAttach). */
  setSkipTransformApply(fn: ((entity: Entity) => boolean) | null): void {
    this.skipTransformApply = fn ?? undefined
  }

  /**
   * ADR-215 GltfContainerLoadingState — renderer-owned LWW for scene loading UIs.
   * LoadingState: UNKNOWN=0 LOADING=1 NOT_FOUND=2 FINISHED_WITH_ERROR=3 FINISHED=4
   */
  private setGltfLoadingState(entity: Entity, currentState: number): void {
    if (this.gltfLoadingStates.get(entity) === currentState) return
    this.gltfLoadingStates.set(entity, currentState)
    const value = { currentState }
    const def = this.ecs.GltfContainerLoadingState
    try {
      def.createOrReplace(entity, value)
    } catch {
      /* component may be absent on early dispose */
    }
    this.recordLww?.(def.componentId, entity, value)
  }

  private clearGltfLoadingState(entity: Entity): void {
    this.gltfLoadingStates.delete(entity)
  }

  private notifyGltfAttached(entity: Entity): void {
    this.setGltfLoadingState(entity, 4 /* FINISHED */)
    // Video screens (and other overrides) often land before/with GltfContainer — re-apply.
    if (this.ecs.GltfNodeModifiers.has(entity)) {
      this.pendingGltfNodeModEntities.add(entity)
      void this.runGltfNodeModifiersPass()
    }
    // PE/Camera-parented roots often get Gltf on a child after the first CRDT parent pass —
    // re-walk reserved parents so the mesh follows the live player/camera root.
    this.reparentReservedChainAfterMesh(entity)
    try {
      this.onGltfAttached?.(entity)
    } catch (err) {
      console.warn('[ThreeBridge] post-GLB collider sync failed', entity, err)
    }
  }

  /**
   * After a GLB attaches, ensure PE/Camera-parented ancestors (and this entity) sit under
   * the live player/camera roots. Without this, PE-child weapons stay on sceneRoot at a
   * local offset while muzzle math still tracks the player (bullets without a visible gun).
   */
  private reparentReservedChainAfterMesh(entity: Entity): void {
    const view = this.lastReservedParentView
    if (!view || !this.reservedTransformAnchors) return
    const { Transform } = this.ecs
    let walk: Entity | undefined = entity
    const seen = new Set<Entity>()
    let peParented = false
    while (walk !== undefined && !seen.has(walk)) {
      seen.add(walk)
      if (!Transform.has(walk)) break
      const t = Transform.get(walk) as DclTransformValues
      const parent = t.parent as Entity | undefined
      this.noteReservedParentedEntity(walk, parent, view)
      if (parent === view.PlayerEntity || parent === view.CameraEntity) {
        peParented = true
        break
      }
      if (!parent || parent === view.RootEntity || parent === 0) break
      walk = parent
    }
    this.syncReservedParentedTransforms(view)
    if (peParented) {
      // gunModel GLB under gun holster — force child reparent once mesh lands.
      let holster: Entity | undefined = entity
      const { Transform } = this.ecs
      while (holster !== undefined && Transform.has(holster)) {
        const p = (Transform.get(holster) as DclTransformValues).parent as Entity | undefined
        if (p === view.PlayerEntity || p === view.CameraEntity) {
          this.ensureDirectChildrenParented(holster, view)
          break
        }
        if (!p || p === view.RootEntity || p === 0) break
        holster = p
      }
    }
  }

  private loggedPeWeaponAttach = false

  /** Last view passed to reserved-parent sync (for late GLB reparent). */
  private lastReservedParentView: ProjectionView | null = null

  private notifyMeshComponent(entity: Entity, componentId: number): void {
    if (this.isAnimatedSpriteSlot(entity)) return
    this.store.notifyComponentChange(entity, componentId, 'put')
  }

  private invalidateMaterialsForVideoPlayer(videoPlayerEntity: Entity): void {
    const { Material, GltfNodeModifiers } = this.ecs
    this.store.forEachSceneEntity((entity) => {
      if (Material.has(entity)) {
        const pb = Material.get(entity) as PbMaterial
        if (materialReferencesVideoPlayer(pb, videoPlayerEntity)) {
          this.materials.clearEntity(entity)
          this.pendingMaterialEntities.add(entity)
        }
      }
      // Creator Hub video screens put videoTexture on GltfNodeModifiers, not Material.
      if (GltfNodeModifiers.has(entity)) {
        const mods = GltfNodeModifiers.get(entity) as PBGltfNodeModifiers
        if (gltfNodeModifiersReferenceVideo(mods, videoPlayerEntity)) {
          this.pendingGltfNodeModEntities.add(entity)
        }
      }
    })
    void this.runMaterialPass(Material)
    void this.runGltfNodeModifiersPass()
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
    const { Material, GltfNodeModifiers } = this.ecs
    for (const [entity, obj] of this.store.nodes) {
      if (!this.store.isSceneOwned(entity)) continue
      if (Material.has(entity)) {
        if (!this.entityVisualRoot(entity, obj)) continue
        const pb = Material.get(entity) as PbMaterial
        const visual = this.entityVisualRoot(entity, obj)
        if (visual && this.materials.needsReapply(entity, pb, visual)) this.pendingMaterialEntities.add(entity)
      }
      if (GltfNodeModifiers.has(entity)) {
        this.pendingGltfNodeModEntities.add(entity)
      }
    }
  }

  private entityNeedsMaterialWork(entity: Entity, obj: THREE.Group): boolean {
    const { Material } = this.ecs
    if (!Material.has(entity)) return false
    const visual = this.entityVisualRoot(entity, obj)
    if (!visual) return false
    return this.materials.needsReapply(entity, Material.get(entity) as PbMaterial, visual)
  }

  /**
   * Whether pending mesh drain should call syncMeshSync.
   *
   * Presence-only checks miss LWW field updates (TextShape text, Material params).
   * Audit (keep in sync when adding mesh components):
   * - GltfContainer: content hash / geometry readiness
   * - TextShape: textShapeSignature (text/style) — not just missing mesh child
   * - MeshRenderer: primitiveMeshKey includes kind + UV fingerprint
   * - Material: materials.needsReapply (separate pendingMaterial queue)
   * - NftShape: not drained here (no mesh attach path yet)
   */
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
      if (obj.userData.dclInstanced) return false
      return !gltfInstanceHasGeometry(mesh)
    }

    // GltfContainer deleted/hidden teardown — clone under entity OR GPU instance marker.
    // Without this, meshDirty clears pending without ever calling syncMeshSync (ghost coins).
    if (obj.userData.dclInstanced || obj.userData.gltfSrcKey || obj.userData.animationRig) {
      return true
    }
    {
      const orphan = obj.getObjectByName(meshKey(entity))
      if (
        orphan &&
        orphan.userData.primitiveKind === undefined &&
        orphan.userData.primitiveMeshKey === undefined &&
        !MeshRenderer.has(entity)
      ) {
        return true
      }
    }

    // TextShape LWW updates (lobby counts, timers) keep the same mesh child — compare signature.
    if (TextShape.has(entity)) {
      const textMesh = obj.getObjectByName(textKey(entity)) as THREE.Mesh | undefined
      if (!textMesh) return true
      if (textMesh.userData.textShapeSignature !== textShapeSignature(TextShape.get(entity))) {
        return true
      }
    }

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

  /**
   * Kick GLB parse off the rAF path (idle / timeout). Never await from drain.
   * Content-map is NOT bulk-parsed — only hashes the scene actually requests via ECS.
   */
  private scheduleBackgroundLoad(url: string, hash: string, cacheKey: string): void {
    if (this.loadScheduled.has(cacheKey)) return
    if (this.cache.hasCached(cacheKey) || this.cache.isResolving(cacheKey) || this.cache.hasGivenUp(cacheKey)) {
      return
    }
    this.loadScheduled.add(cacheKey)
    const kick = (): void => {
      if (this.cache.hasCached(cacheKey) || this.cache.isResolving(cacheKey) || this.cache.hasGivenUp(cacheKey)) {
        this.loadScheduled.delete(cacheKey)
        return
      }
      void this.cache
        .load(url, hash, { quiet: true })
        .catch(() => {})
        .finally(() => {
          this.loadScheduled.delete(cacheKey)
        })
    }
    const ric = (globalThis as { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => void })
      .requestIdleCallback
    if (typeof ric === 'function') ric(kick, { timeout: 2000 })
    else setTimeout(kick, 48)
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

    // Ready (cached template) before cold (needs parse) so attach work progresses while parses idle.
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
    _deferMaterials: boolean,
    touchMaterials = true
  ): Promise<number> {
    const budgetStart = this.gltfBudgetRemaining
    const meshEntities = this.meshEntitiesForPass(sorted, false)
    const meshPassStart = performance.now()
    for (const entity of meshEntities) {
      if (performance.now() - meshPassStart >= this.meshPassBudgetMs()) break
      const obj = this.store.nodes.get(entity)
      if (!obj) continue
      this.syncMeshSync(entity, obj, meshEcs, touchMaterials)
      if (touchMaterials && this.entityNeedsMaterialWork(entity, obj)) {
        this.pendingMaterialEntities.add(entity)
      }
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
      // Cheap attached check — avoid gltfInstanceHasGeometry full traverse on 3k entities.
      const mesh = obj.getObjectByName(meshKey(entity))
      if (mesh && obj.userData.gltfSrcKey === hash) gltfLoaded++
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

  /** Cheap attach progress for fps logs — no full projection walk. */
  getAttachProgressLite(): { attached: number; pendingMesh: number; sceneTris: number } {
    return {
      attached: this.attachedSceneGltfCount,
      pendingMesh: this.pendingMeshEntities.size,
      sceneTris: this.attachedSceneTris
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

    const applied = applySceneDiff(
      this.store,
      fullDiff,
      view,
      this.ecs,
      [],
      this.sceneDiffOptions({ notifySecondary: false })
    )

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
    const consumeStart = performance.now()
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
    const { GltfNodeModifiers } = this.ecs
    for (const entity of applied.meshDirty) {
      this.pendingMeshEntities.add(entity)
      this.trackSpritePoolEntity(entity)
      if (Material.has(entity)) {
        const pb = Material.get(entity) as PbMaterial
        const obj = this.store.nodes.get(entity)
        const visual = obj ? this.entityVisualRoot(entity, obj) : null
        if (visual && this.materials.needsReapply(entity, pb, visual)) this.pendingMaterialEntities.add(entity)
      }
      if (GltfNodeModifiers.has(entity)) {
        this.pendingGltfNodeModEntities.add(entity)
      }
    }

    // Cap UV pass — mass meshDirty (3k+) must not walk every entity every frame.
    const uvBudgetEnd = consumeStart + 4
    let uvN = 0
    for (const entity of applied.meshDirty) {
      if (uvN >= 64 || performance.now() >= uvBudgetEnd) break
      this.applyAnimatedPlaneUvs(entity)
      uvN++
    }

    // Instanced GltfContainers live outside entity groups — refresh matrices after pose apply.
    this.instancer.updateEntities(applied.upserts, this.store.nodes)

    await this.runDiffMeshPass(meshEcs, deferMaterials)
    // Do not await texture loads here — one PNG decode was ~3s and froze the async frame.
    // tickDeferredMaterials (sync rAF) drains pendingMaterialEntities with a hard ms budget.
  }

  /** Resolve GltfContainer content key for drain grouping (null = non-gltf / unresolved). */
  private gltfDrainKey(entity: Entity): {
    hash: string
    cacheKey: string
    url: string
    ready: boolean
  } | null {
    const { GltfContainer } = this.ecs
    if (!GltfContainer.has(entity)) return null
    const src = GltfContainer.get(entity).src?.trim()
    if (!src) return null
    const hash = hashFromSrc(src, this.sceneConfig)
    if (!hash || hash.startsWith(GLTF_LOCAL_PREFIX)) return null
    if (this.emptyGltfHashes.has(hash)) return null
    const isLocal = hash.startsWith(GLTF_LOCAL_PREFIX)
    const url = isLocal ? hash.slice(GLTF_LOCAL_PREFIX.length) : this.sceneConfig.assetUrl(hash)
    const cacheKey = this.gltfCacheKey(isLocal ? url : hash)
    if (this.cache.hasGivenUp(cacheKey)) return null
    return {
      hash,
      cacheKey,
      url,
      ready: this.cache.hasCached(cacheKey)
    }
  }

  /**
   * Budgeted attach pass — group pending by content hash (structural, not product priority).
   *
   * Only invents: (1) sample + time budget, (2) at most one cold kick **per hash** (so 2k
   * tile entities do not re-request the same parse 2k times), (3) batch attach when ready.
   * No “characters first” / rarity ranking — discovery order from the ring sample.
   */
  private async runDiffMeshPass(
    meshEcs: Pick<MirrorComponents, 'MeshRenderer' | 'Material' | 'GltfContainer' | 'TextShape'>,
    _deferMaterials: boolean
  ): Promise<void> {
    if (!this.pendingMeshEntities.size) return

    const passStart = performance.now()
    const hardMs = ThreeBridge.MESH_DRAIN_HARD_MS
    const pendingArr = [...this.pendingMeshEntities]
    const n = pendingArr.length
    if (n === 0) return
    if (this.pendingMeshCursor >= n) this.pendingMeshCursor = 0

    type HashBucket = {
      hash: string
      cacheKey: string
      url: string
      ready: boolean
      entities: Entity[]
    }
    const byHash = new Map<string, HashBucket>()
    const nonGltf: Entity[] = []

    const sample = Math.min(ThreeBridge.MESH_DRAIN_HASH_SAMPLE, n)
    for (let i = 0; i < sample; i++) {
      if (performance.now() - passStart >= hardMs * 0.4) break
      const entity = pendingArr[(this.pendingMeshCursor + i) % n]!
      const obj = this.store.nodes.get(entity)
      if (!obj) {
        this.pendingMeshEntities.delete(entity)
        continue
      }
      if (!this.entityNeedsMeshWork(entity, obj, { includeMaterial: false })) {
        if (this.entityNeedsMaterialWork(entity, obj)) this.pendingMaterialEntities.add(entity)
        this.pendingMeshEntities.delete(entity)
        continue
      }
      const key = this.gltfDrainKey(entity)
      if (!key) {
        nonGltf.push(entity)
        continue
      }
      let bucket = byHash.get(key.hash)
      if (!bucket) {
        bucket = {
          hash: key.hash,
          cacheKey: key.cacheKey,
          url: key.url,
          ready: key.ready,
          entities: []
        }
        byHash.set(key.hash, bucket)
      } else if (key.ready) {
        bucket.ready = true
      }
      bucket.entities.push(entity)
    }
    this.pendingMeshCursor =
      (this.pendingMeshCursor + sample) % Math.max(1, this.pendingMeshEntities.size)

    if (!byHash.size && !nonGltf.length) return

    // Map iteration order = first-seen in the ring sample (fair over time as cursor moves).
    const buckets = [...byHash.values()]

    // Cold: one scheduleBackgroundLoad per hash (deduped in scheduleBackgroundLoad too).
    let coldKicks = 0
    for (const bucket of buckets) {
      if (performance.now() - passStart >= hardMs) break
      if (bucket.ready) continue
      if (coldKicks >= ThreeBridge.MESH_DRAIN_MAX_COLD_HASHES) break
      if (
        this.cache.hasCached(bucket.cacheKey) ||
        this.cache.isResolving(bucket.cacheKey) ||
        this.cache.hasGivenUp(bucket.cacheKey)
      ) {
        continue
      }
      this.scheduleBackgroundLoad(bucket.url, bucket.hash, bucket.cacheKey)
      coldKicks++
    }

    // Ready: attach entities; stay on one hash while budget allows (cheap for InstancedMesh).
    let attaches = 0
    this.gltfBudgetRemaining = Math.max(this.gltfBudgetRemaining, ThreeBridge.MESH_DRAIN_MAX_ATTACH)
    for (const bucket of buckets) {
      if (performance.now() - passStart >= hardMs) break
      if (!bucket.ready && !this.cache.hasCached(bucket.cacheKey)) continue

      for (const entity of bucket.entities) {
        if (performance.now() - passStart >= hardMs) break
        if (attaches >= ThreeBridge.MESH_DRAIN_MAX_ATTACH) break
        if (!this.pendingMeshEntities.has(entity)) continue
        const obj = this.store.nodes.get(entity)
        if (!obj) {
          this.pendingMeshEntities.delete(entity)
          continue
        }
        if (!this.entityNeedsMeshWork(entity, obj, { includeMaterial: false })) {
          if (this.entityNeedsMaterialWork(entity, obj)) this.pendingMaterialEntities.add(entity)
          this.pendingMeshEntities.delete(entity)
          continue
        }
        const before = this.attachedSceneGltfCount
        this.syncMeshSync(entity, obj, meshEcs, true)
        if (this.attachedSceneGltfCount > before) attaches++
        if (!this.entityNeedsMeshWork(entity, obj, { includeMaterial: false })) {
          if (this.entityNeedsMaterialWork(entity, obj)) this.pendingMaterialEntities.add(entity)
          this.pendingMeshEntities.delete(entity)
        }
      }
      if (attaches >= ThreeBridge.MESH_DRAIN_MAX_ATTACH) break
    }

    for (const entity of nonGltf) {
      if (performance.now() - passStart >= hardMs) break
      if (attaches >= ThreeBridge.MESH_DRAIN_MAX_ATTACH) break
      const obj = this.store.nodes.get(entity)
      if (!obj) {
        this.pendingMeshEntities.delete(entity)
        continue
      }
      this.syncMeshSync(entity, obj, meshEcs, true)
      attaches++
      if (!this.entityNeedsMeshWork(entity, obj, { includeMaterial: false })) {
        if (this.entityNeedsMaterialWork(entity, obj)) this.pendingMaterialEntities.add(entity)
        this.pendingMeshEntities.delete(entity)
      }
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

  /**
   * Reconcile billboard tracked flags from live ECS.
   * Diff path already calls syncBillboardFlagsFromDiff — full walk is hydration-only
   * (was O(all scene entities) every async frame after mass spawn).
   */
  reconcileBillboardFlags(): void {
    if (!this.hydrationMode) return
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
  tickDeferredMaterials(budgetMs = 6, maxEntities = 2): void {
    if (this.materialTickBusy) return
    if (!this.pendingMaterialEntities.size && !this.pendingGltfNodeModEntities.size) return
    // After hydration, apply deferred textures even if the global defer gate is still set.
    const deferTextures = this.shouldDeferTextures() && this.hydrationMode
    if (deferTextures) return
    this.materialTickBusy = true
    // Fire-and-forget — must not be awaited from the async frame path.
    void Promise.all([
      this.runMaterialPass(this.ecs.Material, budgetMs, maxEntities, false),
      this.runGltfNodeModifiersPass(budgetMs, maxEntities)
    ])
      .catch((err) => console.warn('[ThreeBridge] deferred material pass failed', err))
      .finally(() => {
        this.materialTickBusy = false
      })
  }

  /** Queue GltfNodeModifiers apply (called from projection diff / video ready). */
  queueGltfNodeModifiers(entity: Entity): void {
    this.pendingGltfNodeModEntities.add(entity)
  }

  private async runGltfNodeModifiersPass(
    budgetMs = this.meshPassBudgetMs(),
    maxEntities = Number.POSITIVE_INFINITY
  ): Promise<void> {
    if (!this.pendingGltfNodeModEntities.size) return
    const { GltfNodeModifiers } = this.ecs
    const passStart = performance.now()
    let processed = 0
    for (const entity of [...this.pendingGltfNodeModEntities]) {
      if (processed >= maxEntities) break
      if (performance.now() - passStart >= budgetMs) break

      const obj = this.store.nodes.get(entity)
      if (!GltfNodeModifiers.has(entity)) {
        // Component removed — restore GLB materials if we overrode them.
        if (obj) restoreGltfNodeModifierOriginals(obj)
        this.pendingGltfNodeModEntities.delete(entity)
        continue
      }
      if (!obj) continue

      // Promote GPU instance → private clone so material overrides never touch siblings.
      if (obj.userData.dclInstanced) {
        this.promoteInstancedGltfForModifiers(entity, obj)
        // Re-attach path will re-queue via notifyGltfAttached.
        continue
      }

      // Wait until GLB is attached (mesh root or any mesh).
      let hasMesh = false
      obj.traverse((c) => {
        if ((c as THREE.Mesh).isMesh) hasMesh = true
      })
      if (!hasMesh) continue

      const mods = GltfNodeModifiers.get(entity) as PBGltfNodeModifiers
      const ok = await applyGltfNodeModifiersToEntity(obj, mods, this.materials, {
        entity,
        logPathMiss: !obj.userData.dclGltfNodeModPathMissLogged
      })
      if (!ok && !obj.userData.dclGltfNodeModPathMissLogged) {
        obj.userData.dclGltfNodeModPathMissLogged = true
      }
      if (ok) this.pendingGltfNodeModEntities.delete(entity)
      processed++
    }
  }

  /**
   * Drop InstancedMesh slot and re-queue mesh attach as a private SkeletonUtils clone.
   * GltfNodeModifiers require per-entity materials (shared instance leaves are GPU-shared).
   */
  private promoteInstancedGltfForModifiers(entity: Entity, obj: THREE.Group): void {
    this.instancer.detach(entity, obj)
    this.instanceMotionHits.delete(entity)
    delete obj.userData.dclInstanced
    delete obj.userData.gltfSrcKey
    delete obj.userData.dclForceIdleAttach
    obj.userData.dclForceCloneAttach = true
    this.pendingMeshEntities.add(entity)
    this.pendingGltfNodeModEntities.add(entity)
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
      const geo = buildPrimitiveGeometry(spec)
      const doubleSided = primitiveDoubleSided(spec)
      primitive = new THREE.Mesh(
        geo,
        new THREE.MeshStandardMaterial({
          color: 0xffffff,
          side: doubleSided ? THREE.DoubleSide : THREE.FrontSide
        })
      )
      primitive.name = mk
      primitive.userData.primitiveMeshKey = key
      primitive.userData.primitiveDoubleSided = doubleSided
      // Unity MeshRenderer / material.proto cast_shadows default true
      primitive.castShadow = true
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
    this.pendingMeshCursor = 0
    this.largeAttachQueue.length = 0
    this.largeAttachQueued.clear()
    this.largeAttachDraining = false
    this.instanceMotionHits.clear()
    this.instancer.dispose()
  }

  /**
   * Drop GltfContainer visual (SkeletonUtils clone or GPU InstancedMesh slot).
   * Used on full entity remove and when GltfContainer is deleted while Transform remains
   * (e.g. coin pickup that keeps the entity but clears the mesh).
   */
  private clearGltfVisual(entity: Entity, obj: THREE.Group): boolean {
    const mk = meshKey(entity)
    const attachedTris = (obj.userData.dclAttachedTris as number | undefined) ?? 0
    let removedGltf = false
    if (obj.userData.dclInstanced) {
      this.instancer.detach(entity, obj)
      this.instanceMotionHits.delete(entity)
      delete obj.userData.dclInstanced
      delete obj.userData.dclInstanceTemplateTris
      removedGltf = true
    }
    const meshChild = obj.getObjectByName(mk)
    if (meshChild && meshChild.userData.primitiveKind === undefined && meshChild.userData.primitiveMeshKey === undefined) {
      if (obj.userData.gltfSrcKey || meshChild.userData.dclInstanceMarker) removedGltf = true
      disposeOwnedObject3D(meshChild)
      obj.remove(meshChild)
    }
    if (removedGltf || obj.userData.gltfSrcKey || obj.userData.animationRig || obj.userData.emoteAnchor) {
      if (removedGltf || obj.userData.gltfSrcKey) {
        this.attachedSceneGltfCount = Math.max(0, this.attachedSceneGltfCount - 1)
        this.attachedSceneTris = Math.max(0, this.attachedSceneTris - attachedTris)
      }
      delete obj.userData.gltfSrcKey
      delete obj.userData.dclAttachedTris
      delete obj.userData.animationRig
      delete obj.userData.emoteAnchor
      // Keep dclForceCloneAttach across GltfContainer re-src so motion-promoted props stay clones.
      return true
    }
    return removedGltf
  }

  private removeEntityVisuals(entity: Entity, obj: THREE.Group): void {
    const mk = meshKey(entity)
    const tk = textKey(entity)
    const lk = lightKey(entity)
    const pk = particleKey(entity)
    this.clearGltfVisual(entity, obj)
    for (const name of [tk, pk]) {
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
    // Primitive MeshRenderer mesh (not glTF) — clearGltfVisual leaves these alone.
    const primitive = obj.getObjectByName(mk)
    if (primitive && (primitive.userData.primitiveKind !== undefined || primitive.userData.primitiveMeshKey !== undefined)) {
      disposeOwnedObject3D(primitive)
      obj.remove(primitive)
    }
    removeLightSource(obj, lk)
  }

  /**
   * Enqueue a large-template attach. One clone at a time + multi-rAF yield between clones.
   * requestIdleCallback alone is not enough — each clone can still block for seconds, and
   * N concurrent idle callbacks stack freezes into a permanent 0 FPS window.
   */
  private queueIdleGltfAttach(entity: Entity): void {
    if (this.largeAttachQueued.has(entity)) return
    this.largeAttachQueued.add(entity)
    this.largeAttachQueue.push(entity)
    this.drainLargeAttachQueue()
  }

  private drainLargeAttachQueue(): void {
    if (this.largeAttachDraining) return
    this.largeAttachDraining = true

    const scheduleNext = (fn: () => void): void => {
      const ric = (
        globalThis as {
          requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => void
        }
      ).requestIdleCallback
      if (typeof ric === 'function') ric(fn, { timeout: 800 })
      else setTimeout(fn, 48)
    }

    const yieldFrames = (n: number): Promise<void> =>
      new Promise((resolve) => {
        let left = Math.max(1, n)
        const step = (): void => {
          left--
          if (left <= 0) resolve()
          else requestAnimationFrame(step)
        }
        requestAnimationFrame(step)
      })

    const pump = (): void => {
      while (this.largeAttachQueue.length) {
        const entity = this.largeAttachQueue.shift()!
        this.largeAttachQueued.delete(entity)
        const obj = this.store.nodes.get(entity)
        if (!obj) continue
        if (!this.entityNeedsMeshWork(entity, obj, { includeMaterial: false })) {
          this.pendingMeshEntities.delete(entity)
          continue
        }

        const src =
          this.ecs.GltfContainer.has(entity) ? this.ecs.GltfContainer.get(entity).src?.trim() : ''
        const t0 = performance.now()
        // Force one attach (bypass LARGE_TEMPLATE re-queue).
        obj.userData.dclForceIdleAttach = true
        const meshEcs = {
          MeshRenderer: this.ecs.MeshRenderer,
          Material: this.ecs.Material,
          GltfContainer: this.ecs.GltfContainer,
          TextShape: this.ecs.TextShape
        }
        const prev = this.gltfBudgetRemaining
        this.gltfBudgetRemaining = Math.max(this.gltfBudgetRemaining, 1)
        this.syncMeshSync(entity, obj, meshEcs, true)
        this.gltfBudgetRemaining = prev
        delete obj.userData.dclForceIdleAttach
        const ms = performance.now() - t0
        const tris = (obj.userData.dclAttachedTris as number | undefined) ?? 0
        if (ms > 50 || tris >= ThreeBridge.LARGE_TEMPLATE_TRIS) {
          obj.updateMatrixWorld(true)
          const wp = new THREE.Vector3()
          obj.getWorldPosition(wp)
          console.info(
            `[ThreeBridge] large GLB attach ${ms.toFixed(0)}ms · ~${(tris / 1000).toFixed(0)}k tris` +
              (src ? ` · ${src}` : '') +
              ` · queue=${this.largeAttachQueue.length} · sceneTris=${(this.attachedSceneTris / 1e6).toFixed(2)}M` +
              ` · world=(${wp.x.toFixed(1)},${wp.y.toFixed(1)},${wp.z.toFixed(1)})`
          )
        }
        if (!this.entityNeedsMeshWork(entity, obj, { includeMaterial: false })) {
          this.pendingMeshEntities.delete(entity)
        }

        // Yield rAF frames after every large clone so Sync/select UI can paint.
        void yieldFrames(ThreeBridge.LARGE_ATTACH_YIELD_FRAMES).then(() => scheduleNext(pump))
        return
      }
      this.largeAttachDraining = false
    }

    scheduleNext(pump)
  }

  /** Prefer GPU InstancedMesh for static same-hash GLBs; clone for skinned / Animator / morphs. */
  private canInstanceAttach(
    entity: Entity,
    template: { root: THREE.Group; animations: THREE.AnimationClip[] }
  ): boolean {
    // Prior motion promote — stay on private clone (collectible bob, projectiles).
    const existing = this.store.nodes.get(entity)
    if (existing?.userData.dclForceCloneAttach) return false
    // Skinned / Animator need full clone + mixer rebind.
    if (this.ecs.Animator.has(entity)) return false
    // Embedded clips (incl. morph weights) need a per-entity mesh + AnimationMixer —
    // DCL auto-plays the first clip when no ECS Animator (arrow.glb blink).
    if (template.animations.length > 0) return false
    // TextureMove tweens write material UVs — need private mesh materials (not shared instance).
    // Move/rotate tweens stay instancable; matrices refresh every frame after TweenBridge.
    if (this.ecs.Tween.has(entity)) {
      const mode = this.ecs.Tween.get(entity).mode?.$case
      if (mode === 'textureMove' || mode === 'textureMoveContinuous') return false
    }
    // PointerEvents / MeshCollider need live meshes in the entity graph (raycast / ECS MeshCollider).
    // GLB `_collider` physics uses template shapes + entity pose (see InstanceColliderShape).
    if (this.ecs.PointerEvents.has(entity)) return false
    if (this.ecs.MeshCollider.has(entity)) return false
    // Material / shadow overrides must not share InstancedMesh materials with siblings.
    if (this.ecs.GltfNodeModifiers.has(entity)) return false
    return templateIsInstancable(template.root)
  }

  /** Clone a cached template onto the entity node. Returns false on failure / skip. */
  private attachCachedGltf(
    entity: Entity,
    obj: THREE.Group,
    mk: string,
    src: string,
    srcKey: string,
    hash: string,
    template: { root: THREE.Group; animations: THREE.AnimationClip[] },
    templateTris: number
  ): boolean {
    try {
      // Static multi-instance path (parcel tiles, props) — no SkeletonUtils.clone.
      if (this.canInstanceAttach(entity, template)) {
        // Drop prior instance if re-attaching with new src
        if (obj.userData.dclInstanced) this.instancer.detach(entity, obj)
        const result = this.instancer.attach(entity, obj, hash, template.root, mk)
        if (result.ok) {
          obj.userData.gltfSrcKey = srcKey
          enableSceneGltfVertexColors(template.root)
          this.notifyMeshComponent(entity, this.ecs.GltfContainer.componentId)
          this.notifyGltfAttached(entity)
          this.attachedSceneGltfCount++
          // Inventory: count template once per entity for HUD (instance draws share GPU geo).
          const tris = result.templateTris || templateTris
          obj.userData.dclAttachedTris = tris
          this.attachedSceneTris += tris
          return true
        }
        // Fall through to clone if template has no instancable leaves.
      }

      // Animator / morph VFX (GunVFX muzzle) — re-tune shared template emissives so
      // session-cached materials pick up intensity boosts without a full cache purge.
      if (this.ecs.Animator.has(entity) || template.animations.length > 0) {
        applySceneGltfEmissives(template.root)
      }

      const clone = cloneGltfInstance(template.root)
      enableSceneGltfVertexColors(clone)
      obj.userData.gltfSrcKey = srcKey
      obj.userData.dclAttachedTris = templateTris
      const hasGeometry = gltfInstanceHasGeometry(clone)
      if (!hasGeometry) {
        const wantsAnimatorRig = this.ecs.Animator.has(entity)
        if (wantsAnimatorRig && template.animations.length > 0) {
          clone.name = mk
          hideGltfRenderMeshes(clone)
          obj.userData.animationRig = true
          obj.add(clone)
          this.notifyMeshComponent(entity, this.ecs.GltfContainer.componentId)
          this.notifyGltfAttached(entity)
          this.attachedSceneGltfCount++
          this.attachedSceneTris += templateTris
          return true
        }
        if (isEmoteAnchorGltfSrc(src)) {
          this.emptyGltfHashes.add(hash)
          disposeOwnedObject3D(clone)
          const anchor = new THREE.Group()
          anchor.name = mk
          obj.userData.emoteAnchor = true
          obj.add(anchor)
          this.notifyMeshComponent(entity, this.ecs.GltfContainer.componentId)
          this.setGltfLoadingState(entity, 4 /* FINISHED */)
          return true
        }
        this.emptyGltfHashes.add(hash)
        disposeOwnedObject3D(clone)
        if (!this.loggedEmptyGltfSrcs.has(src)) {
          this.loggedEmptyGltfSrcs.add(src)
          console.warn('[ThreeBridge] GLB has no renderable geometry — skipping', src)
        }
        this.setGltfLoadingState(entity, 3 /* FINISHED_WITH_ERROR */)
        return false
      }
      clone.name = mk
      if (isEmoteAnchorGltfSrc(src) && !this.ecs.Animator.has(entity)) {
        hideGltfRenderMeshes(clone)
        obj.userData.emoteAnchor = true
      } else {
        syncGltfInstanceRenderState(clone)
        enableMeshShadows(clone)
      }
      obj.add(clone)
      this.notifyMeshComponent(entity, this.ecs.GltfContainer.componentId)
      this.notifyGltfAttached(entity)
      this.attachedSceneGltfCount++
      this.attachedSceneTris += templateTris
      return true
    } catch (err) {
      obj.userData.gltfSrcKey = srcKey
      if (!this.loggedGltfAttachFailures.has(src)) {
        this.loggedGltfAttachFailures.add(src)
        console.warn('[ThreeBridge] GLB attach failed', src, err)
      }
      this.setGltfLoadingState(entity, 3 /* FINISHED_WITH_ERROR */)
      return false
    }
  }

  /**
   * Synchronous mesh attach for the async frame — never awaits GLB parse or texture load.
   * Cold GLBs: kick background parse, return. Cached: SkeletonUtils clone + queue materials.
   */
  private syncMeshSync(
    entity: Entity,
    obj: THREE.Group,
    ecs: Pick<MirrorComponents, 'MeshRenderer' | 'Material' | 'GltfContainer' | 'TextShape'>,
    touchMaterials = true
  ): void {
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

      if (!hash) {
        this.setGltfLoadingState(entity, 2 /* NOT_FOUND */)
        return
      }

      if (!mesh || obj.userData.gltfSrcKey !== srcKey) {
        if (obj.userData.dclInstanced) {
          this.instancer.detach(entity, obj)
          delete obj.userData.dclInstanced
        }
        if (mesh) {
          disposeOwnedObject3D(mesh)
          obj.remove(mesh)
        }

        const isLocal = hash.startsWith(GLTF_LOCAL_PREFIX)
        const url = isLocal ? hash.slice(GLTF_LOCAL_PREFIX.length) : this.sceneConfig.assetUrl(hash)
        const cacheKey = this.gltfCacheKey(isLocal ? url : hash)

        if (this.cache.hasGivenUp(cacheKey) || this.emptyGltfHashes.has(hash)) {
          this.setGltfLoadingState(entity, 3 /* FINISHED_WITH_ERROR */)
          return
        }

        // In-flight / re-src — scene can poll LOADING until FINISHED.
        this.setGltfLoadingState(entity, 1 /* LOADING */)

        if (this.gltfBudgetRemaining <= 0) return

        const template = this.cache.peekCached(cacheKey)
        const templateTris = template
          ? ((template.root.userData.dclTriCount as number | undefined) ??
            (() => {
              const t = countObjectTriangles(template.root)
              template.root.userData.dclTriCount = t
              return t
            })())
          : 0

        // Cold: schedule parse off the frame path — never await load() here.
        if (!template) {
          if (this.gltfBudgetRemaining > 0) {
            this.gltfBudgetRemaining--
            this.scheduleBackgroundLoad(url, isLocal ? url : hash, cacheKey)
          }
          return
        }

        // Large *clones* off the attach pass. Static instancable templates stay on-path
        // (matrix write only — mountains / tiles must not wait behind SkeletonUtils).
        if (
          !obj.userData.dclForceIdleAttach &&
          templateTris >= ThreeBridge.LARGE_TEMPLATE_TRIS &&
          !this.canInstanceAttach(entity, template)
        ) {
          this.queueIdleGltfAttach(entity)
          return
        }

        this.gltfBudgetRemaining--
        if (!this.attachCachedGltf(entity, obj, mk, src, srcKey, hash, template, templateTris)) {
          return
        }
        mesh = obj.getObjectByName(mk) as THREE.Object3D | undefined
      } else {
        // Already attached — ensure FINISHED even if we never re-enter attachCachedGltf.
        this.setGltfLoadingState(entity, 4 /* FINISHED */)
      }

      // Never await textures here — queue for tickDeferredMaterials (budgeted, fire-and-forget).
      if (touchMaterials && Material.has(entity) && mesh) {
        const pb = Material.get(entity) as PbMaterial
        if (this.materials.needsReapply(entity, pb, mesh)) {
          this.pendingMaterialEntities.add(entity)
          this.materials.applyScalarsToObject3D(mesh, entity, pb)
        }
      }
      return
    }

    // GltfContainer removed — drop clone and/or free GPU instance slot (pickup / hide).
    this.clearGltfLoadingState(entity)
    this.clearGltfVisual(entity, obj)

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
        const geo = buildPrimitiveGeometry(spec)
        const doubleSided = primitiveDoubleSided(spec)
        primitive = new THREE.Mesh(
          geo,
          new THREE.MeshStandardMaterial({
            color: 0xffffff,
            side: doubleSided ? THREE.DoubleSide : THREE.FrontSide
          })
        )
        primitive.name = mk
        primitive.userData.primitiveMeshKey = key
        primitive.userData.primitiveDoubleSided = doubleSided
        // Unity MeshRenderer / material.proto cast_shadows default true
        primitive.castShadow = true
        primitive.receiveShadow = true
        obj.add(primitive)
        this.notifyMeshComponent(entity, MeshRenderer.componentId)
      }

      if (touchMaterials && Material.has(entity)) {
        const pb = Material.get(entity) as PbMaterial
        if (this.materials.needsReapply(entity, pb, primitive)) {
          this.pendingMaterialEntities.add(entity)
          this.materials.applyScalarsToObject3D(primitive, entity, pb)
        }
      }
    }
  }

}
