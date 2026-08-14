import * as THREE from 'three'
import type { Entity } from '@dcl/ecs'
import type { ProjectionView } from './ProjectionView'
import {
  acquirePrimitiveGeometry,
  releasePrimitiveGeometry,
  primitiveDoubleSided,
  hasAnimatedPlaneUvs,
  primitiveKind,
  primitiveMeshKey,
  updatePlaneGeometryUvs
} from './primitiveShapes'
import {
  MaterialApplier,
  materialAlbedoAlpha,
  materialAlbedoRgb,
  materialIsScalarOnly,
  type PbMaterial
} from './material/MaterialApplier'
import {
  PLANE_POLYGON_OFFSET_FACTOR,
  PLANE_POLYGON_OFFSET_UNITS
} from './material/depthCompositeBands'
import {
  MeshRendererInstancer,
  MESH_RENDERER_INSTANCE_MARKER
} from '../rendering/MeshRendererInstancer'
import type { AssetCache } from '../rendering/AssetCache'
import { prefetchSceneManifestAssets } from '../rendering/AssetCache'
import type { ResolvedScene } from '../dcl/content/types'
import { resolveGltfSrcHash, GLTF_LOCAL_PREFIX, isEmoteAnchorGltfSrc } from '../rendering/DclTextureResolver'
import { syncGltfInstanceRenderState } from '../collision/gltfRenderMeshes'
import type { MirrorComponents } from './mirrorComponents'
import type { ProjectionChangeKind } from './CrdtProjection'
import { removeLightSource } from './LightSourceSync'
import {
  applyTextShapeFacingMirror,
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
import {
  applyDclLocalTransform,
  resolveTransformParent,
  threeToDclVec,
  type DclTransformValues
} from './dclTransform'
import { SDK_RESERVED } from './reservedEntities'
import { disposeOwnedObject3D } from '../rendering/sharedAsset'
import { enableSceneGltfVertexColors } from '../rendering/LandscapeAssetSanitizer'
import { applySceneGltfEmissives } from '../rendering/sceneGltfEmissives'
import { cloneGltfInstance } from '../rendering/skinnedMeshInstance'
import { mergeStaticGltfLeaves } from '../rendering/mergeStaticGltfLeaves'
import {
  INSTANCE_COLLIDER_SHAPES_KEY,
  SceneGltfInstancer,
  templateIsInstancable
} from '../rendering/SceneGltfInstancer'
import {
  applyGltfNodeModifiersToEntity,
  gltfNodeModifiersMirrorStale,
  gltfNodeModifiersReferenceVideo,
  restoreGltfNodeModifierOriginals
} from './GltfNodeModifiersSync'
import type { PBGltfNodeModifiers } from '@dcl/ecs/dist/components/generated/pb/decentraland/sdk/components/gltf_node_modifiers.gen'
import { clientDebugLog } from '../client/debug/ClientDebugLog'
import { setMeshDesiredCastShadow } from '../rendering/shadowCastPolicy'
import type { DrawWorld } from '../rendering/DrawWorld'

import { gltfLoadingStateLabel, isGltfLoadingStateVerbose } from './gltfLoadingStateConfig'

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

  const want = Number(videoPlayerEntity)
  for (const slot of slots) {
    if (slot?.tex?.$case !== 'videoTexture') continue
    // Loose numeric compare — CRDT/protobuf sometimes yields float-ish entity ids.
    if (Number(slot.tex.videoTexture.videoPlayerEntity) === want) return true
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
  // Only cache hits — a null from early resolve (empty content map) must not stick forever
  // (fishing rods: assets/models/pool/beggar_rod.glb stayed unresolved after manifest ready).
  if (map.has(key)) {
    const cached = map.get(key)!
    if (cached) return cached
  }
  const hash = resolveGltfSrcHash(scene.content, key)
  if (hash) map.set(key, hash)
  else map.delete(key)
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

/**
 * Plaza fishing props that move every frame (bobber float, line, cast arc, rod attach).
 * Must never sit on GPU InstancedMesh — matrices lag / zero-scale hide.
 *
 * Keep this **tight**: a broad `/pool/` match force-cloned benches/toys and spammed
 * fish-xform logs, starving the rod/bait dock UI under load.
 */
function isFishingMotionGltfSrc(src: string): boolean {
  const s = src.trim().toLowerCase()
  if (!s) return false
  // Avatar_*_emote.glb (Avatar_Float_NoProp_emote) is an anim rig, not a rod/bobber.
  if (/_emote\.glb$/.test(s) || /\/avatar_/.test(s)) return false
  // Explicit fishing assets only (leaf or path).
  if (s.includes('bobber') || s.includes('fishing_line') || s.includes('fishing-line')) return true
  if (s.includes('lure') || s.includes('hook')) return true
  // *_rod.glb / wood_rod / sniper_rod / beggar_rod — not "prod" or "broadcast".
  if (/(^|\/|_)(rod|bait)(_|\.|\/|$)/i.test(s) || s.includes('_rod') || s.includes('rod.glb')) {
    return true
  }
  if (s.includes('bait_') || s.includes('/bait/') || s.includes('bait.glb')) return true
  // Cork float only when clearly fishing-related (avoid "floating" props).
  if (s.includes('cork') && (s.includes('fish') || s.includes('pool') || s.includes('bait'))) return true
  if (/pool\/.*(rod|line|bobber|lure|hook|bait)/i.test(s)) return true
  return false
}

/** Aim/cast bobber or line — force-show when not stashed at origin. */
function isFishingBobberOrLineSrc(src: string): boolean {
  const s = src.trim().toLowerCase()
  return (
    s.includes('bobber') ||
    s.includes('fishing_line') ||
    s.includes('fishing-line') ||
    /\/line\.glb$/.test(s)
  )
}

const _fishLogWorld = new THREE.Vector3()

/** Fishing mesh attach/xform logs — off unless ?ppidiag (attach still priority). */
const FISH_GLTF_DIAG =
  typeof window !== 'undefined' &&
  (() => {
    try {
      return new URLSearchParams(window.location.search).has('ppidiag')
    } catch {
      return false
    }
  })()

function meshKey(entity: Entity): string {
  return `__mesh_${entity}`
}

/** Safe MeshRenderer read — StoreComponents.get throws if missing (aborts whole CRDT batch). */
function meshRendererGetOrNull(
  MeshRenderer: MirrorComponents['MeshRenderer'],
  entity: Entity
): ReturnType<MirrorComponents['MeshRenderer']['get']> | null {
  if (!MeshRenderer.has(entity)) return null
  const withNull = MeshRenderer as MirrorComponents['MeshRenderer'] & {
    getOrNull?: (e: Entity) => ReturnType<MirrorComponents['MeshRenderer']['get']> | null
  }
  if (typeof withNull.getOrNull === 'function') {
    return withNull.getOrNull(entity)
  }
  try {
    return MeshRenderer.get(entity)
  } catch {
    return null
  }
}

function materialGetOrNull(
  Material: MirrorComponents['Material'],
  entity: Entity
): PbMaterial | null {
  if (!Material.has(entity)) return null
  const withNull = Material as MirrorComponents['Material'] & {
    getOrNull?: (e: Entity) => PbMaterial | null
  }
  if (typeof withNull.getOrNull === 'function') {
    return withNull.getOrNull(entity)
  }
  try {
    return Material.get(entity) as PbMaterial
  } catch {
    return null
  }
}

function lightKey(entity: Entity): string {
  return `__light_${entity}`
}

function textKey(entity: Entity): string {
  return `__text_${entity}`
}

/**
 * Scene GltfContainer shadow policy:
 * - Always receive.
 * - Cast only on Ultra (see dclGltfDefaultCaster) — high/medium/low stay receive-only so
 *   plaza-scale maps do not collapse FPS. Material.castShadows / GltfNodeModifiers can still
 *   enable cast on high when authors opt in.
 */
function enableMeshShadows(root: THREE.Object3D): void {
  root.traverse((child) => {
    if (!(child as THREE.Mesh).isMesh) return
    const mesh = child as THREE.Mesh
    setMeshDesiredCastShadow(mesh, true, 'environment', { gltfDefaultCaster: true })
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

/** Static GLTF leaves — skip per-frame local matrix rebuild and DrawWorld.sync copies. */
function freezeStaticObject3D(root: THREE.Object3D): void {
  root.traverse((o) => {
    o.matrixAutoUpdate = false
    o.updateMatrix()
    o.userData.dclDrawStatic = true
  })
}

function unfreezeObject3D(root: THREE.Object3D): void {
  root.traverse((o) => {
    o.matrixAutoUpdate = true
    delete o.userData.dclDrawStatic
  })
}

function disposeMeshMaterials(mesh: THREE.Mesh): void {
  const oldMat = mesh.material
  if (Array.isArray(oldMat)) oldMat.forEach((m) => m.dispose())
  else oldMat?.dispose()
}

/** Sync mirror ECS state → Three.js scene graph (Phase 1 + 1b render components). */
export class ThreeBridge {
  /**
   * Runtime attach slots per play frame. Was 1 and, combined with PE material-only
   * pendingDiff peels, left DecentraCraft prop/unit/building GLBs invisible for ages.
   */
  private static readonly GLTF_BUDGET_PER_FRAME = 4
  private static readonly GLTF_HYDRATION_BUDGET_PER_FRAME = 80
  /** Post-hydration catch-up after loading screen. */
  private static readonly GLTF_SOFT_HYDRATION_BUDGET_PER_FRAME = 12
  private static readonly MESH_PASS_BUDGET_MS = 6
  private static readonly MESH_PASS_HYDRATION_BUDGET_MS = 48
  private static readonly HYDRATION_ATTACH_PASSES = 8
  private static readonly HYDRATION_ATTACH_TOTAL_MS = 100
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
  /** Invalidate billboard facing cache (hide→show press_e / missed-it). */
  private invalidateBillboardFacing: ((entity: Entity) => void) | null = null
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
  /** Entities that successfully attached (clone or instance) — hydration progress authority. */
  private readonly attachedGltfEntities = new Set<Entity>()
  /**
   * Pending-mesh drain cursor — NEVER full-scan thousands of pending entities per frame.
   * Smoke showed gltfAttach=1/3365 with renderer≈4.7s from O(pending×content) hash walks.
   */
  private pendingMeshCursor = 0
  /** Sample size when grouping pending by hash (not a hard full-set walk every frame). */
  private static readonly MESH_DRAIN_HASH_SAMPLE = 512
  private static readonly MESH_DRAIN_HARD_MS = 10
  /** Hydration: allow a longer drain so many cold kicks + attaches land per tick. */
  private static readonly MESH_DRAIN_HARD_MS_HYDRATION = 48
  /** Ready GLTF instance/clone attaches per drain. */
  private static readonly MESH_DRAIN_MAX_ATTACH = 64
  /**
   * MeshRenderer (planes/boxes) attaches per drain — cheap vs GLTF clone.
   * Kept modest so a board hydrate does not starve GltfCollider / PhysX cook.
   */
  private static readonly MESH_RENDERER_DRAIN_MAX_ATTACH = 256
  /**
   * GPU InstancedMesh for dense MeshRenderer boards (pixelwars paint cells = setPlane).
   * Recolor = O(1) setInstanceColor (never rebucket). Private meshes for ineligible only.
   * Private-mesh recolor of 11k planes was ~20s lag then death — keep instancing ON.
   */
  private static readonly MESH_RENDERER_GPU_INSTANCE = true
  /**
   * Unique cold hashes to kick parse on per drain.
   * Was 4 → UI showed ~2–4 assets loading forever. Match AssetCache parse slots + fetch pool.
   */
  private static readonly MESH_DRAIN_MAX_COLD_HASHES = 12
  private static readonly MESH_DRAIN_MAX_COLD_HASHES_HYDRATION = 24
  private readonly instancer: SceneGltfInstancer
  private readonly meshRendererInstancer: MeshRendererInstancer

  constructor(
    private readonly sceneConfig: ResolvedScene,
    private readonly cache: AssetCache,
    store: EntityStore,
    private readonly ecs: MirrorComponents,
    private readonly drawWorld: DrawWorld
  ) {
    this.store = store
    this.materials = new MaterialApplier(sceneConfig, cache)
    this.instancer = new SceneGltfInstancer(() => this.drawWorld.drawRoot)
    this.meshRendererInstancer = new MeshRendererInstancer(() => this.drawWorld.drawRoot)
  }

  private getEntityVisual(obj: THREE.Group, mk: string): THREE.Object3D | undefined {
    const vis = obj.userData.dclDrawVisual as THREE.Object3D | undefined
    if (vis) return vis
    // Pose-child leftover before bindDrawVisual (or never registered).
    return obj.getObjectByName(mk) ?? undefined
  }

  bindEntityDrawVisual(pose: THREE.Object3D, visual: THREE.Object3D): void {
    this.bindDrawSlot(pose, visual, 'dclDrawVisual')
  }

  bindEntityDrawSlot(pose: THREE.Object3D, visual: THREE.Object3D, slot: string): void {
    this.bindDrawSlot(pose, visual, slot)
  }

  unbindEntityDrawVisual(pose: THREE.Object3D): void {
    this.unbindDrawSlot(pose, 'dclDrawVisual')
  }

  unbindEntityDrawSlot(pose: THREE.Object3D, slot: string): void {
    this.unbindDrawSlot(pose, slot)
  }

  private bindDrawVisual(obj: THREE.Group, visual: THREE.Object3D): void {
    this.bindDrawSlot(obj, visual, 'dclDrawVisual')
  }

  private unbindDrawVisual(obj: THREE.Group): void {
    this.unbindDrawSlot(obj, 'dclDrawVisual')
  }

  private bindDrawSlot(pose: THREE.Object3D, visual: THREE.Object3D, slot: string): void {
    const prev = pose.userData[slot] as THREE.Object3D | undefined
    if (prev && prev !== visual) this.drawWorld.unregister(prev)
    pose.userData[slot] = visual
    visual.userData.dclPoseNode = pose
    this.drawWorld.register(visual, pose)
    // Visibility may have been set on the pose before the draw visual existed (LO()
    // hides pond benches, then the GLB attaches). DrawRoot ignores pose.visible.
    visual.visible = pose.visible
  }

  private unbindDrawSlot(pose: THREE.Object3D, slot: string): void {
    const vis = pose.userData[slot] as THREE.Object3D | undefined
    if (vis) this.drawWorld.unregister(vis)
    delete pose.userData[slot]
  }

  /** Pointer raycast: MeshRenderer or Gltf InstancedMesh hit → ECS entity. */
  resolveMeshRendererInstanceEntity(mesh: THREE.Object3D, instanceId: number): Entity | null {
    return (
      this.meshRendererInstancer.entityFromInstanceHit(mesh, instanceId) ??
      this.instancer.entityFromInstanceHit(mesh, instanceId)
    )
  }

  getMeshRendererInstancePointerMeshes(): THREE.Object3D[] {
    return this.getInstancePointerMeshesForEntities(this.store.nodes.keys())
  }

  getInstancePointerMeshesForEntities(entities: Iterable<Entity>): THREE.Object3D[] {
    const list = [...entities]
    const gltf = this.instancer.meshesForEntities(list)
    const mr = this.meshRendererInstancer.meshesForEntities(list)
    return mr.length && gltf.length ? [...mr, ...gltf] : mr.length ? mr : gltf
  }

  /**
   * Transform CRDT / Tween motion hits per instanced entity — sustained motion promotes
   * to a private clone so hierarchy TRS drives the mesh (death coins bob/spin, projectiles).
   * Static multi-instance tiles only get 1–2 puts and stay on GPU InstancedMesh.
   * Scale / moveRotateScale / textureMove promote immediately (plaza bounce squash).
   */
  private readonly instanceMotionHits = new Map<Entity, number>()
  private static readonly INSTANCE_MOTION_PROMOTE_HITS = 3

  /** After Transform apply — refresh GPU instance matrices for instanced GltfContainers. */
  syncInstancedTransforms(entities: Iterable<Entity>): void {
    // MeshRenderer: PE / Tween / parented hierarchy leave GPU instancing.
    const meshRendererUpdate: Entity[] = []
    for (const entity of entities) {
      if (!this.meshRendererInstancer.has(entity)) continue
      const obj = this.store.nodes.get(entity)
      if (!obj) continue
      if (
        this.ecs.PointerEvents?.has(entity) ||
        this.ecs.Tween?.has(entity) ||
        !this.meshRendererIsInstanceEligible(entity)
      ) {
        // Re-check eligibility (e.g. parented temple parts) and promote off GPU instance.
        this.promoteMeshRendererForPointerOrMotion(entity, obj)
        continue
      }
      meshRendererUpdate.push(entity)
    }
    if (meshRendererUpdate.length) {
      this.meshRendererInstancer.updateEntities(meshRendererUpdate, this.store.nodes)
    }

    const toUpdate: Entity[] = []
    for (const entity of entities) {
      if (!this.instancer.has(entity)) {
        this.instanceMotionHits.delete(entity)
        continue
      }
      // Fishing bobber/line — promote immediately if somehow instanced.
      if (
        this.ecs.GltfContainer.has(entity) &&
        isFishingMotionGltfSrc(this.ecs.GltfContainer.get(entity).src?.trim() ?? '')
      ) {
        const obj = this.store.nodes.get(entity)
        if (obj) this.promoteInstancedForMotion(entity, obj)
        continue
      }
      // Active scale/move tweens (bounce parasol, fishing bobber float) — clone now so motion
      // is visible this frame (GPU instance matrices lag / zero-scale hide).
      if (this.ecs.Tween.has(entity)) {
        const mode = this.ecs.Tween.get(entity).mode?.$case
        if (
          mode === 'scale' ||
          mode === 'moveRotateScale' ||
          mode === 'textureMove' ||
          mode === 'textureMoveContinuous' ||
          mode === 'move' ||
          mode === 'moveContinuous' ||
          mode === 'rotate' ||
          mode === 'rotateContinuous'
        ) {
          const obj = this.store.nodes.get(entity)
          if (obj) this.promoteInstancedForMotion(entity, obj)
          continue
        }
      }
      // Billboard yaw follows the camera every walk frame. Stay on GPU instance —
      // 3 hits used to clone every plaza sign and hitch the present thread.
      if (this.ecs.Billboard?.has(entity)) {
        toUpdate.push(entity)
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
   * Extract billboard: write GPU instance world without mutating pose quat.
   * @returns true when this entity is instanced and the slot was written.
   */
  setInstancedWorldMatrix(entity: Entity, world: THREE.Matrix4): boolean {
    const obj = this.store.nodes.get(entity)
    if (obj && !obj.visible) {
      if (this.instancer.has(entity)) this.instancer.update(entity, obj)
      return true
    }
    if (this.meshRendererInstancer.has(entity)) {
      return this.meshRendererInstancer.writeWorldMatrix(entity, world)
    }
    if (this.instancer.has(entity)) {
      return this.instancer.writeWorldMatrix(entity, world)
    }
    return false
  }

  /**
   * Bevy handle admit — GltfContainer lives on the host store; the GPU object
   * appears when the GLB template is Ready (`pendingMeshEntities` drain).
   * Never a pendingDiff component replay.
   */
  admitGltfHandle(entity: Entity, kind: 'put' | 'delete'): void {
    if (kind === 'delete') {
      const obj = this.store.nodes.get(entity)
      if (obj) {
        if (this.instancer.has(entity)) this.instancer.detach(entity, obj)
        this.unbindDrawVisual(obj)
        this.removeMeshSlot(obj, meshKey(entity))
      }
      this.pendingMeshEntities.delete(entity)
      return
    }
    this.pendingMeshEntities.add(entity)
    const key = this.gltfDrainKey(entity)
    if (!key || key.ready) return
    if (this.cache.isResolving(key.cacheKey) || this.cache.hasGivenUp(key.cacheKey)) return
    this.scheduleBackgroundLoad(key.url, key.hash, key.cacheKey)
  }

  /**
   * Material handle — apply when leaf + maps are Ready. Not a pendingDiff replay.
   */
  admitMaterialHandle(entity: Entity, kind: 'put' | 'delete'): void {
    if (kind === 'delete') {
      this.pendingMaterialEntities.delete(entity)
      return
    }
    this.pendingMaterialEntities.add(entity)
    if (this.ecs.MeshRenderer.has(entity) && !this.ecs.GltfContainer.has(entity)) {
      this.forceApplyMeshRendererMaterial(entity)
    }
  }

  /** GltfNodeModifiers handle — apply when the GLB visual exists. */
  admitGltfNodeModHandle(entity: Entity, kind: 'put' | 'delete'): void {
    if (kind === 'delete') {
      this.pendingGltfNodeModEntities.add(entity)
      return
    }
    this.queueGltfNodeModifiers(entity)
  }

  hasPendingHandleWork(): boolean {
    return this.pendingMaterialEntities.size > 0 || this.pendingGltfNodeModEntities.size > 0
  }

  /**
   * Drop InstancedMesh slot and re-attach as SkeletonUtils clone — motion-driven props
   * (collectible bob/spin, flying projectiles, fishing line/bobber) need hierarchy tracking.
   *
   * Prefer **sync** re-attach when the GLB template is already cached so we do not leave a
   * multi-frame invisible gap (detach → pendingMeshEntities → budget drain). Plaza fishing
   * line/bobber looked missing for seconds while stuck in that queue under load.
   */
  private promoteInstancedForMotion(entity: Entity, obj: THREE.Group): void {
    this.instancer.detach(entity, obj)
    this.instanceMotionHits.delete(entity)
    delete obj.userData.dclInstanced
    delete obj.userData.gltfSrcKey
    delete obj.userData.dclForceIdleAttach
    obj.userData.dclForceCloneAttach = true

    // Marker group from instancer may remain — clear so attach path can rebuild.
    const mk = meshKey(entity)
    const marker = this.getEntityVisual(obj, mk)
    if (marker) {
      obj.remove(marker)
      disposeOwnedObject3D(marker)
    }

    if (this.ecs.GltfContainer.has(entity)) {
      const { src } = this.ecs.GltfContainer.get(entity)
      const trimmed = src?.trim() ?? ''
      const hash =
        /^(bafy|bafkre|Qm)/i.test(trimmed)
          ? trimmed
          : resolveGltfSrcHash(this.sceneConfig.content, trimmed)
      if (hash && !hash.startsWith(GLTF_LOCAL_PREFIX)) {
        const template =
          this.cache.peekCached(hash) ?? this.cache.peekCached(this.sceneConfig.assetUrl(hash))
        if (template) {
          const templateTris =
            (template.root.userData.dclTriCount as number | undefined) ??
            (() => {
              const t = countObjectTriangles(template.root)
              template.root.userData.dclTriCount = t
              return t
            })()
          const ok = this.attachCachedGltf(
            entity,
            obj,
            mk,
            trimmed,
            hash,
            hash,
            template,
            templateTris
          )
          if (ok) {
            obj.matrixAutoUpdate = true
            const mesh = this.getEntityVisual(obj, mk)
            if (mesh) unfreezeObject3D(mesh)
            this.pendingMeshEntities.delete(entity)
            // Motion promote replaced instanced rest — re-apply ECS Material to the clone.
            if (this.ecs.Material.has(entity)) {
              this.pendingMaterialEntities.add(entity)
            }
            return
          }
        }
      }
    }
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
      // AvatarAttach owns absolute bone world pose — never reparent under PE chest root.
      if (this.skipTransformApply?.(entity)) {
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
      applyDclLocalTransform(obj, t)
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

  /**
   * Hide far static GltfContainer graphs (and zero InstancedMesh slots).
   * ECS Visibility / Transform / Animator state is kept; walk-in restores from Visibility.
   * Fishing / AvatarAttach / Tween stay live.
   */
  updateGltfDistanceLod(focusWorld: THREE.Vector3, keepM: number): void {
    const { GltfContainer, VisibilityComponent, Tween } = this.ecs
    if (!GltfContainer || keepM <= 0) return
    const keepSq = keepM * keepM
    for (const [entity, obj] of this.store.nodes) {
      if (!GltfContainer.has(entity)) continue
      const src = GltfContainer.get(entity).src?.trim() ?? ''
      if (isFishingMotionGltfSrc(src)) continue
      if (this.isAvatarAttachDriven(entity)) continue
      if (Tween?.has(entity)) continue
      const e = obj.matrixWorld.elements
      const dx = e[12]! - focusWorld.x
      const dy = e[13]! - focusWorld.y
      const dz = e[14]! - focusWorld.z
      const far = dx * dx + dy * dy + dz * dz > keepSq
      if (far) {
        if (obj.userData.dclDistCulled) continue
        obj.userData.dclDistCulled = true
        obj.visible = false
        if (obj.userData.dclInstanced) this.instancer.update(entity, obj)
        continue
      }
      if (!obj.userData.dclDistCulled) continue
      obj.userData.dclDistCulled = false
      const visible =
        !VisibilityComponent || !VisibilityComponent.has(entity)
          ? true
          : VisibilityComponent.get(entity).visible !== false
      obj.visible = visible
      if (obj.userData.dclInstanced) this.instancer.update(entity, obj)
    }
  }

  /** Undo any temporary distance-cull from earlier experiments (meshes follow ECS visibility). */
  restoreGltfDistanceCull(): void {
    const { VisibilityComponent } = this.ecs
    for (const [entity, obj] of this.store.nodes) {
      if (!obj.userData.dclDistCulled) continue
      obj.userData.dclDistCulled = false
      const visible =
        !VisibilityComponent || !VisibilityComponent.has(entity)
          ? true
          : VisibilityComponent.get(entity).visible !== false
      obj.visible = visible
      for (const child of obj.children) {
        if (typeof child.name === 'string' && child.name.startsWith('__mesh_')) {
          child.visible = visible
        }
      }
    }
  }

  getEntityNodes(): Map<Entity, THREE.Group> {
    return this.store.nodes
  }

  entitiesWithVisibility(): Entity[] {
    const vis = this.ecs.VisibilityComponent
    if (!vis) return []
    const out: Entity[] = []
    for (const entity of this.store.nodes.keys()) {
      if (vis.has(entity)) out.push(entity)
    }
    return out
  }

  /**
   * Apply ECS VisibilityComponent to EntityStore group + private `__mesh_*` leaves.
   * Instanced MeshRenderer: rewrite matrix (zero scale when hidden).
   *
   * Do **not** rewrite scale here — GP missed-it / press_e pop-ins use Scale tweens
   * (and v9 starts at scale.y=0). Only unfreeze + leaf visibility.
   */
  syncEcsVisibility(entities: Iterable<Entity>): void {
    const { VisibilityComponent, Transform, Billboard } = this.ecs
    if (!VisibilityComponent) return
    const instanced: Entity[] = []
    const gltfInstanced: Entity[] = []
    for (const entity of entities) {
      const obj = this.store.nodes.get(entity)
      if (!obj) continue
      // No Visibility component → leave Three visibility alone (missed-it uses scale, not Vis).
      if (!VisibilityComponent.has(entity)) continue
      const visible = VisibilityComponent.get(entity).visible !== false
      const wasVisible = obj.visible
      obj.visible = visible
      const drawn = obj.userData.dclDrawVisual as THREE.Object3D | undefined
      if (drawn) drawn.visible = visible
      const parts = obj.userData.dclDrawParticles as THREE.Object3D | undefined
      if (parts) parts.visible = visible
      const light = obj.userData.dclDrawLight as THREE.Object3D | undefined
      if (light) light.visible = visible
      if (visible) {
        unfreezeObject3D(obj)
        if (Billboard?.has(entity)) {
          this.invalidateBillboardFacing?.(entity)
        }
        const parentId = Transform?.has(entity)
          ? (Transform.get(entity).parent as Entity | undefined)
          : undefined
        if (parentId && Billboard?.has(parentId)) {
          this.invalidateBillboardFacing?.(parentId)
        }
      }
      for (const child of obj.children) {
        if (typeof child.name === 'string' && child.name.startsWith('__mesh_')) {
          child.visible = visible
          if (visible) unfreezeObject3D(child)
        }
      }
      // GltfContainer private clones (fishing rod) — hide whole subtree, not just __mesh_*.
      if (this.ecs.GltfContainer?.has(entity)) {
        obj.traverse((o) => {
          if (o !== obj && (o as THREE.Mesh).isMesh) {
            o.visible = visible
          }
        })
      }
      if (visible && this.ecs.MeshRenderer?.has(entity) && !this.hasMeshRendererLeaf(entity)) {
        this.ensureMeshRendererLeaf(entity)
        const leaf = obj.getObjectByName(meshKey(entity))
        if (leaf) leaf.visible = true
      }
      if (this.meshRendererInstancer.has(entity) || obj.userData.dclMeshRendererInstanced) {
        instanced.push(entity)
      }
      if (obj.userData.dclInstanced) gltfInstanced.push(entity)
      if (!wasVisible && visible && Billboard?.has(entity)) {
        this.invalidateBillboardFacing?.(entity)
      }
    }
    if (instanced.length) {
      this.meshRendererInstancer.updateEntities(instanced, this.store.nodes)
    }
    if (gltfInstanced.length) {
      this.instancer.updateEntities(gltfInstanced, this.store.nodes)
    }
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

  getReservedTransformAnchors(): import('./dclTransform').ReservedTransformAnchors | null {
    return this.reservedTransformAnchors
  }

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
      bindDrawVisual: (pose, visual) => this.bindDrawSlot(pose, visual, 'dclDrawLight'),
      unbindDrawVisual: (pose) => this.unbindDrawSlot(pose, 'dclDrawLight'),
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
    const spec = meshRendererGetOrNull(MeshRenderer, entity)
    if (!spec || !hasAnimatedPlaneUvs(spec)) return false
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

  setBillboardFacingInvalidator(callback: ((entity: Entity) => void) | null): void {
    this.invalidateBillboardFacing = callback
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
   *
   * Must reach the scene worker (encoder recordLww → pointer-crdt / inbound deliver).
   * Scenes like SpaceRunner freeze InputModifier until FINISHED/ERROR/NOT_FOUND (or 20s).
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
    const hasSink = !!this.recordLww
    this.recordLww?.(def.componentId, entity, value)
    // Terminal FINISHED × plaza cells was a console hitch (100s/s). Verbose only.
    if (isGltfLoadingStateVerbose()) {
      const src =
        this.ecs.GltfContainer.has(entity) ? this.ecs.GltfContainer.get(entity).src : '(no GltfContainer)'
      const msg = `host LWW e${entity as number} → ${gltfLoadingStateLabel(currentState)} sink=${hasSink ? 'ok' : 'MISSING'} ${src}`
      clientDebugLog.log('gltf-load', msg, { throttleMs: 0 })
    }
  }

  private clearGltfLoadingState(entity: Entity): void {
    this.gltfLoadingStates.delete(entity)
  }

  private notifyGltfAttached(entity: Entity): void {
    this.attachedGltfEntities.add(entity)
    this.setGltfLoadingState(entity, 4 /* FINISHED */)
    this.logFishingGltfAttach(entity)
    // Video screens (and other overrides) often land before/with GltfContainer — re-apply.
    if (this.ecs.GltfNodeModifiers.has(entity)) {
      this.pendingGltfNodeModEntities.add(entity)
      void this.runGltfNodeModifiersPass()
    }
    // ECS Material often lands before the private clone exists (poker deal cards, PE props).
    // Re-queue so maps/colors apply to the live mesh — not the detached instanced rest pose.
    if (this.ecs.Material.has(entity)) {
      this.pendingMaterialEntities.add(entity)
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

  /**
   * Asset-pack Triggers / DecentraCraft clickables register `PointerEvents` after mesh attach.
   * GPU InstancedMesh slots have no private raycast leaf — promote only when
   * instanceId raycast cannot serve the entity:
   * - MeshCollider / Tween MeshRenderer → private primitive mesh
   * - Gltf PE and MeshRenderer PE stay instanced (instanceId → entity)
   */
  ensurePointerMeshClone(entity: Entity): boolean {
    if (this.isAnimatedSpriteSlot(entity)) return false
    if (!this.ecs.PointerEvents.has(entity) && !this.ecs.MeshCollider.has(entity)) return false
    const obj = this.store.nodes.get(entity) ?? this.store.getOrCreateNode(entity, 'scene')
    // MeshCollider / Tween still need a private MeshRenderer leaf. PE-only stays instanced.
    if (
      this.ecs.MeshRenderer.has(entity) &&
      (obj.userData.dclMeshRendererInstanced || this.meshRendererInstancer.has(entity))
    ) {
      if (this.ecs.MeshCollider.has(entity) || this.ecs.Tween.has(entity)) {
        this.promoteMeshRendererForPointerOrMotion(entity, obj)
        return true
      }
      return false
    }
    // Gltf PE stays instanced — pointer resolves instanceId.
    if (this.ecs.GltfContainer.has(entity)) return false
    if (!obj.userData.dclInstanced && !this.instancer.has(entity)) return false
    this.promoteInstancedGltfForModifiers(entity, obj)
    return true
  }

  /**
   * MeshRenderer leave GPU InstancedMesh → private mesh (PE raycast + Tween move/scale).
   * COD seal: promote **once** on PE/Tween/ineligibility transition — never thrash
   * detach/rebuild every Transform when already private.
   */
  private promoteMeshRendererForPointerOrMotion(entity: Entity, obj: THREE.Group): void {
    const stillInstanced =
      this.meshRendererInstancer.has(entity) || !!obj.userData.dclMeshRendererInstanced
    if (!stillInstanced) {
      // Already private leaf — Transform path must not re-attach.
      const visual = this.entityVisualRoot(entity, obj)
      if (visual instanceof THREE.Mesh && !visual.userData[MESH_RENDERER_INSTANCE_MARKER]) {
        obj.matrixAutoUpdate = true
        unfreezeObject3D(obj)
        unfreezeObject3D(visual)
        return
      }
    }
    if (stillInstanced) {
      this.meshRendererInstancer.detach(entity, obj)
      delete obj.userData.dclMeshRendererInstanced
    }
    this.attachOrUpdateMeshRenderer(entity, obj, meshKey(entity), true)
    obj.matrixAutoUpdate = true
    unfreezeObject3D(obj)
    const visual = this.entityVisualRoot(entity, obj)
    if (visual) unfreezeObject3D(visual)
    this.pendingMeshEntities.delete(entity)
  }

  /**
   * Public: ensure MeshRenderer entities with active Tween are private meshes so
   * TweenBridge local TRS is visible (not stuck on a stale instance matrix).
   */
  ensureMeshRendererTweenVisual(entity: Entity): void {
    if (!this.ecs.MeshRenderer.has(entity)) return
    if (!this.ecs.Tween.has(entity)) return
    const obj = this.store.nodes.get(entity)
    if (!obj) return
    if (this.meshRendererInstancer.has(entity) || obj.userData.dclMeshRendererInstanced) {
      this.promoteMeshRendererForPointerOrMotion(entity, obj)
    } else if (!this.entityVisualRoot(entity, obj)) {
      this.attachOrUpdateMeshRenderer(entity, obj, meshKey(entity), true)
    }
  }

  /**
   * Before PE raycast: every PointerEvents entity with MeshRenderer must have a private
   * (or instance-raycastable) leaf. Runs cheap checks; promotes only when needed.
   */
  ensurePointerMeshesReady(entities: Iterable<Entity>): number {
    let fixed = 0
    const { MeshRenderer, PointerEvents, MeshCollider } = this.ecs
    for (const entity of entities) {
      if (!PointerEvents.has(entity)) continue
      // DOM UI PE — not 3D.
      if (this.ecs.UiTransform?.has(entity)) continue
      if (MeshCollider?.has(entity)) continue // PhysX path covers these
      if (MeshRenderer.has(entity)) {
        const obj = this.store.nodes.get(entity) ?? this.store.getOrCreateNode(entity, 'scene')
        // MeshRenderer PE stays on InstancedMesh (instanceId → entity), same as Gltf PE.
        // Only attach a private leaf when the entity was never instanced.
        if (this.meshRendererInstancer.has(entity) || obj.userData.dclMeshRendererInstanced) {
          continue
        }
        if (!this.hasMeshRendererLeaf(entity)) {
          this.ensureMeshRendererLeaf(entity)
          fixed++
        }
        continue
      }
      if (this.ecs.GltfContainer.has(entity) && this.gltfPointerWantsHighlight(entity)) {
        const obj = this.store.nodes.get(entity)
        if (obj && (obj.userData.dclInstanced || this.instancer.has(entity))) {
          this.promoteInstancedForMotion(entity, obj)
          fixed++
        }
      }
    }
    return fixed
  }

  /** SDK default showHighlight=true — Cast Line / event cards set false. */
  private gltfPointerWantsHighlight(entity: Entity): boolean {
    const spec = this.ecs.PointerEvents.getOrNull(entity)
    if (!spec?.pointerEvents?.length) return false
    for (const entry of spec.pointerEvents) {
      if (entry.eventInfo?.showHighlight === false) continue
      return true
    }
    return false
  }

  private invalidateMaterialsForVideoPlayer(videoPlayerEntity: Entity): void {
    const { Material, GltfNodeModifiers } = this.ecs
    let materialHits = 0
    let nodeModHits = 0
    this.store.forEachSceneEntity((entity) => {
      if (Material.has(entity)) {
        const pb = Material.get(entity) as PbMaterial
        if (materialReferencesVideoPlayer(pb, videoPlayerEntity)) {
          this.materials.clearEntity(entity)
          this.pendingMaterialEntities.add(entity)
          materialHits++
        }
      }
      // Creator Hub video screens put videoTexture on GltfNodeModifiers, not Material.
      if (GltfNodeModifiers.has(entity)) {
        const mods = GltfNodeModifiers.get(entity) as PBGltfNodeModifiers
        if (gltfNodeModifiersReferenceVideo(mods, videoPlayerEntity)) {
          this.pendingGltfNodeModEntities.add(entity)
          nodeModHits++
        }
      }
    })
    if (materialHits === 0 && nodeModHits === 0) {
      clientDebugLog.log(
        'cast',
        `video texture ready e${videoPlayerEntity as number} but no Material/GltfNodeModifiers reference it`,
        { level: 'warn', throttleMs: 5000, throttleKey: `vid-mat-miss:${videoPlayerEntity as number}` }
      )
    } else {
      clientDebugLog.log(
        'cast',
        `video texture rebind e${videoPlayerEntity as number} → materials=${materialHits} nodeMods=${nodeModHits}`,
        { level: 'info', throttleMs: 2000, throttleKey: `vid-mat-rebind:${videoPlayerEntity as number}` }
      )
    }
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
    return this.getEntityVisual(obj, mk) ?? null
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
    const { Material, MeshRenderer } = this.ecs
    const pb = materialGetOrNull(Material, entity)
    if (!pb) return false
    // Instanced MeshRenderer boards: color lives on InstancedMesh.instanceColor — the
    // entity host only has a marker Group (no Mesh). Still re-apply when albedo changes.
    if (
      MeshRenderer?.has(entity) &&
      (obj.userData.dclMeshRendererInstanced || this.meshRendererInstancer.has(entity))
    ) {
      return this.materials.needsReapply(entity, pb)
    }
    const visual = this.entityVisualRoot(entity, obj)
    if (!visual) return false
    return this.materials.needsReapply(entity, pb, visual)
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
      // GPU instances / animation-only rigs set gltfSrcKey but may have no `__mesh_*` child.
      // Treat as complete so we don't re-queue forever (hydration stuck ~79%).
      if (obj.userData.gltfSrcKey === hash) {
        if (obj.userData.dclInstanced || obj.userData.animationRig) return false
      }
      const mesh = this.getEntityVisual(obj, meshKey(entity))
      if (!mesh || obj.userData.gltfSrcKey !== hash) return true
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
      const textMesh = this.getEntityVisual(obj, textKey(entity)) as THREE.Mesh | undefined
      if (!textMesh) return true
      if (textMesh.userData.textShapeSignature !== textShapeSignature(TextShape.get(entity))) {
        return true
      }
    }

    if (MeshRenderer.has(entity)) {
      // T1 InstancedMesh boards — no private mesh to rebuild, but Material albedo still
      // drives instanceColor. Returning false here for "still eligible" skipped recolors
      // after first paint (pixelwars paintDelta / step-on flips stayed white).
      if (obj.userData.dclMeshRendererInstanced || this.meshRendererInstancer.has(entity)) {
        if (!this.meshRendererIsInstanceEligible(entity)) return true
        const matPb = materialGetOrNull(this.ecs.Material, entity)
        if (includeMaterial && matPb) {
          return this.materials.needsReapply(entity, matPb)
        }
        return false
      }
      const mk = meshKey(entity)
      const primitive = this.getEntityVisual(obj, mk)
      const spec = meshRendererGetOrNull(MeshRenderer, entity)
      if (!spec) return false
      const key = primitiveMeshKey(spec)
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

  /** G2 — MeshRenderer GPU instancing density (boards / dense scalars). */
  getMeshRendererInstanceStats(): { instances: number; buckets: number } {
    return this.meshRendererInstancer.stats()
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
      // Authoritative: notifyGltfAttached (clone + GPU instance). Do not require `__mesh_*`
      // (instances have none) — that left ~70 "pending" forever and hung the bar at ~79%.
      if (this.attachedGltfEntities.has(entity)) {
        gltfLoaded++
        continue
      }
      const obj = this.store.getNode(entity)
      if (!obj) continue
      if (obj.userData.gltfSrcKey === hash) {
        if (obj.userData.dclInstanced || obj.userData.animationRig) {
          gltfLoaded++
          this.attachedGltfEntities.add(entity)
          continue
        }
        if (obj.getObjectByName(meshKey(entity))) {
          gltfLoaded++
          this.attachedGltfEntities.add(entity)
        }
      }
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

  getGltfInstanceStats(): { buckets: number; instances: number; draws: number } {
    return this.instancer.stats()
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
    if (!this.pendingMeshEntities.size && !this.hasPendingHandleWork()) return
    // One-shot promote parented MeshRenderers that were GPU-instanced before hierarchy gate
    // (DecentraCraft multi-part temples/barracks invisible under env GLBs).
    this.promoteParentedMeshRendererInstances()
    const { MeshRenderer, Material, GltfContainer, TextShape } = this.ecs
    const meshEcs = { MeshRenderer, Material, GltfContainer, TextShape }
    const deferMaterials = this.shouldDeferMaterials()
    if (this.pendingMeshEntities.size) {
      await this.runDiffMeshPass(meshEcs, deferMaterials)
    }
    if (this.hasPendingHandleWork()) this.tickDeferredMaterials()
  }

  /** Leave GPU InstancedMesh when Transform.parent is set (private hierarchy TRS). */
  private promoteParentedMeshRendererInstances(): void {
    const { Transform, MeshRenderer } = this.ecs
    if (!Transform || !MeshRenderer) return
    const doomed: Entity[] = []
    for (const entity of this.meshRendererInstancer.entities()) {
      if (!MeshRenderer.has(entity) || !Transform.has(entity)) continue
      const parent = (Transform.get(entity) as DclTransformValues).parent
      if (parent == null || Number(parent) <= 0) continue
      doomed.push(entity)
    }
    for (const entity of doomed) {
      const obj = this.store.nodes.get(entity)
      if (!obj) {
        this.meshRendererInstancer.detach(entity)
        continue
      }
      this.promoteMeshRendererForPointerOrMotion(entity, obj)
    }
    if (doomed.length) {
      console.info(
        `[ThreeBridge] promoted ${doomed.length} parented MeshRenderer(s) off GPU instance (hierarchy)`
      )
    }
  }

  async consumeDiff(
    diff: Map<Entity, Map<number, ProjectionChangeKind>>,
    view: ProjectionView,
    tweenRefresh: Entity[] = []
  ): Promise<void> {
    if (!diff.size) return
    const consumeStart = performance.now()
    this.gltfBudgetRemaining = this.resolveGltfBudget()
    const { MeshRenderer, Material, GltfContainer, TextShape, Billboard, AvatarAttach, GltfNodeModifiers } =
      this.ecs
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
    // VisibilityComponent → group + private mesh leaf + instancer zero-scale hide.
    // Scan every entity that has the component — LO() hides a set that may not all
    // land in this frame's upserts if GLB attach already ran.
    this.syncEcsVisibility(this.entitiesWithVisibility())

    // AvatarAttach put this frame — promote self (+ Transform children) off GPU instances.
    if (AvatarAttach) {
      const attachTouched: Entity[] = []
      for (const [entity, comps] of diff) {
        if (comps.has(AvatarAttach.componentId) && AvatarAttach.has(entity)) {
          attachTouched.push(entity)
        }
      }
      if (attachTouched.length) this.promoteAvatarAttachGltfs(attachTouched)
    }

    // Animator put on an already-instanced GLB (Spring flowers, banners) — clone now
    // so the mixer can scale. Waiting 3 motion hits left bind-scale sheets in the sky.
    const { Animator } = this.ecs
    if (Animator) {
      for (const [entity, comps] of diff) {
        if (!comps.has(Animator.componentId) || !Animator.has(entity)) continue
        const obj = this.store.nodes.get(entity)
        if (obj && this.instancer.has(entity)) this.promoteInstancedForMotion(entity, obj)
      }
    }

    // After cast, setBobberPosition moves fishing GLBs — log pose so we can match scene coords.
    this.logFishingTransformUpserts(applied.upserts)
    // Aim/cast often moves bobber before mesh drain finishes (disco_cell storm) — force live clone.
    this.ensureFishingMeshesLive(applied.upserts, meshEcs)

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
        const obj = this.store.nodes.get(entity)
        const pb = Material.get(entity) as PbMaterial
        // GPU-instanced GLTF (pixelwars tile-*.glb boards): color via instanceColor.
        // Marker Group has no Mesh — private applyScalars was a silent no-op.
        // Textured materials return false → stay pending for full map apply.
        if (obj && this.applyInstancedGltfMaterialNow(entity, obj, pb)) {
          this.pendingMaterialEntities.delete(entity)
          continue
        }
        // Instanced + textured Material: private-clone once so maps load (press-E, cards).
        // Never re-promote every meshDirty — that froze plaza (5s engine ticks).
        if (
          obj &&
          (obj.userData.dclInstanced || this.instancer.has(entity)) &&
          !materialIsScalarOnly(pb)
        ) {
          if (!obj.userData.dclPromotedForTextureMat) {
            obj.userData.dclPromotedForTextureMat = true
            this.materials.clearEntity(entity)
            this.promoteInstancedForMotion(entity, obj)
          }
          this.pendingMaterialEntities.add(entity)
          continue
        }
        // MeshRenderer planes: instanceColor for scalar; textured stay private + deferred maps.
        if (obj && MeshRenderer.has(entity) && this.applyMeshRendererMaterialNow(entity, obj)) {
          if (
            this.meshRendererInstancer.has(entity) ||
            !this.entityNeedsMeshWork(entity, obj, { includeMaterial: false })
          ) {
            if (materialIsScalarOnly(pb) || !this.pendingMaterialEntities.has(entity)) {
              this.pendingMeshEntities.delete(entity)
            }
          }
          if (materialIsScalarOnly(pb)) {
            this.pendingMaterialEntities.delete(entity)
          }
          continue
        }
        const visual = obj ? this.entityVisualRoot(entity, obj) : null
        if (visual && this.materials.needsReapply(entity, pb, visual)) {
          // Scalar color immediately (any scene board / prop). Textures finish deferred.
          this.materials.applyScalarsToObject3D(visual, entity, pb)
          if (this.materials.needsReapply(entity, pb, visual)) {
            this.pendingMaterialEntities.add(entity)
          }
        } else if (!visual) {
          // Material before mesh attach — keep pending until drain builds the plane.
          this.pendingMaterialEntities.add(entity)
        }
      }
      // GltfNodeModifiers: apply on component put/delete; mesh attach also queues.
      // Transform streams: only re-queue when UV/scale mirror fingerprint went stale
      // (plaza event cards set scale.x = −1 after first paint — without this, map U stays wrong).
      const entityComps = diff.get(entity)
      if (entityComps?.has(GltfNodeModifiers.componentId)) {
        if (GltfNodeModifiers.has(entity)) {
          const obj = this.store.nodes.get(entity)
          if (!obj || !this.applyInstancedGltfNodeModifiersNow(entity, obj)) {
            this.pendingGltfNodeModEntities.add(entity)
          }
        } else {
          // Delete — runGltfNodeModifiersPass restores original GLB materials.
          this.pendingGltfNodeModEntities.add(entity)
        }
      } else if (
        GltfNodeModifiers.has(entity) &&
        entityComps?.has(this.ecs.Transform.componentId)
      ) {
        const obj = this.store.nodes.get(entity)
        if (obj) {
          const mods = GltfNodeModifiers.get(entity) as PBGltfNodeModifiers
          if (gltfNodeModifiersMirrorStale(obj, mods)) {
            this.pendingGltfNodeModEntities.add(entity)
          }
        }
      }
    }
    // Motion components + continuous Transform (temple spin/orbit) → unfreeze private leaves.
    this.unfreezeMeshRenderersFromDiff(diff)
    // Multi-part buildings (parented MeshRenderers) must stay private before instance matrix pass.
    this.promoteParentedMeshRendererInstances()

    // Cap UV pass — mass meshDirty (3k+) must not walk every entity every frame.
    const uvBudgetEnd = consumeStart + 4
    let uvN = 0
    for (const entity of applied.meshDirty) {
      if (uvN >= 64 || performance.now() >= uvBudgetEnd) break
      this.applyAnimatedPlaneUvs(entity)
      uvN++
    }

    // Instanced GltfContainers + MeshRenderer boards — refresh matrices after pose apply.
    // (Parented / motion MeshRenderers already promoted off the instancer above.)
    this.instancer.updateEntities(applied.upserts, this.store.nodes)
    this.meshRendererInstancer.updateEntities(applied.upserts, this.store.nodes)

    await this.runDiffMeshPass(meshEcs, deferMaterials)
    // Board flips: Material often arrives before GLTF instance attach (or during walk).
    // Drain instanced colors with no per-frame cap — budgeted material pass left flips
    // lagging until the player stood still for seconds.
    this.drainInstancedGltfMaterialPending()
    // Do not await texture loads here — one PNG decode was ~3s and froze the async frame.
    // tickDeferredMaterials (sync rAF) drains remaining textured materials with a ms budget.
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
   * Attach fishing bobber/line/rod pending meshes immediately (bypass ring sample + budget).
   * Cast must not wait for thousands of pool VFX cells to drain.
   */
  private drainFishingPendingMeshes(
    meshEcs: Pick<MirrorComponents, 'MeshRenderer' | 'Material' | 'GltfContainer' | 'TextShape'>
  ): void {
    const { GltfContainer } = this.ecs
    const fish: Entity[] = []
    for (const entity of this.pendingMeshEntities) {
      if (!GltfContainer.has(entity)) continue
      const src = GltfContainer.get(entity).src?.trim() ?? ''
      if (isFishingMotionGltfSrc(src)) fish.push(entity)
    }
    if (!fish.length) return
    // Temporarily ensure budget for fishing attaches.
    const saved = this.gltfBudgetRemaining
    this.gltfBudgetRemaining = Math.max(this.gltfBudgetRemaining, fish.length + 2)
    for (const entity of fish) {
      const obj = this.store.nodes.get(entity)
      if (!obj) {
        this.pendingMeshEntities.delete(entity)
        continue
      }
      obj.userData.dclForceCloneAttach = true
      this.syncMeshSync(entity, obj, meshEcs, true)
      if (!this.entityNeedsMeshWork(entity, obj, { includeMaterial: false })) {
        this.pendingMeshEntities.delete(entity)
      }
    }
    this.gltfBudgetRemaining = saved
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

    // Fishing bobber/line/rod first — never starve behind plaza disco_cell drain.
    this.drainFishingPendingMeshes(meshEcs)

    const passStart = performance.now()
    const hardMs = this.hydrationMode
      ? ThreeBridge.MESH_DRAIN_HARD_MS_HYDRATION
      : ThreeBridge.MESH_DRAIN_HARD_MS
    const maxColdHashes = this.hydrationMode
      ? ThreeBridge.MESH_DRAIN_MAX_COLD_HASHES_HYDRATION
      : ThreeBridge.MESH_DRAIN_MAX_COLD_HASHES
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
      if (coldKicks >= maxColdHashes) break
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
          // Material-only dirty: apply color scalars now (don't wait deferred 8/frame budget).
          this.applyPendingMaterialScalars(entity, obj)
          this.pendingMeshEntities.delete(entity)
          continue
        }
        const before = this.attachedSceneGltfCount
        this.syncMeshSync(entity, obj, meshEcs, true)
        if (this.attachedSceneGltfCount > before) attaches++
        if (!this.entityNeedsMeshWork(entity, obj, { includeMaterial: false })) {
          this.applyPendingMaterialScalars(entity, obj)
          this.pendingMeshEntities.delete(entity)
        }
      }
      if (attaches >= ThreeBridge.MESH_DRAIN_MAX_ATTACH) break
    }

    // MeshRenderer / TextShape — modest cap so GLTF + collider cook stay responsive.
    let meshRendererAttaches = 0
    const meshRendererCap = ThreeBridge.MESH_RENDERER_DRAIN_MAX_ATTACH
    for (const entity of nonGltf) {
      if (performance.now() - passStart >= hardMs) break
      if (meshRendererAttaches >= meshRendererCap) break
      const obj = this.store.nodes.get(entity)
      if (!obj) {
        this.pendingMeshEntities.delete(entity)
        continue
      }
      if (!this.entityNeedsMeshWork(entity, obj, { includeMaterial: false })) {
        this.applyPendingMaterialScalars(entity, obj)
        this.pendingMeshEntities.delete(entity)
        continue
      }
      this.syncMeshSync(entity, obj, meshEcs, true)
      meshRendererAttaches++
      if (!this.entityNeedsMeshWork(entity, obj, { includeMaterial: false })) {
        this.applyPendingMaterialScalars(entity, obj)
        this.pendingMeshEntities.delete(entity)
      }
    }
  }

  /** Immediate scalar color apply + queue textures only if still needed. */
  private applyPendingMaterialScalars(entity: Entity, obj: THREE.Group): void {
    const { Material, MeshRenderer } = this.ecs
    if (!Material.has(entity)) return
    const pb = Material.get(entity) as PbMaterial
    if (this.applyInstancedGltfMaterialNow(entity, obj, pb)) return
    // Instanced / eligible MeshRenderer boards — never use marker-Group scalar walk.
    if (MeshRenderer.has(entity) && this.applyMeshRendererMaterialNow(entity, obj)) {
      this.pendingMaterialEntities.delete(entity)
      return
    }
    const visual = this.entityVisualRoot(entity, obj)
    if (!visual) {
      this.pendingMaterialEntities.add(entity)
      return
    }
    if (!this.materials.needsReapply(entity, pb, visual)) return
    this.materials.applyScalarsToObject3D(visual, entity, pb)
    if (this.materials.needsReapply(entity, pb, visual)) {
      this.pendingMaterialEntities.add(entity)
    } else {
      this.pendingMaterialEntities.delete(entity)
    }
  }

  /**
   * Material / albedo tint on a GPU-instanced GltfContainer → instanceColor (no private clone).
   * Pixelwars land tiles are tile-*.glb instances with per-entity **scalar** recolors.
   *
   * Textured / video / avatar materials must NOT use this path: InstancedMesh cannot bind
   * unique maps, and clearing pending here starved plaza event cards + fishing press-E
   * textures (looked like blank billboards / frozen reels).
   */
  private applyInstancedGltfMaterialNow(
    entity: Entity,
    obj: THREE.Group,
    pb: PbMaterial
  ): boolean {
    if (!obj.userData.dclInstanced && !this.instancer.has(entity)) return false
    // Textured materials need a private mesh (or promote). Returning false keeps them in
    // pendingMaterialEntities / meshDirty so runMaterialPass can full-apply maps + U flip.
    if (!materialIsScalarOnly(pb)) return false
    const rgb = materialAlbedoRgb(pb)
    // Always write color (ignore material fingerprint) — step-on boards recolor often and
    // fingerprint false-negatives left tiles stuck until a later idle drain.
    if (!this.instancer.setInstanceColor(entity, rgb.r, rgb.g, rgb.b)) return false
    this.materials.markScalarApplied(entity, pb)
    this.pendingMaterialEntities.delete(entity)
    return true
  }

  /** Same-frame GltfNodeModifiers scalar tint on GPU instances (skip deferred budget). */
  private applyInstancedGltfNodeModifiersNow(entity: Entity, obj: THREE.Group): boolean {
    if (!obj.userData.dclInstanced && !this.instancer.has(entity)) return false
    const { GltfNodeModifiers } = this.ecs
    if (!GltfNodeModifiers.has(entity)) return false
    const mods = GltfNodeModifiers.get(entity) as PBGltfNodeModifiers
    const tint = this.scalarTintFromGltfNodeModifiers(mods)
    if (!tint) return false
    if (!this.instancer.setInstanceColor(entity, tint.r, tint.g, tint.b)) return false
    this.pendingGltfNodeModEntities.delete(entity)
    return true
  }

  /** True when MeshRenderer already has a private mesh or GPU instance leaf. */
  hasMeshRendererLeaf(entity: Entity): boolean {
    if (!this.ecs.MeshRenderer.has(entity)) return false
    if (this.meshRendererInstancer.has(entity)) return true
    const obj = this.store.nodes.get(entity)
    if (!obj) return false
    if (obj.userData.dclMeshRendererInstanced) return true
    const existing = this.getEntityVisual(obj, meshKey(entity))
    return (
      existing instanceof THREE.Mesh &&
      existing.userData.primitiveMeshKey != null &&
      !existing.userData[MESH_RENDERER_INSTANCE_MARKER]
    )
  }

  /**
   * COD admit seal — Material put would not change Three state.
   * Leaf still missing → not sealed (first paint must enter pendingDiff).
   */
  isMaterialPutSealed(entity: Entity): boolean {
    const pb = materialGetOrNull(this.ecs.Material, entity)
    if (!pb) return false
    if (this.ecs.MeshRenderer.has(entity) && !this.hasMeshRendererLeaf(entity)) return false
    return !this.materials.needsReapply(entity, pb)
  }

  /**
   * COD admit seal — MeshRenderer put when a leaf already exists is a no-op
   * (meshKey is entity-stable; shape-change re-attach is rare and follows Material peel).
   */
  isMeshRendererPutSealed(entity: Entity): boolean {
    return this.hasMeshRendererLeaf(entity)
  }

  /**
   * Platform law: MeshRenderer always has a blank primitive leaf even without Material.
   * Click VFX / fog-of-war / markers must not wait for a Material put that races structure drain.
   */
  ensureMeshRendererLeaf(entity: Entity): boolean {
    const { MeshRenderer, Material } = this.ecs
    const spec = meshRendererGetOrNull(MeshRenderer, entity)
    if (!spec) return false
    if (this.hasMeshRendererLeaf(entity) && this.meshRendererIsInstanceEligible(entity)) {
      return true
    }
    if (this.hasMeshRendererLeaf(entity)) return true
    const obj = this.store.getOrCreateNode(entity, 'scene')
    this.attachOrUpdateMeshRenderer(entity, obj, meshKey(entity), Material.has(entity))
    return this.hasMeshRendererLeaf(entity)
  }

  /**
   * Drain missing MeshRenderer leaves (new VFX / fog planes) up to `cap`.
   * Prioritizes pendingMeshEntities, then optional extra scan list.
   */
  flushMissingMeshRendererLeaves(cap = 64, prefer: Iterable<Entity> = []): number {
    let n = 0
    const tryOne = (entity: Entity): void => {
      if (n >= cap) return
      if (!this.ecs.MeshRenderer.has(entity)) return
      if (this.ecs.GltfContainer?.has(entity)) return
      if (this.ensureMeshRendererLeaf(entity)) {
        n++
        this.pendingMeshEntities.delete(entity)
        // Color if Material already present.
        if (this.ecs.Material.has(entity)) {
          this.forceApplyMeshRendererMaterial(entity)
        }
      }
    }
    for (const entity of prefer) {
      tryOne(entity)
      if (n >= cap) return n
    }
    for (const entity of [...this.pendingMeshEntities]) {
      tryOne(entity)
      if (n >= cap) return n
    }
    return n
  }

  /**
   * Public entry for same-frame Material recolor (worker cold CRDT path).
   * Prefer O(1) instanceColor — never walk private mesh trees on paint storms.
   *
   * Also first-attach: Material put often lands in pendingDiff before applySceneDiff
   * creates the store node / mesh (DecentraCraft applied=0 + white default materials).
   * getOrCreateNode + attach so textured props are not stuck waiting for rAF drain.
   *
   * MeshRenderer without Material: still builds a blank plane (ensureMeshRendererLeaf).
   */
  forceApplyMeshRendererMaterial(entity: Entity): boolean {
    const { MeshRenderer, Material } = this.ecs
    const pb = materialGetOrNull(Material, entity)
    const spec = meshRendererGetOrNull(MeshRenderer, entity)
    if (!spec) return false
    // No Material yet — blank leaf is still required (click markers / fog tiles).
    if (!pb) {
      return this.ensureMeshRendererLeaf(entity)
    }
    try {
      const obj = this.store.getOrCreateNode(entity, 'scene')
      // PE / Tween / ineligible — never stay on GPU instance (marker-only leaf breaks PE).
      if (
        this.meshRendererInstancer.has(entity) &&
        (this.ecs.PointerEvents?.has(entity) ||
          this.ecs.Tween?.has(entity) ||
          !this.meshRendererIsInstanceEligible(entity))
      ) {
        this.promoteMeshRendererForPointerOrMotion(entity, obj)
      }
      // Fast path: already instanced → only rewrite instanceColor when content dirty.
      if (this.meshRendererInstancer.has(entity) && materialIsScalarOnly(pb)) {
        if (!this.materials.needsReapply(entity, pb)) {
          this.pendingMaterialEntities.delete(entity)
          return true
        }
        const rgb = materialAlbedoRgb(pb)
        if (this.meshRendererInstancer.setInstanceColor(entity, rgb.r, rgb.g, rgb.b)) {
          this.materials.markScalarApplied(entity, pb)
          this.pendingMaterialEntities.delete(entity)
          return true
        }
      }
      if (this.applyMeshRendererMaterialNow(entity, obj)) {
        this.kickTexturedMaterialApply(entity, obj, pb)
        return true
      }
      // Nuclear fallback: always leave a private Mesh so pendingDiff Material put clears
      // and PE can raycast (DecentraCraft applied=0 left white + unclickable props).
      this.meshRendererInstancer.detach(entity, obj)
      delete obj.userData.dclMeshRendererInstanced
      const mk = meshKey(entity)
      let primitive = this.getEntityVisual(obj, mk) as THREE.Mesh | undefined
      if (primitive?.userData[MESH_RENDERER_INSTANCE_MARKER] || primitive?.userData.dclInstanceMarker) {
        obj.remove(primitive)
        primitive = undefined
      }
      if (!(primitive instanceof THREE.Mesh)) {
        // Re-check after detach — network entities can drop MeshRenderer mid-batch.
        const liveSpec = meshRendererGetOrNull(MeshRenderer, entity)
        if (!liveSpec) return false
        primitive = this.replacePrimitiveMesh(obj, mk, primitive, liveSpec, entity)
        this.notifyMeshComponent(entity, MeshRenderer.componentId)
      }
      this.materials.applyScalarsToObject3D(primitive, entity, pb)
      if (this.materials.needsReapply(entity, pb, primitive)) {
        this.pendingMaterialEntities.add(entity)
        // Terrain planes: do not wait for idle budget — start texture load now.
        this.kickTexturedMaterialApply(entity, obj, pb)
      } else {
        this.pendingMaterialEntities.delete(entity)
      }
      return true
    } catch (err) {
      console.warn(
        `[mr-mat] forceApply e${entity as number} threw — ${
          err instanceof Error ? err.message : String(err)
        }`
      )
      return false
    }
  }

  /** Fire-and-forget full texture maps for MeshRenderer (PE/Tween private meshes). */
  private kickTexturedMaterialApply(entity: Entity, obj: THREE.Group, pb: PbMaterial): void {
    if (materialIsScalarOnly(pb)) return
    const visual = this.entityVisualRoot(entity, obj)
    if (!visual || !(visual as THREE.Mesh).isMesh) return
    if (visual.userData[MESH_RENDERER_INSTANCE_MARKER]) return
    if (this.meshRendererInstancer.has(entity)) {
      this.promoteMeshRendererForPointerOrMotion(entity, obj)
    }
    const mesh = this.entityVisualRoot(entity, obj)
    if (!mesh || !(mesh as THREE.Mesh).isMesh) return
    void this.materials.applyToObject3D(mesh, entity, pb).then(() => {
      if (!this.materials.needsReapply(entity, pb, mesh)) {
        this.pendingMaterialEntities.delete(entity)
      } else {
        this.pendingMaterialEntities.add(entity)
      }
    })
  }

  /**
   * Same-frame Material visual for MeshRenderer entities (any scene).
   * Instanced boards: instanceColor. Else private mesh scalars / attach-to-instance.
   * Material often lands before mesh drain — attach so PE raycast + click VFX are not white.
   */
  private applyMeshRendererMaterialNow(entity: Entity, obj: THREE.Group): boolean {
    const { MeshRenderer, Material } = this.ecs
    const pb = materialGetOrNull(Material, entity)
    if (!meshRendererGetOrNull(MeshRenderer, entity) || !pb) return false
    if (this.meshRendererInstancer.has(entity) && !this.meshRendererIsInstanceEligible(entity)) {
      this.meshRendererInstancer.detach(entity, obj)
      delete obj.userData.dclMeshRendererInstanced
    }

    if (this.meshRendererInstancer.has(entity) && materialIsScalarOnly(pb)) {
      const rgb = materialAlbedoRgb(pb)
      if (!this.meshRendererInstancer.setInstanceColor(entity, rgb.r, rgb.g, rgb.b)) {
        return false
      }
      this.materials.markScalarApplied(entity, pb)
      this.pendingMaterialEntities.delete(entity)
      return true
    }

    // Eligible but not yet instanced (Material landed with mesh) — attach now.
    // Only clear pending for scalar-only instanceColor (textured must stay pending for maps).
    if (this.meshRendererIsInstanceEligible(entity)) {
      this.attachOrUpdateMeshRenderer(entity, obj, meshKey(entity), true)
      if (this.meshRendererInstancer.has(entity) && materialIsScalarOnly(pb)) {
        this.pendingMaterialEntities.delete(entity)
        return true
      }
    }

    // Private path (textured / PE / motion): ensure mesh exists, then scalars (+ queue maps).
    let visual = this.entityVisualRoot(entity, obj)
    if (
      !visual ||
      !(visual as THREE.Mesh).isMesh ||
      visual.userData[MESH_RENDERER_INSTANCE_MARKER]
    ) {
      this.attachOrUpdateMeshRenderer(entity, obj, meshKey(entity), true)
      if (this.meshRendererInstancer.has(entity) && materialIsScalarOnly(pb)) {
        this.pendingMaterialEntities.delete(entity)
        return true
      }
      // Instanced by mistake while textured — promote so maps can load.
      if (this.meshRendererInstancer.has(entity) && !materialIsScalarOnly(pb)) {
        this.promoteMeshRendererForPointerOrMotion(entity, obj)
      }
      visual = this.entityVisualRoot(entity, obj)
    }
    if (
      visual &&
      (visual as THREE.Mesh).isMesh &&
      !visual.userData[MESH_RENDERER_INSTANCE_MARKER]
    ) {
      if (this.materials.needsReapply(entity, pb, visual)) {
        this.materials.applyScalarsToObject3D(visual, entity, pb)
      }
      if (!this.materials.needsReapply(entity, pb, visual)) {
        this.pendingMaterialEntities.delete(entity)
        return true
      }
      // Mesh + scalars on; maps finish in runMaterialPass (async texture load).
      this.pendingMaterialEntities.add(entity)
      return true
    }
    return false
  }

  /**
   * Static MeshRenderer boards — freeze leaf matrices so dense planes do not rebuild
   * local matrices every frame. Never freeze physics/GLTF hosts (collider poses need live MW).
   */
  private meshRendererShouldFreeze(entity: Entity): boolean {
    const { MeshRenderer, MeshCollider, GltfContainer, Animator, Billboard, Tween, AvatarAttach, Transform } =
      this.ecs
    if (!MeshRenderer.has(entity)) return false
    if (MeshCollider?.has(entity)) return false
    if (GltfContainer?.has(entity)) return false
    if (Animator?.has(entity)) return false
    if (Billboard?.has(entity)) return false
    if (Tween?.has(entity)) return false
    if (AvatarAttach?.has(entity)) return false
    if (this.isAvatarAttachDriven(entity)) return false
    // Parent hierarchy (DecentraCraft multi-part temples / race props): parts animate
    // every tick via parent-local TRS (spin/orbit/pulse getMutable) — never freeze.
    if (Transform?.has(entity)) {
      const parent = (Transform.get(entity) as DclTransformValues).parent
      if (parent != null && Number(parent) > 0) return false
    }
    // Boxes/spheres/cylinders with scalar Material are often race architecture pieces;
    // freezing blocks later parent re-link + script motion if parent CRDT arrives after mesh.
    const freezeSpec = meshRendererGetOrNull(MeshRenderer, entity)
    if (freezeSpec) {
      if (hasAnimatedPlaneUvs(freezeSpec)) return false
      const kind = primitiveKind(freezeSpec)
      // primitiveKind returns "cylinder:rTop:rBot" for cylinders.
      if (kind === 'box' || kind === 'sphere' || kind.startsWith('cylinder')) return false
    }
    return true
  }

  /**
   * MeshRenderer → InstancedMesh eligibility (T1).
   * Scalar color boards only — motion/texture entities stay private.
   * PointerEvents stay instanced (instanceId → entity); textured/emissive PE still fail below.
   */
  private meshRendererIsInstanceEligible(entity: Entity): boolean {
    if (!ThreeBridge.MESH_RENDERER_GPU_INSTANCE) return false
    const {
      MeshRenderer,
      Material,
      Animator,
      Billboard,
      Tween,
      AvatarAttach,
      GltfNodeModifiers,
      MeshCollider,
      Transform
    } = this.ecs
    const spec = meshRendererGetOrNull(MeshRenderer, entity)
    if (!spec) return false
    if (MeshCollider?.has(entity)) return false
    // PointerEvents stay on InstancedMesh (instanceId → entity). Unique / emissive /
    // textured PE (DecentraCraft crystals) still fail the scalar/emissive gates below.
    if (Animator?.has(entity)) return false
    if (Billboard?.has(entity)) return false
    if (AvatarAttach?.has(entity)) return false
    if (this.isAvatarAttachDriven(entity)) return false
    if (Tween?.has(entity)) return false
    if (GltfNodeModifiers?.has(entity)) return false
    if (hasAnimatedPlaneUvs(spec)) return false
    // Hierarchical multi-part buildings (temple/barracks race meshes): GPU InstancedMesh
    // lives under the scene root, not under Transform.parent — parts vanished while
    // environment root GLBs still showed.
    if (Transform?.has(entity)) {
      const parent = (Transform.get(entity) as DclTransformValues).parent
      if (parent != null && Number(parent) > 0) return false
    }
    // Scalar Material required — instanceColor needs a color; textured stay private.
    const pb = materialGetOrNull(Material, entity)
    if (!pb || !materialIsScalarOnly(pb)) return false
    // Transparent / emissive markers (DecentraCraft ground click ring: alpha 0.75,
    // emissiveIntensity 1.6, ALPHA_BLEND) must stay private MeshPhysical — GPU
    // InstancedMesh uses MeshBasicMaterial which ignores emissive and often fails
    // depth-sort under fog-of-war planes (marker "exists" but is invisible).
    const alpha = materialAlbedoAlpha(pb)
    if (alpha < 0.999) return false
    const pbr = pb.material?.$case === 'pbr' ? pb.material.pbr : undefined
    if (pbr) {
      const mode = pbr.transparencyMode
      if (mode === 2 || mode === 3) return false // ALPHA_BLEND / TEST+BLEND
      if ((pbr.emissiveIntensity ?? 0) > 1.01) return false
      const e = pbr.emissiveColor
      if (e && (e.r ?? 0) + (e.g ?? 0) + (e.b ?? 0) > 0.05) return false
    }
    return true
  }

  private meshRendererInstanceBucketKey(entity: Entity): string {
    const { MeshRenderer, Material } = this.ecs
    const spec = meshRendererGetOrNull(MeshRenderer, entity)
    if (!spec) return 'missing'
    const geoKey = primitiveMeshKey(spec)
    // Color via instanceColor — bucket key ignores albedo so recolors never rebucket.
    const pb = materialGetOrNull(Material, entity)
    const matCase = pb?.material?.$case ?? 'none'
    const double = primitiveDoubleSided(spec) ? '2s' : '1s'
    return `${geoKey}|ic|${matCase}|${double}`
  }

  private maybeFreezeMeshRenderer(entity: Entity, obj: THREE.Object3D): void {
    if (!this.meshRendererShouldFreeze(entity)) return
    freezeStaticObject3D(obj)
  }

  private unfreezeMeshRenderersFromDiff(diff: Map<Entity, Map<number, ProjectionChangeKind>>): void {
    const { MeshRenderer, Animator, Billboard, Tween, AvatarAttach, Transform } = this.ecs
    for (const [entity, comps] of diff) {
      if (!MeshRenderer.has(entity)) continue
      // Continuous script motion (DecentraCraft temple spin/orbit/pulse) mutates Transform
      // every tick via getMutable — not Tween/Animator. Transform put must unfreeze too.
      const motion =
        comps.has(Transform.componentId) ||
        (Animator && comps.has(Animator.componentId)) ||
        (Billboard && comps.has(Billboard.componentId)) ||
        (Tween && comps.has(Tween.componentId)) ||
        (AvatarAttach && comps.has(AvatarAttach.componentId))
      if (!motion) continue
      const obj = this.store.nodes.get(entity)
      if (!obj) continue
      unfreezeObject3D(obj)
      // Promote only while still on GPU InstancedMesh — never re-attach private leaves every
      // frame (that rebuilt temple dishes each tick and killed spin/orbit motion).
      if (this.meshRendererInstancer.has(entity) || obj.userData.dclMeshRendererInstanced) {
        this.promoteMeshRendererForPointerOrMotion(entity, obj)
      }
    }
  }

  private replacePrimitiveMesh(
    obj: THREE.Group,
    mk: string,
    existing: THREE.Mesh | undefined,
    spec: ReturnType<MirrorComponents['MeshRenderer']['get']>,
    entity?: Entity
  ): THREE.Mesh {
    if (existing) {
      releasePrimitiveGeometry(existing.geometry)
      disposeMeshMaterials(existing)
      obj.remove(existing)
    }
    const geo = acquirePrimitiveGeometry(spec)
    const doubleSided = primitiveDoubleSided(spec)
    const key = primitiveMeshKey(spec)
    // Physical (not Standard) so MaterialApplier PBR path reuses without dispose thrash
    // (DecentraCraft multi-part temples set metallic/roughness/emissive on every part).
    const mat = new THREE.MeshPhysicalMaterial({
      color: 0xffffff,
      side: doubleSided ? THREE.DoubleSide : THREE.FrontSide,
      metalness: 0.2,
      roughness: 0.65
    })
    this.applyPlaneDepthBias(mat, spec, entity)
    const primitive = new THREE.Mesh(geo, mat)
    primitive.name = mk
    primitive.userData.primitiveMeshKey = key
    primitive.userData.primitiveDoubleSided = doubleSided
    if (entity !== undefined) primitive.userData.entity = entity
    const kind = primitiveKind(spec)
    primitive.userData.primitiveKind = kind
    // Solid architecture casts; dense ground planes stay non-casting (perf).
    // Env cast toggle lives in Preferences → Avatar / Environment shadows.
    const wantCast = kind !== 'plane' && !kind.startsWith('plane')
    setMeshDesiredCastShadow(primitive, wantCast, 'environment')
    primitive.receiveShadow = true
    this.bindDrawVisual(obj, primitive)
    return primitive
  }

  /**
   * GPU depth bias for small coplanar MeshRenderer plates (rocks under units).
   * Does not move meshes — Transform / Y from the scene are law.
   *
   * Large planes (fog-of-war cover, map hides) must NOT use polygonOffset: from a
   * top-down VirtualCamera the bias punches holes and the cover fails to hide the map.
   */
  private applyPlaneDepthBias(
    mat: THREE.Material,
    spec: ReturnType<MirrorComponents['MeshRenderer']['get']>,
    entity?: Entity
  ): void {
    if (primitiveKind(spec) !== 'plane') return
    if (entity != null && this.ecs.Transform?.has(entity)) {
      try {
        const s = (this.ecs.Transform.get(entity) as { scale?: { x?: number; y?: number; z?: number } })
          .scale
        const maxScale = Math.max(
          Math.abs(s?.x ?? 1),
          Math.abs(s?.y ?? 1),
          Math.abs(s?.z ?? 1)
        )
        // Fog-of-war / map cover tiles are large uniform planes (scale ≫ unit markers).
        if (maxScale >= 3.5) {
          mat.polygonOffset = false
          return
        }
      } catch {
        /* ignore */
      }
    }
    mat.polygonOffset = true
    // Small coplanar plates only — large covers skip offset above (platform law).
    mat.polygonOffsetFactor = PLANE_POLYGON_OFFSET_FACTOR
    mat.polygonOffsetUnits = PLANE_POLYGON_OFFSET_UNITS
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
    const spec = meshRendererGetOrNull(MeshRenderer, entity)
    if (!spec) return
    const planeUvsEarly = spec.mesh?.$case === 'plane' ? spec.mesh.plane?.uvs : undefined
    if (!planeUvsEarly || planeUvsEarly.length < 8) return
    const obj = this.store.nodes.get(entity)
    if (!obj) return

    const mk = meshKey(entity)
    const primitive = this.getEntityVisual(obj, mk) as THREE.Mesh | undefined
    if (!primitive?.isMesh) return

    const key = primitiveMeshKey(spec)
    if (primitive.userData.primitiveMeshKey === key) return
    // In-place UV for flipbook sprites. Marquee text-along-Y still rebuilds via
    // syncSpritePlaneVisual — but fishing splash cells must not hit that path every frame.
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
  tickDeferredMaterials(budgetMs = 8, maxEntities = 24): void {
    if (this.materialTickBusy) return
    if (!this.pendingMaterialEntities.size && !this.pendingGltfNodeModEntities.size) return
    // Instant path first — GPU-instanced board colors must not wait on texture budget.
    this.drainInstancedGltfMaterialPending()
    // After hydration, apply deferred textures even if the global defer gate is still set.
    const deferTextures = this.shouldDeferTextures() && this.hydrationMode
    if (deferTextures) return
    if (!this.pendingMaterialEntities.size && !this.pendingGltfNodeModEntities.size) return
    this.materialTickBusy = true
    // Prefer finishing textured MeshRenderer planes (ground/walls) under load.
    const texturedPending = this.pendingMaterialEntities.size
    const nodeModBoost = this.pendingGltfNodeModEntities.size > 0 ? 12 : 0
    const entityBoost =
      (this.pendingGltfNodeModEntities.size > 0 ? 16 : 0) +
      (texturedPending > 32 ? 32 : 0)
    const msBoost = texturedPending > 32 ? 24 : 0
    // Fire-and-forget — must not be awaited from the async frame path.
    void Promise.all([
      this.runMaterialPass(
        this.ecs.Material,
        budgetMs + nodeModBoost + msBoost,
        maxEntities + entityBoost,
        false
      ),
      this.runGltfNodeModifiersPass(budgetMs + nodeModBoost, maxEntities + entityBoost)
    ])
      .catch((err) => console.warn('[ThreeBridge] deferred material pass failed', err))
      .finally(() => {
        this.materialTickBusy = false
      })
  }

  /**
   * Apply pending Materials for GPU-instanced visuals (GLTF + MeshRenderer boards).
   * Non-instances stay in the set for the budgeted material pass — do not re-scan
   * thousands of non-instanced pending every frame (main-thread freeze).
   */
  private drainInstancedGltfMaterialPending(): void {
    if (!this.pendingMaterialEntities.size && !this.pendingGltfNodeModEntities.size) return
    const { Material, GltfNodeModifiers, MeshRenderer } = this.ecs
    const passStart = performance.now()
    // Dense boards recolor in storms — 3ms left paintDelta stuck until idle.
    const hardMs = 8
    if (this.pendingMaterialEntities.size) {
      for (const entity of [...this.pendingMaterialEntities]) {
        if (performance.now() - passStart >= hardMs) break
        const obj = this.store.nodes.get(entity)
        if (!obj || !Material.has(entity)) {
          this.pendingMaterialEntities.delete(entity)
          continue
        }
        const pb = Material.get(entity) as PbMaterial
        // GLTF GPU instances (plaza / tile GLBs with instanceColor).
        if (obj.userData.dclInstanced || this.instancer.has(entity)) {
          this.applyInstancedGltfMaterialNow(entity, obj, pb)
          continue
        }
        // MeshRenderer paint planes — must not wait on budgeted private-mesh pass.
        if (
          MeshRenderer?.has(entity) &&
          (obj.userData.dclMeshRendererInstanced || this.meshRendererInstancer.has(entity))
        ) {
          this.applyMeshRendererMaterialNow(entity, obj)
          continue
        }
        // Non-instances → budgeted runMaterialPass.
      }
    }
    if (this.pendingGltfNodeModEntities.size && GltfNodeModifiers) {
      for (const entity of [...this.pendingGltfNodeModEntities]) {
        if (performance.now() - passStart >= hardMs) break
        const obj = this.store.nodes.get(entity)
        if (!obj || !GltfNodeModifiers.has(entity)) {
          this.pendingGltfNodeModEntities.delete(entity)
          continue
        }
        if (!obj.userData.dclInstanced && !this.instancer.has(entity)) continue
        this.applyInstancedGltfNodeModifiersNow(entity, obj)
      }
    }
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

      // Scalar color-only modifiers on GPU instances → instanceColor (keep one draw).
      // Textures / video / multi-path need one private clone — do not drop the pending.
      if (obj.userData.dclInstanced || this.instancer.has(entity)) {
        const mods = GltfNodeModifiers.get(entity) as PBGltfNodeModifiers
        const tint = this.scalarTintFromGltfNodeModifiers(mods)
        if (tint && this.instancer.setInstanceColor(entity, tint.r, tint.g, tint.b)) {
          this.pendingGltfNodeModEntities.delete(entity)
          processed++
          continue
        }
        if (!obj.userData.dclPromotedForNodeMod) {
          obj.userData.dclPromotedForNodeMod = true
          this.promoteInstancedGltfForModifiers(entity, obj)
        }
        continue
      }

      const visual = this.getEntityVisual(obj, meshKey(entity)) ?? obj
      let hasMesh = false
      visual.traverse((c) => {
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
      if (ok || obj.userData.dclGltfNodeModPathMissLogged) {
        this.pendingGltfNodeModEntities.delete(entity)
      }
      processed++
    }
  }

  /**
   * Drop GPU instance → private clone for GltfNodeModifiers / late PE.
   * MUST sync-reattach like motion promote — async-only pending left orphan markers with
   * INSTANCE_COLLIDER_SHAPES wiped → PhysX floors gone (pixelwars freefall y→0).
   */
  private promoteInstancedGltfForModifiers(entity: Entity, obj: THREE.Group): void {
    this.promoteInstancedForMotion(entity, obj)
    // After clone (or pending attach), re-apply modifiers when component still present.
    if (this.ecs.GltfNodeModifiers?.has(entity)) {
      this.pendingGltfNodeModEntities.add(entity)
    }
  }

  /**
   * If every modifier is scalar-color-only (no textures/video), return a single tint.
   * Multi-path different colors → null (must private-clone).
   */
  private scalarTintFromGltfNodeModifiers(
    mods: PBGltfNodeModifiers
  ): { r: number; g: number; b: number } | null {
    const list = mods.modifiers ?? []
    if (!list.length) return null
    let tint: { r: number; g: number; b: number } | null = null
    for (const mod of list) {
      if (!mod.material) continue
      const pb = mod.material as PbMaterial
      if (!materialIsScalarOnly(pb)) return null
      const rgb = materialAlbedoRgb(pb)
      if (
        tint &&
        (Math.abs(tint.r - rgb.r) > 1e-4 ||
          Math.abs(tint.g - rgb.g) > 1e-4 ||
          Math.abs(tint.b - rgb.b) > 1e-4)
      ) {
        return null
      }
      tint = rgb
    }
    return tint
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

    // Prefer textured materials first without O(n log n) sort (plaza stall under load).
    const textured: Entity[] = []
    const scalar: Entity[] = []
    for (const entity of this.pendingMaterialEntities) {
      if (Material.has(entity) && !materialIsScalarOnly(Material.get(entity) as PbMaterial)) {
        textured.push(entity)
      } else {
        scalar.push(entity)
      }
    }
    const ordered = textured.length ? textured.concat(scalar) : scalar

    const { MeshRenderer } = this.ecs
    for (const entity of ordered) {
      if (processed >= maxEntities) break
      if (performance.now() - passStart >= budgetMs) break
      const obj = this.store.nodes.get(entity)
      if (!obj || !Material.has(entity)) {
        this.pendingMaterialEntities.delete(entity)
        continue
      }
      const pb = Material.get(entity) as PbMaterial
      // Instanced GLTF boards first (no private Mesh to walk).
      if (this.applyInstancedGltfMaterialNow(entity, obj, pb)) {
        processed++
        continue
      }
      // Instanced GLTF + textured Material: promote to private clone before map apply.
      // meshDirty already promotes once; Material-after-attach / deferred pass must too
      // or maps never land (white deal cards / emote prop materials).
      if (
        (obj.userData.dclInstanced || this.instancer.has(entity)) &&
        !materialIsScalarOnly(pb)
      ) {
        if (!obj.userData.dclPromotedForTextureMat) {
          obj.userData.dclPromotedForTextureMat = true
          this.promoteInstancedForMotion(entity, obj)
        }
        // Promote re-attaches async-ish; if still instanced or no visual yet, retry next tick.
        if (obj.userData.dclInstanced || this.instancer.has(entity)) {
          processed++
          continue
        }
        this.materials.clearEntity(entity)
      }
      // MeshRenderer: scalars-only attach must not skip textured maps. Previously
      // applyMeshRendererMaterialNow returned true after queue-pending and we
      // `continue`d without ever awaiting applyToObject3D — ground/wall planes stayed
      // on default white scalar forever (textured PE/click props never landed).
      if (MeshRenderer.has(entity)) {
        const attached = this.applyMeshRendererMaterialNow(entity, obj)
        if (!attached) {
          processed++
          continue
        }
        if (materialIsScalarOnly(pb)) {
          processed++
          continue
        }
        if (this.meshRendererInstancer.has(entity)) {
          // Textured must not stay GPU-instanced (no map path).
          this.promoteMeshRendererForPointerOrMotion(entity, obj)
        }
        const visual = this.entityVisualRoot(entity, obj)
        if (
          visual &&
          (visual as THREE.Mesh).isMesh &&
          !visual.userData[MESH_RENDERER_INSTANCE_MARKER]
        ) {
          if (deferTextures) {
            this.materials.applyScalarsToObject3D(visual, entity, pb)
            processed++
            continue
          }
          await this.materials.applyToObject3D(visual, entity, pb)
          this.notifyMeshComponent(entity, Material.componentId)
          if (!this.materials.needsReapply(entity, pb, visual)) {
            this.pendingMaterialEntities.delete(entity)
          } else {
            // Texture URL failed or pending — keep in set, kick async retry.
            this.kickTexturedMaterialApply(entity, obj, pb)
          }
        }
        processed++
        continue
      }
      const visual = this.entityVisualRoot(entity, obj)
      if (!visual) continue

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
    // Drop applied fingerprint — revive rebuilds a bare plane; stale fp would skip texture re-apply.
    this.materials.clearEntity(entity)
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
    const spec = meshRendererGetOrNull(MeshRenderer, entity)
    if (!spec) return
    const obj = this.store.getNode(entity)
    if (!obj) return

    const mk = meshKey(entity)
    const key = primitiveMeshKey(spec)
    const planeUvs = spec.mesh?.$case === 'plane' ? spec.mesh.plane?.uvs : undefined
    let primitive = this.getEntityVisual(obj, mk) as THREE.Mesh | undefined
    let rebuilt = false

    if (
      primitive?.isMesh &&
      primitive.userData.primitiveMeshKey !== key &&
      planeUvs?.length &&
      hasAnimatedPlaneUvs(spec) &&
      updatePlaneGeometryUvs(primitive.geometry, planeUvs)
    ) {
      primitive.userData.primitiveMeshKey = key
    } else if (!primitive?.isMesh || primitive.userData.primitiveMeshKey !== key) {
      primitive = this.replacePrimitiveMesh(obj, mk, primitive, spec, entity)
      this.notifyMeshComponent(entity, MeshRenderer.componentId)
      rebuilt = true
      this.materials.clearEntity(entity)
    }

    if (!touchMaterials || !Material.has(entity) || !primitive?.isMesh) return
    const pb = Material.get(entity) as PbMaterial
    if (rebuilt || this.materials.needsReapply(entity, pb, primitive)) {
      this.materials.applyScalarsToObject3D(primitive, entity, pb)
      if (this.materials.needsReapply(entity, pb, primitive)) {
        this.pendingMaterialEntities.add(entity)
      }
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
    this.attachedGltfEntities.delete(entity)
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
    this.attachedGltfEntities.clear()
    this.attachedSceneGltfCount = 0
    this.pendingMeshCursor = 0
    this.largeAttachQueue.length = 0
    this.largeAttachQueued.clear()
    this.largeAttachDraining = false
    this.instanceMotionHits.clear()
    this.instancer.dispose()
    this.meshRendererInstancer.dispose()
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
    this.attachedGltfEntities.delete(entity)
    if (obj.userData.dclInstanced) {
      this.instancer.detach(entity, obj)
      this.instanceMotionHits.delete(entity)
      delete obj.userData.dclInstanced
      delete obj.userData.dclInstanceTemplateTris
      removedGltf = true
    }
    const meshChild = this.getEntityVisual(obj, mk)
    if (meshChild && meshChild.userData.primitiveKind === undefined && meshChild.userData.primitiveMeshKey === undefined) {
      if (obj.userData.gltfSrcKey || meshChild.userData.dclInstanceMarker) removedGltf = true
      this.unbindDrawVisual(obj)
      disposeOwnedObject3D(meshChild)
      meshChild.removeFromParent()
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
    this.clearGltfVisual(entity, obj)
    // MeshRenderer GPU instances only have a marker Group — not a private Mesh.
    // Must detach or round-reset / tile teardown leaves colored instances visible forever
    // (pixelwars paint cells stay painted after game end).
    if (
      this.meshRendererInstancer.has(entity) ||
      obj.userData.dclMeshRendererInstanced ||
      obj.userData[MESH_RENDERER_INSTANCE_MARKER]
    ) {
      this.meshRendererInstancer.detach(entity, obj)
    }
    const textVis = this.getEntityVisual(obj, tk)
    if (textVis) {
      this.unbindDrawVisual(obj)
      disposeTextShapeMesh(textVis)
      textVis.removeFromParent()
    }
    const particleVis = obj.userData.dclDrawParticles as THREE.Object3D | undefined
    if (particleVis) {
      this.unbindDrawSlot(obj, 'dclDrawParticles')
      particleVis.removeFromParent()
    }
    const nftVis = obj.userData.dclDrawNft as THREE.Object3D | undefined
    if (nftVis) {
      this.unbindDrawSlot(obj, 'dclDrawNft')
      disposeOwnedObject3D(nftVis)
      nftVis.removeFromParent()
    }
    // Primitive MeshRenderer mesh (not glTF) — clearGltfVisual leaves these alone.
    // Also strip instancer markers left under __mesh_* if detach missed them.
    const primitive = this.getEntityVisual(obj, mk)
    if (primitive) {
      this.unbindDrawVisual(obj)
      if (primitive.userData[MESH_RENDERER_INSTANCE_MARKER] || primitive.userData.dclInstanceMarker) {
        primitive.removeFromParent()
      } else if (
        (primitive as THREE.Mesh).isMesh &&
        (primitive.userData.primitiveKind !== undefined ||
          primitive.userData.primitiveMeshKey !== undefined)
      ) {
        const mesh = primitive as THREE.Mesh
        releasePrimitiveGeometry(mesh.geometry)
        disposeMeshMaterials(mesh)
        mesh.removeFromParent()
      }
    }
    removeLightSource(obj, lk, (pose) => this.unbindDrawSlot(pose, 'dclDrawLight'))
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

  private lastFishXformLogAt = 0

  /**
   * Bobber/line: scene may leave VisibilityComponent.visible=false while aim/cast moves
   * the prop off the stash origin (or CRDT misses a show). Explorer still draws those —
   * force-show only when not stashed. Rods always honor ECS VisibilityComponent (GP keeps
   * the right-hand AvatarAttach socket forever and toggles rod visibility on cast/leave).
   */
  private applyFishingGameplayVisibility(
    entity: Entity,
    obj: THREE.Object3D,
    src: string
  ): void {
    if (!this.ecs.Transform.has(entity)) return
    const t = this.ecs.Transform.get(entity) as DclTransformValues
    if (Math.abs(t.scale.x) < 1e-3 || Math.abs(t.scale.y) < 1e-3) return

    if (isFishingBobberOrLineSrc(src)) {
      // Stash pool: near feet origin under water-line. Active aim/cast is pond coords.
      const stash = Math.hypot(t.position.x, t.position.z) < 1.5 && t.position.y < 0.5
      if (!stash) {
        obj.visible = true
        const mesh = obj.getObjectByName(meshKey(entity))
        if (mesh) {
          mesh.visible = true
          unfreezeObject3D(mesh)
        }
      }
      return
    }

    // Rod (and other non-bobber fishing GLBs): re-apply ECS visibility after mesh promote
    // so a private clone never stays lit when the scene authored visible=false.
    if (/(^|\/|_)(rod)(_|\.|\/|$)/i.test(src) || src.toLowerCase().includes('_rod') || src.toLowerCase().includes('rod.glb')) {
      const { VisibilityComponent } = this.ecs
      const visible = VisibilityComponent.has(entity)
        ? VisibilityComponent.get(entity).visible !== false
        : true
      obj.visible = visible
      const mesh = obj.getObjectByName(meshKey(entity))
      if (mesh) mesh.visible = visible
    }
  }

  /**
   * setBobberPosition / cast often arrive while plaza is still draining disco_cell GLBs.
   * Ensure fishing entities always have a live private clone (never orphan marker / GPU slot).
   */
  private ensureFishingMeshesLive(
    entities: Iterable<Entity>,
    meshEcs: Pick<MirrorComponents, 'MeshRenderer' | 'Material' | 'GltfContainer' | 'TextShape'>
  ): void {
    const { GltfContainer, VisibilityComponent } = this.ecs
    for (const entity of entities) {
      if (!GltfContainer.has(entity)) continue
      const src = GltfContainer.get(entity).src?.trim() ?? ''
      if (!isFishingMotionGltfSrc(src)) continue
      const obj = this.store.nodes.get(entity)
      if (!obj) continue

      // GP y_() hide rod (leave pond) — do not cold-load / force-show hidden rods.
      if (VisibilityComponent?.has(entity) && VisibilityComponent.get(entity).visible === false) {
        obj.visible = false
        obj.traverse((o) => {
          if ((o as THREE.Mesh).isMesh) o.visible = false
        })
        continue
      }

      obj.userData.dclForceCloneAttach = true
      obj.matrixAutoUpdate = true
      const mk = meshKey(entity)
      const mesh = this.getEntityVisual(obj, mk) as THREE.Object3D | undefined
      const needsAttach =
        !mesh ||
        !!mesh.userData.dclInstanceMarker ||
        !!obj.userData.dclInstanced ||
        obj.userData.gltfSrcKey !== (hashFromSrc(src, this.sceneConfig) ?? src.trim())

      if (needsAttach) {
        if (obj.userData.dclInstanced) {
          this.instancer.detach(entity, obj)
          this.instanceMotionHits.delete(entity)
        }
        delete obj.userData.dclInstanced
        this.removeMeshSlot(obj, mk)
        this.pendingMeshEntities.add(entity)
        // Attach this frame — aim bobber must not wait for mesh budget / disco queue.
        const savedBudget = this.gltfBudgetRemaining
        this.gltfBudgetRemaining = Math.max(this.gltfBudgetRemaining, 2)
        this.syncMeshSync(entity, obj, meshEcs, true)
        this.gltfBudgetRemaining = savedBudget
        if (!this.entityNeedsMeshWork(entity, obj, { includeMaterial: false })) {
          this.pendingMeshEntities.delete(entity)
        }
        const live = this.getEntityVisual(obj, mk)
        if (live) unfreezeObject3D(live)
        else if (FISH_GLTF_DIAG) {
          console.warn(
            `[fish] mesh still missing after force-attach e${entity as number} src=${src.split('/').pop()}`
          )
        }
      } else if (mesh) {
        unfreezeObject3D(mesh)
      }

      // Bobber: unstash force-show. Rod: re-sync ECS Visibility after promote/attach.
      this.applyFishingGameplayVisibility(entity, obj, src)
    }
  }

  /** Log transform upserts for fishing GLBs (bobber aim / cast landing). */
  private logFishingTransformUpserts(entities: Iterable<Entity>): void {
    // Default off — plaza multiplayer spam was measurable FPS cost (console every 250ms).
    if (!FISH_GLTF_DIAG) return
    const now = performance.now()
    if (now - this.lastFishXformLogAt < 1000) return
    const { GltfContainer, Transform, VisibilityComponent } = this.ecs
    for (const entity of entities) {
      if (!GltfContainer.has(entity) || !Transform.has(entity)) continue
      const src = GltfContainer.get(entity).src?.trim() ?? ''
      if (!isFishingMotionGltfSrc(src)) continue
      this.lastFishXformLogAt = now
      const obj = this.store.nodes.get(entity)
      if (!obj) {
        console.warn(`[fish] xform NO node e${entity as number} src=${src.split('/').pop()}`)
        continue
      }
      obj.updateWorldMatrix(true, false)
      obj.getWorldPosition(_fishLogWorld)
      const dcl = threeToDclVec(_fishLogWorld)
      const t = Transform.get(entity) as DclTransformValues
      const vis =
        VisibilityComponent.has(entity) ? VisibilityComponent.get(entity).visible !== false : true
      const mk = meshKey(entity)
      const mesh = this.getEntityVisual(obj, mk)
      let meshCount = 0
      mesh?.traverse((o) => {
        if ((o as THREE.Mesh).isMesh && o.visible) meshCount++
      })
      const line =
        `fish-xform e${entity as number} src=${src.split('/').pop()} ` +
        `world=(${dcl.x.toFixed(2)},${dcl.y.toFixed(2)},${dcl.z.toFixed(2)}) ` +
        `local=(${t.position.x.toFixed(2)},${t.position.y.toFixed(2)},${t.position.z.toFixed(2)}) ` +
        `scale=(${t.scale.x.toFixed(2)},${t.scale.y.toFixed(2)},${t.scale.z.toFixed(2)}) ` +
        `parent=${t.parent ?? 0} vis=${vis ? 1 : 0} mesh=${mesh ? 1 : 0} meshes=${meshCount} ` +
        `inst=${obj.userData.dclInstanced ? 1 : 0} groupVis=${obj.visible ? 1 : 0}`
      if (!mesh || meshCount === 0 || !vis || Math.abs(t.scale.x) < 1e-3) {
        console.warn(`[fish] ${line}`)
      } else {
        console.log(`[fish] ${line}`)
      }
    }
  }

  /** Plaza fishing bobber/line/rod — log attach pose so we can match setBobberPosition. */
  private logFishingGltfAttach(entity: Entity): void {
    if (!this.ecs.GltfContainer.has(entity)) return
    const src = this.ecs.GltfContainer.get(entity).src?.trim() ?? ''
    if (!isFishingMotionGltfSrc(src)) return
    const obj = this.store.nodes.get(entity)
    if (!obj) {
      console.warn(`[fish] attach NO node e${entity as number} src=${src}`)
      return
    }
    obj.updateWorldMatrix(true, false)
    obj.getWorldPosition(_fishLogWorld)
    const dcl = threeToDclVec(_fishLogWorld)
    const vis = obj.visible
    const inst = !!obj.userData.dclInstanced
    const clone = !!obj.userData.dclForceCloneAttach
    const attach = this.isAvatarAttachDriven(entity)
    const mk = meshKey(entity)
    const mesh = this.getEntityVisual(obj, mk)
    let meshCount = 0
    mesh?.traverse((o) => {
      if ((o as THREE.Mesh).isMesh && o.visible) meshCount++
    })
    const scale = obj.scale
    const line =
      `fish-gltf e${entity as number} src=${src.split('/').pop()} ` +
      `pos=(${dcl.x.toFixed(2)},${dcl.y.toFixed(2)},${dcl.z.toFixed(2)}) ` +
      `scale=(${scale.x.toFixed(2)},${scale.y.toFixed(2)},${scale.z.toFixed(2)}) ` +
      `vis=${vis ? 1 : 0} inst=${inst ? 1 : 0} forceClone=${clone ? 1 : 0} ` +
      `avatarAttach=${attach ? 1 : 0} meshes=${meshCount}` +
      (mesh?.userData.dclInstanceMarker ? ' ORPHAN_MARKER' : '')
    // Bad attaches always console; healthy only with ?ppidiag (mirror gate hid these).
    if (!mesh || meshCount === 0 || inst || mesh?.userData.dclInstanceMarker) {
      console.warn(`[fish] ${line}`)
    } else if (FISH_GLTF_DIAG) {
      console.log(`[fish] ${line}`)
    }
  }

  /**
   * Prefer GPU InstancedMesh for static same-hash GLBs; clone for anything that can
   * animate / follow independently (AvatarAttach props, Animator, motion tweens).
   *
   * AvatarAttach is the primary promote signal: rods, held props, and Transform
   * children of attach entities need a private hierarchy so bone-follow + local
   * animation are not shared InstancedMesh slots.
   */
  private canInstanceAttach(
    entity: Entity,
    template: { root: THREE.Group; animations: THREE.AnimationClip[] }
  ): boolean {
    // Prior motion / attach promote — stay on private clone.
    const existing = this.store.nodes.get(entity)
    if (existing?.userData.dclForceCloneAttach) return false
    // Outline shells need a private mesh (InstancedMesh has no per-entity children).
    if (this.gltfPointerWantsHighlight(entity)) return false
    // AvatarAttach (or child of attach) — always clone (fishing rod/line hierarchy).
    if (this.isAvatarAttachDriven(entity)) return false
    // Explicit ECS Animator needs a private hierarchy for the mixer.
    if (this.ecs.Animator.has(entity)) return false
    // Embedded clips (Spring flower scale 0.003, plaza banners) never play on
    // InstancedMesh — they stay at bind scale and fill the sky.
    if (template.animations.length > 0) return false
    // Billboard rotates the entity group. InstancedMesh lives under the scene root —
    // rotating the marker leaves the GPU slot world-fixed.
    if (this.ecs.Billboard?.has(entity)) return false
    // Material maps live on the shared template. Scalar albedo uses instanceColor.
    // Per-entity unique maps used to force a clone of every plaza pipe/chair.
    // Plaza fishing bobber/line/rod — always private clone (never GPU instance).
    if (this.ecs.GltfContainer.has(entity)) {
      const src = this.ecs.GltfContainer.get(entity).src?.trim() ?? ''
      if (isFishingMotionGltfSrc(src)) return false
    }
    // TextureMove / scale / move tweens need private hierarchy (bounce, bobber float).
    if (this.ecs.Tween.has(entity)) {
      const mode = this.ecs.Tween.get(entity).mode?.$case
      if (
        mode === 'textureMove' ||
        mode === 'textureMoveContinuous' ||
        mode === 'scale' ||
        mode === 'moveRotateScale' ||
        mode === 'move' ||
        mode === 'moveContinuous' ||
        mode === 'rotate' ||
        mode === 'rotateContinuous'
      ) {
        return false
      }
    }
    // PointerEvents hit InstancedMesh via resolveMeshRendererInstanceEntity.
    // MeshCollider: PhysX uses template collider shapes + entity pose for instances —
    // do NOT force clone (CBD puts MeshCollider on almost every prop).
    // GltfNodeModifiers: scalar color-only can use instanceColor (pixelwars boards).
    // Textures / video / multi-tint still force private clone.
    if (this.ecs.GltfNodeModifiers.has(entity)) {
      const mods = this.ecs.GltfNodeModifiers.get(entity) as PBGltfNodeModifiers
      if (!this.scalarTintFromGltfNodeModifiers(mods)) return false
    }
    return templateIsInstancable(template.root)
  }

  /**
   * True when entity has AvatarAttach, or walks Transform parents into one that does.
   * Held props + line/children of the rod must not share GPU instance slots.
   */
  private isAvatarAttachDriven(entity: Entity): boolean {
    const { AvatarAttach, Transform } = this.ecs
    if (!AvatarAttach) return false
    if (AvatarAttach.has(entity)) return true
    let current: Entity | undefined = entity
    const seen = new Set<Entity>()
    while (current !== undefined && !seen.has(current)) {
      seen.add(current)
      if (AvatarAttach.has(current)) return true
      if (!Transform.has(current)) break
      const parent = Transform.get(current).parent as Entity | undefined
      if (parent === undefined || parent === 0 || parent === (SDK_RESERVED.root as Entity)) break
      // Reserved PE/Camera parents are not avatar bone-attach anchors.
      if (parent === (SDK_RESERVED.player as Entity) || parent === (SDK_RESERVED.camera as Entity)) {
        break
      }
      current = parent
    }
    return false
  }

  /**
   * When AvatarAttach is added/updated, promote any GPU-instanced self + Transform
   * children to private clones so they can track bones / animate independently.
   */
  promoteAvatarAttachGltfs(entities: Iterable<Entity>): void {
    const { Transform, GltfContainer } = this.ecs
    const queue: Entity[] = []
    const seen = new Set<Entity>()
    for (const e of entities) {
      if (!seen.has(e)) {
        seen.add(e)
        queue.push(e)
      }
    }
    // One-level fan-out: children whose parent is in the seed set (rod → line, etc.).
    if (Transform) {
      for (const [child] of this.store.nodes) {
        if (seen.has(child)) continue
        if (!Transform.has(child)) continue
        const parent = Transform.get(child).parent as Entity | undefined
        if (parent !== undefined && seen.has(parent)) {
          seen.add(child)
          queue.push(child)
        }
      }
    }
    for (const entity of queue) {
      if (!GltfContainer.has(entity)) continue
      const obj = this.store.nodes.get(entity)
      if (!obj) continue
      if (obj.userData.dclInstanced) {
        this.promoteInstancedForMotion(entity, obj)
      } else if (!obj.userData.dclForceCloneAttach) {
        // Not yet attached or already a clone — force clone on next attach.
        obj.userData.dclForceCloneAttach = true
        if (this.entityNeedsMeshWork(entity, obj, { includeMaterial: false })) {
          this.pendingMeshEntities.add(entity)
        }
      }
    }
  }

  /**
   * True when the entity's GltfContainer template has embedded clips (default autoplay candidates).
   * Used to avoid bind-on-attach / instance-promote storms for static plaza props.
   */
  entityGltfHasAnimations(entity: Entity): boolean {
    if (!this.ecs.GltfContainer.has(entity)) return false
    const { src } = this.ecs.GltfContainer.get(entity)
    const trimmed = src?.trim() ?? ''
    if (!trimmed) return false
    const hash =
      /^(bafy|bafkre|Qm)/i.test(trimmed)
        ? trimmed
        : resolveGltfSrcHash(this.sceneConfig.content, trimmed)
    if (!hash) return false
    const template =
      this.cache.peekCached(hash) ??
      this.cache.peekCached(this.sceneConfig.assetUrl(hash)) ??
      this.cache.peekCached(this.gltfCacheKey(hash))
    return (template?.animations?.length ?? 0) > 0
  }

  /** Drop orphan `__mesh_*` instance markers (detach used to leave them on the entity). */
  private removeMeshSlot(obj: THREE.Object3D, mk: string): void {
    // Multiple stale markers can stack if promote failed mid-way — clear all matches.
    const doomed: THREE.Object3D[] = []
    for (const child of obj.children) {
      if (child.name === mk || child.userData.dclInstanceMarker) doomed.push(child)
    }
    for (const child of doomed) {
      obj.remove(child)
      disposeOwnedObject3D(child)
    }
  }

  /**
   * Sync promote InstancedMesh → private clone so AnimationMixer can bind.
   * Used when a rest-pose instance starts default autoplay near the camera.
   * Never promote static no-clip instances — that orphaned markers and wiped colliders.
   */
  ensureCloneMeshForAnimator(entity: Entity): THREE.Object3D | null {
    const obj = this.store.nodes.get(entity)
    if (!obj) return null
    const mk = `__mesh_${entity}`
    const existing = this.getEntityVisual(obj, mk) ?? null
    // Live private clone (real geometry, not GPU instance marker).
    if (
      existing &&
      !obj.userData.dclInstanced &&
      !existing.userData.dclInstanceMarker
    ) {
      obj.matrixAutoUpdate = true
      unfreezeObject3D(existing)
      return existing
    }
    if (!this.ecs.GltfContainer.has(entity)) return null
    const { src } = this.ecs.GltfContainer.get(entity)
    const hash =
      /^(bafy|bafkre|Qm)/i.test(src.trim())
        ? src.trim()
        : resolveGltfSrcHash(this.sceneConfig.content, src.trim())
    if (!hash) return null
    const template =
      this.cache.peekCached(hash) ?? this.cache.peekCached(this.sceneConfig.assetUrl(hash))
    if (!template) return null

    // Only promote when the template actually has clips — never for static instances.
    if (!template.animations.length && !this.ecs.Animator.has(entity)) {
      return null
    }

    const prevTris = (obj.userData.dclAttachedTris as number | undefined) ?? 0
    if (obj.userData.dclInstanced) {
      this.instancer.detach(entity, obj)
      this.instanceMotionHits.delete(entity)
    }
    delete obj.userData.dclInstanced
    delete obj.userData.gltfSrcKey
    delete obj.userData[INSTANCE_COLLIDER_SHAPES_KEY]
    obj.userData.dclForceCloneAttach = true
    // Critical: detach used to leave an empty marker named __mesh_* — getObjectByName
    // then preferred the marker over the real clone → 0 collider meshes / dead fire.
    this.removeMeshSlot(obj, mk)
    if (prevTris > 0) this.attachedSceneTris = Math.max(0, this.attachedSceneTris - prevTris)

    const templateTris =
      (template.root.userData.dclTriCount as number | undefined) ??
      (() => {
        const t = countObjectTriangles(template.root)
        template.root.userData.dclTriCount = t
        return t
      })()
    const srcKey = hash
    const ok = this.attachCachedGltf(entity, obj, mk, src, srcKey, hash, template, templateTris)
    if (!ok) return null
    // Mixer needs live matrices.
    obj.matrixAutoUpdate = true
    const mesh = this.getEntityVisual(obj, mk) ?? null
    if (mesh?.userData.dclInstanceMarker) {
      // Instance path re-won (shouldn't with forceClone) — refuse marker for mixer.
      return null
    }
    if (mesh) unfreezeObject3D(mesh)
    return mesh
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
          // Static instance host — skip per-frame local matrix rebuild.
          // Still bake world matrix now so PhysX INSTANCE_COLLIDER_SHAPES land at the right pose
          // (updateMatrix alone leaves matrixWorld stale → freefall until a later parent walk).
          obj.matrixAutoUpdate = false
          obj.updateMatrix()
          obj.updateMatrixWorld(true)
          const vis = this.ecs.VisibilityComponent
          if (vis?.has(entity) && vis.get(entity).visible === false) {
            obj.visible = false
          }
          this.instancer.update(entity, obj)
          enableSceneGltfVertexColors(template.root)
          // Material may have arrived before mesh attach — tint instance now.
          if (this.ecs.Material.has(entity)) {
            const pb = this.ecs.Material.get(entity) as PbMaterial
            this.applyInstancedGltfMaterialNow(entity, obj, pb)
          }
          if (this.ecs.GltfNodeModifiers?.has(entity)) {
            // Scalar tint same frame; non-scalar promote is handled in deferred pass.
            if (!this.applyInstancedGltfNodeModifiersNow(entity, obj)) {
              this.pendingGltfNodeModEntities.add(entity)
            }
          }
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
          this.bindDrawVisual(obj, clone)
          this.notifyMeshComponent(entity, this.ecs.GltfContainer.componentId)
          this.notifyGltfAttached(entity)
          this.attachedSceneGltfCount++
          this.attachedSceneTris += templateTris
          return true
        }
        if (isEmoteAnchorGltfSrc(src)) {
          disposeOwnedObject3D(clone)
          const anchor = new THREE.Group()
          anchor.name = mk
          obj.userData.emoteAnchor = true
          obj.add(anchor)
          this.notifyMeshComponent(entity, this.ecs.GltfContainer.componentId)
          this.notifyGltfAttached(entity)
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
      // Static rest / no ECS Animator: freeze leaf matrices (scene graph of 3k+ meshes
      // was rebuilding every frame). Animator promote re-enables autoUpdate.
      // Embedded clips (ABC fireparticles, plaza props) need live matrices for default
      // first-clip autoplay — freezing them leaves mixer TRS writes off-screen.
      // Fishing bobber/line/rod: never freeze — setBobberPosition + float Tweens every frame;
      // frozen host matrices left aim/cast meshes invisible or stuck at origin under load.
      const fishingMotion = isFishingMotionGltfSrc(src)
      if (
        !fishingMotion &&
        !this.ecs.Animator.has(entity) &&
        template.animations.length === 0
      ) {
        freezeStaticObject3D(clone)
        // Unique GLBs (theatre, buildings) cannot instance. Merge same-material
        // leaves including authored names — pointer still hits the entity.
        mergeStaticGltfLeaves(clone, { namedOk: true })
        obj.matrixAutoUpdate = false
        obj.updateMatrix()
      } else {
        obj.matrixAutoUpdate = true
        if (fishingMotion) unfreezeObject3D(clone)
      }
      this.bindDrawVisual(obj, clone)
      const visComp = this.ecs.VisibilityComponent
      if (visComp?.has(entity) && visComp.get(entity).visible === false) {
        obj.visible = false
        clone.visible = false
      }
      this.notifyMeshComponent(entity, this.ecs.GltfContainer.componentId)
      this.notifyGltfAttached(entity)
      this.attachedSceneGltfCount++
      this.attachedSceneTris += templateTris
      // Same-frame GltfNodeModifiers (event card posters) — don't wait for deferred budget.
      if (this.ecs.GltfNodeModifiers?.has(entity)) {
        this.pendingGltfNodeModEntities.add(entity)
        void this.flushGltfNodeModifiersEntity(entity)
      }
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
   * Apply GltfNodeModifiers for one entity immediately after mesh attach.
   * Plaza event cards put Texture.Common on path "" — deferred budget left posters
   * L–R mirrored until a late re-apply (or never under load).
   */
  private async flushGltfNodeModifiersEntity(entity: Entity): Promise<void> {
    const obj = this.store.nodes.get(entity)
    if (!obj || !this.ecs.GltfNodeModifiers?.has(entity)) return
    if (obj.userData.dclInstanced || this.instancer.has(entity)) {
      // Non-scalar modifiers need promote; deferred pass handles that.
      return
    }
    const visual = this.getEntityVisual(obj, meshKey(entity)) ?? obj
    let hasMesh = false
    visual.traverse((c) => {
      if ((c as THREE.Mesh).isMesh) hasMesh = true
    })
    if (!hasMesh) return
    const mods = this.ecs.GltfNodeModifiers.get(entity) as PBGltfNodeModifiers
    try {
      const ok = await applyGltfNodeModifiersToEntity(obj, mods, this.materials, {
        entity,
        logPathMiss: false
      })
      if (ok) this.pendingGltfNodeModEntities.delete(entity)
    } catch (err) {
      console.warn('[ThreeBridge] same-frame GltfNodeModifiers failed', entity, err)
    }
  }

  /**
   * Product of Transform.scale.x up the parent chain. Odd negatives (Poker Night boards use −1)
   * mirror TextShape canvas vs docs-order UVs — caller flips map U to compensate.
   */
  private textShapeWorldMirrorX(entity: Entity): boolean {
    const { Transform } = this.ecs
    let sx = 1
    let walk: Entity | undefined = entity
    for (let i = 0; i < 32 && walk !== undefined; i++) {
      if (!Transform.has(walk)) break
      const t = Transform.get(walk) as DclTransformValues
      sx *= t.scale?.x ?? 1
      const parent = t.parent as Entity | undefined
      if (
        parent === undefined ||
        parent === null ||
        (parent as number) === 0 ||
        parent === walk
      ) {
        break
      }
      walk = parent
    }
    return sx < 0
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
      let textMesh = this.getEntityVisual(obj, tk) as THREE.Mesh | undefined
      if (!textMesh || textMesh.name !== tk) {
        textMesh = obj.getObjectByName(tk) as THREE.Mesh | undefined
      }
      if (!textMesh) {
        const stale = this.getEntityVisual(obj, mk)
        if (stale) {
          this.unbindDrawVisual(obj)
          disposeOwnedObject3D(stale)
          obj.remove(stale)
        }
        textMesh = buildTextShapeMesh(spec)
        textMesh.name = tk
        this.bindDrawVisual(obj, textMesh)
        this.notifyMeshComponent(entity, TextShape.componentId)
      } else {
        if (textMesh.parent === obj) this.bindDrawVisual(obj, textMesh)
        updateTextShapeMesh(textMesh, spec)
        this.notifyMeshComponent(entity, TextShape.componentId)
      }
      // Poker Night casual board uses scale.x=-1 so Unity text faces the wall; compensate map U.
      applyTextShapeFacingMirror(textMesh, this.textShapeWorldMirrorX(entity))
      return
    }

    const staleText = this.getEntityVisual(obj, tk) ?? obj.getObjectByName(tk)
    if (staleText && staleText.name === tk) {
      this.unbindDrawVisual(obj)
      disposeTextShapeMesh(staleText)
      staleText.removeFromParent()
    }

    if (GltfContainer.has(entity)) {
      const { src } = GltfContainer.get(entity)
      const fishingMotion = isFishingMotionGltfSrc(src)
      // Fishing bobber/line/rod — never instance; attach this frame even under play budget=1.
      if (fishingMotion) obj.userData.dclForceCloneAttach = true
      const hash = hashFromSrc(src, this.sceneConfig)
      const srcKey = hash ?? src.trim()
      let mesh = this.getEntityVisual(obj, mk) as THREE.Object3D | undefined

      if (!hash) {
        this.setGltfLoadingState(entity, 2 /* NOT_FOUND */)
        if (fishingMotion || /pool\//i.test(src)) {
          clientDebugLog.log(
            'pointer',
            `fish-gltf e${entity as number} NOT_FOUND hash — src=${src}`,
            { level: 'warn', alsoConsole: true }
          )
        }
        return
      }

      if (!mesh || obj.userData.gltfSrcKey !== srcKey) {
        if (obj.userData.dclInstanced) {
          this.instancer.detach(entity, obj)
          delete obj.userData.dclInstanced
        }
        if (mesh) {
          this.unbindDrawVisual(obj)
          disposeOwnedObject3D(mesh)
          obj.remove(mesh)
        }

        const isLocal = hash.startsWith(GLTF_LOCAL_PREFIX)
        const url = isLocal ? hash.slice(GLTF_LOCAL_PREFIX.length) : this.sceneConfig.assetUrl(hash)
        const cacheKey = this.gltfCacheKey(isLocal ? url : hash)

        const hashDead =
          this.cache.hasGivenUp(cacheKey) ||
          (this.emptyGltfHashes.has(hash) && !isEmoteAnchorGltfSrc(src))
        if (hashDead) {
          this.setGltfLoadingState(entity, 3 /* FINISHED_WITH_ERROR */)
          if (fishingMotion) {
            clientDebugLog.log(
              'pointer',
              `fish-gltf e${entity as number} GIVEN_UP/EMPTY — src=${src}`,
              {
                level: 'warn',
                alsoConsole: true,
                throttleMs: 8_000,
                throttleKey: `fish-givenup-${entity}`
              }
            )
          }
          return
        }

        // In-flight / re-src — scene can poll LOADING until FINISHED.
        this.setGltfLoadingState(entity, 1 /* LOADING */)

        // Non-fishing: respect per-frame budget. Fishing: always proceed (cast must show bobber).
        if (!fishingMotion && this.gltfBudgetRemaining <= 0) return

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
          // Fishing: always schedule load even if budget exhausted.
          if (fishingMotion || this.gltfBudgetRemaining > 0) {
            if (!fishingMotion) this.gltfBudgetRemaining--
            this.scheduleBackgroundLoad(url, isLocal ? url : hash, cacheKey)
            if (fishingMotion) {
              const leaf = src.split('/').pop() ?? src
              clientDebugLog.log(
                'pointer',
                `fish-gltf COLD load scheduled — src=${leaf}`,
                { alsoConsole: true, throttleMs: 8_000, throttleKey: `fish-cold-${cacheKey}` }
              )
            }
          }
          return
        }

        // Large *clones* off the attach pass — except fishing (must not wait behind disco queue).
        if (
          !fishingMotion &&
          !obj.userData.dclForceIdleAttach &&
          templateTris >= ThreeBridge.LARGE_TEMPLATE_TRIS &&
          !this.canInstanceAttach(entity, template)
        ) {
          this.queueIdleGltfAttach(entity)
          return
        }

        if (!fishingMotion) this.gltfBudgetRemaining--
        if (!this.attachCachedGltf(entity, obj, mk, src, srcKey, hash, template, templateTris)) {
          if (fishingMotion) {
            clientDebugLog.log(
              'pointer',
              `fish-gltf e${entity as number} attachCached FAILED — src=${src}`,
              { level: 'warn', alsoConsole: true }
            )
          }
          return
        }
        mesh = this.getEntityVisual(obj, mk) as THREE.Object3D | undefined
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
      this.attachOrUpdateMeshRenderer(entity, obj, mk, touchMaterials)
    }
  }

  /**
   * MeshRenderer attach: T1 InstancedMesh when eligible; else T2/T3 private pooled mesh.
   * Material color flips update instanceColor without leaving the bucket.
   */
  private attachOrUpdateMeshRenderer(
    entity: Entity,
    obj: THREE.Group,
    mk: string,
    touchMaterials: boolean
  ): void {
    const { MeshRenderer, Material } = this.ecs
    const spec = meshRendererGetOrNull(MeshRenderer, entity)
    if (!spec) return
    this.trackSpritePoolEntity(entity)

    // Promote out of instance when no longer eligible.
    if (this.meshRendererInstancer.has(entity) && !this.meshRendererIsInstanceEligible(entity)) {
      this.meshRendererInstancer.detach(entity, obj)
      delete obj.userData.dclMeshRendererInstanced
    }

    if (this.meshRendererIsInstanceEligible(entity)) {
      // Drop private mesh if present (promote into instance bucket).
      const existing = this.getEntityVisual(obj, mk) as THREE.Mesh | undefined
      if (existing?.isMesh && !existing.userData[MESH_RENDERER_INSTANCE_MARKER]) {
        releasePrimitiveGeometry(existing.geometry)
        disposeMeshMaterials(existing)
        obj.remove(existing)
      }
      const pb = materialGetOrNull(Material, entity)
      // No Material yet — fall through to private white mesh so the leaf exists for PE/VFX.
      // Returning here left click markers with MeshRenderer-only stuck invisible until a
      // later Material put that never re-attached (pendingDiff peel races).
      if (!pb) {
        /* private path below */
      } else {
      const geo = acquirePrimitiveGeometry(spec)
      const rgb = materialAlbedoRgb(pb)
      const alpha = materialAlbedoAlpha(pb)
      // White base — per-entity color lives in instanceColor (no rebucket on flip).
      const doubleSided = primitiveDoubleSided(spec)
      const baseMat = new THREE.MeshBasicMaterial({
        color: 0xffffff,
        side: doubleSided ? THREE.DoubleSide : THREE.FrontSide
      })
      baseMat.userData.dclInstanceBase = true
      // Coplanar ground tiles: depth bias only — never change scene Transform (author law).
      this.applyPlaneDepthBias(baseMat, spec, entity)
      if (alpha < 0.999) {
        baseMat.transparent = true
        baseMat.opacity = alpha
        // Platform: ALPHA_BLEND surfaces write depth (occlude underlays). Markers force false.
        baseMat.depthWrite = true
      }
      // Instance base materials: blend band when transparent (marker path not used here).
      const bucketKey = this.meshRendererInstanceBucketKey(entity)
      // Geo/matCase bucket only — leave if already in this bucket (color stays instanceColor).
      const haveKey = this.meshRendererInstancer.bucketKey(entity)
      if (haveKey && haveKey !== bucketKey) {
        this.meshRendererInstancer.detach(entity, obj)
      }
      const ok = this.meshRendererInstancer.attach(entity, obj, bucketKey, geo, baseMat, mk, {
        color: rgb,
        useInstanceColor: true
      })
      baseMat.dispose() // instancer cloned it
      if (ok) {
        const marker = this.getEntityVisual(obj, mk)
        if (marker) {
          marker.userData.entity = entity
          marker.userData.primitiveMeshKey = primitiveMeshKey(spec)
        }
        this.notifyMeshComponent(entity, MeshRenderer.componentId)
        this.materials.markScalarApplied(entity, pb)
        this.pendingMaterialEntities.delete(entity)
        obj.matrixAutoUpdate = false
        obj.updateMatrix()
        obj.updateMatrixWorld(true)
        this.meshRendererInstancer.update(entity, obj)
        return
      }
      } // end else (has Material for instance path)
    }

    // T2/T3 private mesh path.
    if (this.meshRendererInstancer.has(entity)) {
      this.meshRendererInstancer.detach(entity, obj)
    }

    const key = primitiveMeshKey(spec)
    let primitive = this.getEntityVisual(obj, mk) as THREE.Mesh | undefined
    const meshKind = primitiveKind(spec)
    const planeUvs = spec.mesh?.$case === 'plane' ? spec.mesh.plane?.uvs : undefined

    let rebuilt = false
    if (
      primitive &&
      primitive.isMesh &&
      meshKind === 'plane' &&
      primitive.userData.primitiveMeshKey !== key &&
      planeUvs?.length &&
      hasAnimatedPlaneUvs(spec) &&
      updatePlaneGeometryUvs(primitive.geometry, planeUvs)
    ) {
      primitive.userData.primitiveMeshKey = key
    } else if (!primitive || !primitive.isMesh || primitive.userData.primitiveMeshKey !== key) {
      // Skip replace if marker-only leftover
      if (primitive?.userData[MESH_RENDERER_INSTANCE_MARKER]) {
        obj.remove(primitive)
        primitive = undefined
      }
      primitive = this.replacePrimitiveMesh(obj, mk, primitive, spec, entity)
      this.notifyMeshComponent(entity, MeshRenderer.componentId)
      rebuilt = true
      this.materials.clearEntity(entity)
    }

    if (touchMaterials && primitive) {
      const pb = materialGetOrNull(Material, entity)
      if (pb && (rebuilt || this.materials.needsReapply(entity, pb, primitive))) {
        this.materials.applyScalarsToObject3D(primitive, entity, pb)
        if (this.materials.needsReapply(entity, pb, primitive)) {
          this.pendingMaterialEntities.add(entity)
        }
      }
    }
    this.maybeFreezeMeshRenderer(entity, obj)
  }

}
