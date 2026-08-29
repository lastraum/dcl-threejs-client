import * as THREE from 'three'
import type { AssetCache } from '../../rendering/AssetCache'
import type { ResolvedScene } from '../content/types'
import { parseParcelKey } from '../content/parseParcel'
import { applyDclLocalTransform, dclToThreePos } from '../../bridge/dclTransform'
import { buildGenesisCityEmptyPlane } from './genesisEmptyPlane'
import {
  extractCompositeTransforms,
  fetchCompositeJson,
  neighborOriginOffset,
  planCompositeShell,
  resolveContentUrl,
  type CompositeGltfPlacement,
  type CompositeTransform
} from './compositeVisuals'
import {
  buildPointerOwnershipMap,
  fetchActiveEntitiesForPointers,
  findCompositeFile,
  isOpenRoadEntity,
  isSecondarySceneCandidate,
  type ActiveSceneEntity
} from './fetchActiveEntities'
import {
  distanceToParcelCenterM,
  GENESIS_CITY_FILL_ORIGIN,
  genesisMetersFromSceneLocal,
  minPlayerToFootprintDistanceM,
  parcelsInLoadRadius,
  parcelsNearFootprint
} from './parcelAoi'
import type { PhysicsColliderDesc } from '../../physics/PhysXWorld'
import {
  buildInstancedRoadLayer,
  ensureExplorerRoadsReady,
  resolveRoadTilePlacement,
  type RoadTilePlacement
} from './roadTiles'
import {
  getExplorerRoadEntry,
  isExplorerRoadParcel
} from './explorerRoadCatalog'
import { buildEmptyParcelScatter, isVacantForEmptyLayer } from './emptyParcelLayer'
import type { EzTreeGrassFieldHandle } from '../landscape/EzTreeGrassField'
import { SecondaryFirstFrameSampler } from './SecondaryFirstFrameSampler'
import { clientDebugLog } from '../../client/debug/ClientDebugLog'
import {
  aoiLiveGuests,
  aoiNeighborShells,
  aoiSceneDistanceVisuals,
  COMPOSITE_MAX_RETAINED,
  compositeMaxGltfsForDistance,
  visualWarmRadiusM,
  EMPTY_LAND_PHYS_RADIUS_M,
  ROAD_PHYS_RADIUS_M,
  secondaryLiveCap,
  secondaryLiveEnterRadiusM,
  secondaryLiveKeepRadiusM
} from '../multiScene/caps'
import { lastFrameOverBudget, scheduleOffPlayRaf, yieldToIdle } from '../../rendering/mainThreadYield'

/** Visible first-frame secondaries inside the inner radius. */
const FF_MAX_VISIBLE = 3
/**
 * Keep this many first-frame groups in memory (visible + hidden).
 * Leaving the inner ring **hides** instead of destroying — re-enter is free.
 * Oldest hidden groups are disposed when over this cap.
 */
const FF_MAX_RETAINED = 6

/**
 * Empty prop scatter (trees/rocks/grass) is **sticky**:
 * - Load vacant parcels inside Scene Distance on initial / prewarm load.
 * - Walking only **adds** newly entered vacant parcels (never remesh old ones).
 * - Leave-ring → **hide** (LOD), not dispose.
 * - Dispose mesh + PhysX only when player is > Scene Distance + 80 m.
 */
/** Cap new parcels meshed per drain tick (first ring fill is uncapped). */
const SCATTER_ADD_PER_REFRESH = 48
/** Incremental road parcels per leftover drain when Scene Distance disc is on. */
const ROAD_ADD_PER_DRAIN = 32
/** Near-max GLBs planned so LOD can upgrade without re-fetch. */
const COMPOSITE_PLAN_MAX_GLTFS = 24
/** Band change requires crossing the edge by this many meters. */
const SHELL_BAND_HYSTERESIS_M = 8
/** Hide at Scene Distance; dispose this far past SD. */
const SHELL_PURGE_PAST_SD_M = 80
/**
 * Coalesce multi-parcel sprints. Full rediscover only when the warm ring
 * actually needs new work — not every 16m step.
 */
const REFRESH_DEBOUNCE_MS = 600
/**
 * Min player move (meters) since last full discover before walking can re-discover.
 * ~8 parcels — brief walks must not re-scan 500 pointers.
 */
const DISCOVER_MIN_MOVE_M = 128
/** Clones to attach per leftover drain turn after play. */
const COMPOSITE_LOAD_PER_DRAIN = 1
/** Clones per drain while the loading overlay is up (first-ring neighbor shells). */
const COMPOSITE_LOAD_PER_PREWARM = 8
/** New occupied-scene shells to open per prewarm drain. */
const COMPOSITE_SHELLS_PER_PREWARM = 6
/** Feet move (m²) that counts as locomotion. */
const WALK_MOVE_EPS2 = 0.04 // ~0.2m
/**
 * True settle: no feet motion for this long before ANY heavy AOI work
 * (scatter drain, composite GLB, live-secondary emit). 350ms was too short —
 * brief walk pauses set walk=0 and thrashed discover+drain.
 */
const WALK_IDLE_MS = 2000

type StickyScatterLayer = {
  id: number
  root: THREE.Group
  colliders: PhysicsColliderDesc[]
  parcelKeys: string[]
  /** Genesis DCL meters (parcel 0,0 origin — not FocusOwner-local). */
  centerX: number
  centerZ: number
  /** Explorer-style GPU blades on vacant parcels; null if mesh load failed. */
  grass: EzTreeGrassFieldHandle | null
}

type AoiShellBand = 'near' | 'mid' | 'far' | 'hidden'

type AoiShellPlacement = {
  src: string
  url: string
  hash: string
  node: THREE.Object3D
  attached: boolean
}

type AoiShellRecord = {
  entityId: string
  neighborBase: string
  pose: THREE.Group
  visual: THREE.Group
  pendingSrcs: string[]
  attachedCount: number
  targetCount: number
  band: AoiShellBand
  bandLockUntilDist: { lo: number; hi: number } | null
  placements: AoiShellPlacement[]
  lastDistM: number
}

export type AoiVisualHost = {
  poseRoot: THREE.Object3D
  drawWorld: {
    register: (visual: THREE.Object3D, pose: THREE.Object3D) => void
    unregister: (visual: THREE.Object3D) => void
  }
  scene: THREE.Scene
}

export type AoiVisualLayerContext = {
  scene: ResolvedScene
  cache: AssetCache
  /** Pose + extract. Required for neighbor shells; city fill still uses hostScene. */
  host?: AoiVisualHost
  /** City fill (roads / scatter / empty plane) — sibling of draw-root. */
  hostScene: THREE.Scene
  /** Sync AOI road furniture colliders (real FBX hulls) into PhysX. */
  syncRoadColliders?: (descs: PhysicsColliderDesc[]) => void
  clearRoadColliders?: () => void
  /** Sync empty-land tree/rock simple box colliders into PhysX. */
  syncEmptyLandColliders?: (descs: PhysicsColliderDesc[]) => void
  clearEmptyLandColliders?: () => void
  /** Force-remove sticky scatter colliders after >1km purge (works post-seal). */
  purgeEmptyLandColliders?: (entityIds: number[]) => void
  /**
   * Inner-ring secondary candidates for live workers (MultiSceneRuntime).
   * Called after each AOI refresh; does not start workers itself.
   */
  onSecondaryCandidates?: (
    candidates: Array<{
      entityId: string
      title: string
      base: string
      resolveX: number
      resolveY: number
      distM: number
      parcelCount?: number
      parcels?: string[]
    }>
  ) => void
  /** View camera for frustum-first shell drain. */
  getCamera?: () => THREE.Camera | null
}

/**
 * Phase A2+ — coords-only AOI (radius = user Scene Distance warm band):
 * - Empty layer: **one Genesis City empty plane** + **sticky** trees/rocks +
 *   ez-tree GPU grass (load once in Scene Distance, add on walk, hide LOD, purge only >1km)
 * - Genesis roads via **Explorer catalog + OriginalAssets FBX** (tile + street
 *   furniture), not runtime SDK6 game.js
 * - Neighbor main.composite GLBs (render-only, no colliders / anim) — full Scene Distance
 * - First-frame samples for script-built scenes (tertiary when no live worker)
 * - Live secondary: nearest occupied scenes inside Scene Distance (empty/road excluded)
 */
export class AoiVisualLayer {
  private root = new THREE.Group()
  /**
   * Genesis-stable parent for dirt / roads / scatter. Children are authored vs
   * {@link GENESIS_CITY_FILL_ORIGIN}; this root is the only FocusOwner offset.
   */
  private readonly cityFillRoot = new THREE.Group()
  private blankRoot: THREE.Object3D | null = null
  /** True after the one Genesis dirt plane is built (never keyed to FocusOwner). */
  private blankPlaneReady = false
  /** Parent for sticky scatter layers (never rebuilt as a whole). */
  private readonly scatterRoot = new THREE.Group()
  private readonly scatterLayers: StickyScatterLayer[] = []
  /** Vacant parcels already meshed — never rebuild, only hide/purge. */
  private readonly loadedScatterParcels = new Set<string>()
  /**
   * Outstanding vacant parcels still needing scatter mesh.
   * Stand-still only runs work while this (or composite queue) is non-empty.
   */
  private readonly pendingScatterParcels = new Set<string>()
  private scatterLayerSeq = 0
  /** Entity ids with composite wanted but not yet a shell (drain while walking). */
  private readonly pendingCompositeIds = new Set<string>()
  private readonly loadedShells = new Map<string, AoiShellRecord>()
  private readonly aoiPoseRoot = new THREE.Group()
  private shellsTornDown = true
  private compositeRoot = new THREE.Group()
  private roadRoot = new THREE.Group()
  private readonly pendingRoadParcels = new Set<string>()
  private readonly loadedRoadParcelSet = new Set<string>()
  private readonly roadColliderDescs: PhysicsColliderDesc[] = []
  private lastRoadParcelEntities = new Map<string, ActiveSceneEntity | null>()
  private lastRoadPhysFeet = { x: Number.NaN, z: Number.NaN }
  private firstFrameRoot = new THREE.Group()
  private ctx: AoiVisualLayerContext | null = null
  private enabled = false
  private disposed = false
  private refreshGen = 0
  private lastParcelKey = ''
  private lastRadius = -1
  /** Player feet at last full ring discover (DCL scene-local). */
  private lastDiscoverFeet = { x: Number.NaN, z: Number.NaN }
  private lastDiscoverRadius = -1
  /** True after first successful full discover for this bind. */
  private hasDiscoveredOnce = false
  /** Pending debounced full refresh while walking across parcels. */
  private refreshDebounceTimer: ReturnType<typeof setTimeout> | null = null
  private pendingRefresh: { dclX: number; dclZ: number; radiusM: number } | null = null
  private lastDrainAt = 0
  private drainInFlight = false
  /** One off-play drain scheduled while presents stay over 33 ms. */
  private idleDrainScheduled = false
  private lastFeetSample = { x: Number.NaN, z: Number.NaN }
  private lastFeetMoveAt = 0
  /** Empty-land PhysX ids currently registered (near-player subset only). */
  private lastNearEmptyLandIds = new Set<number>()
  private lastEmptyLandPhysFeet = { x: Number.NaN, z: Number.NaN }
  /**
   * Background prewarm drain (forceUncapped) — MUST stop at play-ready.
   * Leaving this true was the “still draining while I walk” bug: load continued
   * after Jump In and ignored the settle gate.
   */
  private prewarmActive = false
  private prewarmGen = 0
  /** One-shot drain permission for force refresh (promote), not continuous. */
  private allowDrainOnce = false
  private readonly loadedRoadIds = new Set<string>()
  /** Sorted parcel keys currently baked into the instanced road layer. */
  private roadParcelSignature = ''
  /** Last live-secondary candidate id list (avoid spam + reconcile churn when identical). */
  private lastLiveCandidateSignature = ''
  /** Console line only when the bootable set changes (not every meter). */
  private lastLiveLogSignature = ''
  /** Avoid reprinting the same AOI budget line every retarget/discover. */
  private lastBudgetLogSignature = ''
  /** Cached after last discovery — composite drain without re-fetch. */
  private cachedEntities: ActiveSceneEntity[] = []
  private cachedPrimaryId = ''
  private cachedPrimaryBase = ''
  private cachedPointerSet = new Set<string>()
  /** entityId → first-frame visual group (may be hidden for LOD retain). */
  private readonly firstFrameGroups = new Map<string, THREE.Group>()
  /** Last time the group was wanted in the inner ring (LRU for eviction). */
  private readonly firstFrameLastUse = new Map<string, number>()
  private readonly primaryParcelSet = new Set<string>()
  /** True when primary has no entity — empty-land fill includes primary parcels. */
  private primaryIsEmpty = false
  private readonly firstFrameSampler = new SecondaryFirstFrameSampler()
  /** Live secondary workers — hide tertiary FF/composite for these entity ids. */
  private readonly liveSecondaryIds = new Set<string>()
  /** Live workers with meshes ready — hide composite shells only for these. */
  private readonly liveGraphReadyIds = new Set<string>()
  /**
   * Absolute parcel keys owned by sticky/live residents (demoted plaza, live secondaries).
   * Empty-land red ground MUST NOT paint these — that was the CBD void after promote.
   */
  private readonly residentParcelSet = new Set<string>()
  /**
   * When false, skip refresh (neighbor visuals + secondary candidates).
   * Primary mega-scenes must finish boot before AOI steals main thread.
   */
  private neighborActivityEnabled = false
  /**
   * Live secondary reconcile (workers). Visuals can prewarm earlier; workers wait
   * until play-ready so primary hydrate is alone.
   */
  private liveReconcileEnabled = false
  private readonly scratchFrustum = new THREE.Frustum()
  private readonly scratchProjView = new THREE.Matrix4()
  private readonly scratchBox = new THREE.Box3()
  private readonly scratchWorld = new THREE.Vector3()
  private readonly scratchSize = new THREE.Vector3(48, 24, 48)
  /** Seconds accumulated for vacant-grass wind. */
  private grassElapsed = 0
  private grassElapsedAt = 0

  constructor() {
    this.root.name = 'aoi-visual-layer'
    this.aoiPoseRoot.name = 'aoi-pose-root'
    this.cityFillRoot.name = 'aoi-city-fill'
    this.scatterRoot.name = 'aoi-empty-scatter-sticky'
    this.compositeRoot.name = 'aoi-composite-secondaries'
    this.roadRoot.name = 'aoi-road-tiles'
    this.firstFrameRoot.name = 'aoi-first-frame-secondaries'
    this.cityFillRoot.add(this.scatterRoot)
    this.cityFillRoot.add(this.roadRoot)
    this.root.add(this.cityFillRoot)
    this.root.add(this.compositeRoot)
    this.root.add(this.firstFrameRoot)
  }

  /**
   * Live secondary workers own these entity ids — hide tertiary first-frame
   * and composite meshes so we don't double-draw. **Restores** visibility when
   * a live worker is evicted (previously only hid, never re-showed).
   */
  /**
   * Live worker ids. Composite/first-frame shells stay visible until
   * {@link markLiveSecondaryGraphReady} — avoids flash/reload when the worker boots.
   */
  setLiveSecondaryIds(ids: ReadonlySet<string>): void {
    this.liveSecondaryIds.clear()
    for (const id of ids) this.liveSecondaryIds.add(id)
    // Drop ready marks for workers that left.
    for (const id of [...this.liveGraphReadyIds]) {
      if (!this.liveSecondaryIds.has(id)) this.liveGraphReadyIds.delete(id)
    }
    this.applyShellVisibility()
  }

  /**
   * Full secondary graph has meshes on host — safe to hide composite/first-frame shell.
   */
  markLiveSecondaryGraphReady(entityId: string): void {
    if (!entityId) return
    this.liveGraphReadyIds.add(entityId)
    this.applyShellVisibility()
  }

  private applyShellVisibility(): void {
    const primaryId = this.ctx?.scene.entityId?.trim() ?? ''
    for (const rec of this.loadedShells.values()) {
      rec.pose.visible =
        rec.band !== 'hidden' &&
        rec.entityId !== primaryId &&
        !this.liveGraphReadyIds.has(rec.entityId)
    }
    for (const [id, group] of this.firstFrameGroups) {
      group.visible = id !== primaryId && !this.liveGraphReadyIds.has(id)
    }
  }

  /**
   * Parcel footprints of sticky demoted + live secondary/tertiary residents.
   * Call before {@link retargetPrimary} refresh so empty-land does not paint red
   * over the prior primary (CBD void bug).
   */
  setResidentParcelKeys(keys: ReadonlyArray<string> | ReadonlySet<string>): void {
    this.residentParcelSet.clear()
    for (const k of keys) {
      const t = k.trim()
      if (t) this.residentParcelSet.add(t)
    }
  }

  /** Current resident parcel skip set (debug / World assert). */
  getResidentParcelKeys(): ReadonlySet<string> {
    return this.residentParcelSet
  }

  /**
   * Enable/disable neighbor AOI work (visuals + live candidates).
   * Call true after primary notifyPlayReady for live workers.
   * Visual prewarm may run earlier via {@link prewarmVisuals}.
   */
  setNeighborActivityEnabled(enabled: boolean): void {
    if (this.neighborActivityEnabled === enabled && this.liveReconcileEnabled === enabled) return
    this.neighborActivityEnabled = enabled
    this.liveReconcileEnabled = enabled
    if (enabled) {
      console.info('[aoi] neighbor activity ON (live guests + background shells)')
      // Stop uncapped scatter; keep background shell/tertiary drain.
      this.prewarmActive = false
      if (this.hasDiscoveredOnce && this.cachedEntities.length > 0) {
        const feet = this.liveEmitFeet()
        if (feet) {
          this.emitLiveSecondaryCandidatesOnly(
            this.cachedEntities,
            this.cachedPrimaryId,
            this.cachedPrimaryBase || this.ctx?.scene.baseParcel || '0,0',
            feet.x,
            feet.z,
            this.cachedPointerSet
          )
        }
      } else {
        this.hasDiscoveredOnce = false
        this.lastParcelKey = ''
      }
    } else {
      console.info('[aoi] neighbor activity OFF (primary booting)')
    }
  }

  /**
   * Multi-scene attach happens *after* play-ready. Candidate emits during
   * that gap hit a null/inactive runtime. Clear the signature so the next
   * update re-delivers bootable neighbors (Spring in the Snow, etc.).
   */
  kickLiveSecondaryReconcile(): void {
    this.lastLiveCandidateSignature = ''
    this.lastLiveLogSignature = ''
    const feet = this.liveEmitFeet()
    if (
      !this.liveReconcileEnabled ||
      !this.hasDiscoveredOnce ||
      this.cachedEntities.length === 0 ||
      !feet
    ) {
      return
    }
    this.emitLiveSecondaryCandidatesOnly(
      this.cachedEntities,
      this.cachedPrimaryId,
      this.cachedPrimaryBase || this.ctx?.scene.baseParcel || '0,0',
      feet.x,
      feet.z,
      this.cachedPointerSet
    )
  }

  /** Prefer last discover; never emit live candidates from (0,0) via `NaN || 0`. */
  private liveEmitFeet(): { x: number; z: number } | null {
    if (Number.isFinite(this.lastDiscoverFeet.x) && Number.isFinite(this.lastDiscoverFeet.z)) {
      return this.lastDiscoverFeet
    }
    if (Number.isFinite(this.lastFeetSample.x) && Number.isFinite(this.lastFeetSample.z)) {
      return this.lastFeetSample
    }
    return null
  }

  /** Abort in-flight prewarm drain loop (play-ready / unbind / dispose). */
  private cancelPrewarm(reason: string): void {
    if (!this.prewarmActive && this.prewarmGen === 0) return
    const was = this.prewarmActive
    this.prewarmGen++
    this.prewarmActive = false
    if (was) {
      console.info(
        `[aoi] prewarm cancelled (${reason}) — no more force-drain; ` +
          `pendingScatter=${this.pendingScatterParcels.size} pendingComposite=${this.pendingCompositeIds.size}` +
          ` shells=${this.loadedShells.size}`
      )
    }
  }

  /**
   * Discover the warm disc, then drain neighbor shells + scatter in the
   * **background**. Live-guest GLBs are a separate loading-screen wait.
   * Resolves after the first catalyst discover (not after every shell).
   */
  prewarmVisuals(dclX: number, dclZ: number): Promise<void> {
    if (this.disposed || !this.enabled || !this.ctx) return Promise.resolve()
    this.neighborActivityEnabled = true
    this.liveReconcileEnabled = false
    this.lastParcelKey = ''
    const radius = visualWarmRadiusM()
    const gen = ++this.prewarmGen
    this.prewarmActive = true
    console.info(
      `[aoi] discover neighbors @ feet=(${dclX.toFixed(1)},${dclZ.toFixed(1)}) ` +
        `radius=${radius}m — live-guest GLBs on load, shells/tertiary in background`
    )
    return this.runDiscoverThenBackgroundDrain(dclX, dclZ, radius, gen)
  }

  /** Allow live-guest candidate emit during the loading overlay (after discover). */
  enableLiveGuestReconcile(): void {
    this.liveReconcileEnabled = true
  }

  private async runDiscoverThenBackgroundDrain(
    dclX: number,
    dclZ: number,
    radiusM: number,
    gen: number
  ): Promise<void> {
    if (gen !== this.prewarmGen || this.disposed) return
    this.allowDrainOnce = true
    await this.refresh(dclX, dclZ, radiusM, 'full')
    if (gen !== this.prewarmGen || this.disposed) return
    console.info(
      `[aoi] neighbor discover ready entities=${this.cachedEntities.length} ` +
        `shells pending=${this.pendingCompositeIds.size} — background drain starts`
    )
    void this.runBackgroundNeighborDrain(dclX, dclZ, gen)
  }

  /** Neighbor shells + scatter + tertiary fill — does not block Jump In. */
  private async runBackgroundNeighborDrain(
    dclX: number,
    dclZ: number,
    gen: number
  ): Promise<void> {
    let guard = 0
    while (
      gen === this.prewarmGen &&
      !this.disposed &&
      this.ctx &&
      this.hasOutstandingWork() &&
      guard++ < 200
    ) {
      await this.drainOutstandingWork(
        dclX,
        dclZ,
        this.refreshGen,
        /*forceUncapped*/ this.prewarmActive,
        /*allow*/ true,
        /*allowOverBudget*/ true
      )
      await new Promise<void>((r) => setTimeout(r, this.prewarmActive ? 0 : 32))
    }
    if (gen !== this.prewarmGen) return
    console.info(
      `[aoi] background neighbor drain done scatter=${this.loadedScatterParcels.size} ` +
        `shells=${this.loadedShells.size} pendingComposite=${this.pendingCompositeIds.size}`
    )
  }

  /**
   * Promote handoff: retarget primary footprint **without** wiping tertiary meshes.
   * Full {@link bind} → unbind cleared the CBD plaza ring into void.
   */
  retargetPrimary(scene: ResolvedScene, dclX: number, dclZ: number): void {
    if (this.disposed || scene.source.kind !== 'coords') return
    if (!this.ctx) {
      // First bind only when layer never attached.
      return
    }
    const newBase = scene.baseParcel.trim()
    this.ctx = {
      ...this.ctx,
      scene
    }
    this.enabled = true
    this.primaryIsEmpty = !scene.entityId?.trim() && !scene.mainEntry?.trim()
    this.primaryParcelSet.clear()
    for (const p of scene.parcels) this.primaryParcelSet.add(p)
    // Must write before LOD/purge — leftover update() still runs mid-fetch.
    this.cachedPrimaryBase = scene.baseParcel
    this.lastDiscoverFeet = { x: Number.NaN, z: Number.NaN }
    // Keep composites/roads; force full rediscover under new primary + feet.
    this.lastParcelKey = ''
    this.lastRadius = -1
    this.hasDiscoveredOnce = false
    this.neighborActivityEnabled = true
    // Live worker reconcile stays off until settle (caller enables via setNeighborActivityEnabled).
    this.liveReconcileEnabled = false
    // City fill stays a hostScene sibling. Pose shells stay on aoi-pose-root.
    if (!this.root.parent && this.ctx.hostScene) {
      this.ctx.hostScene.add(this.root)
    }
    if (this.ctx.host && !this.aoiPoseRoot.parent) {
      this.ctx.host.poseRoot.add(this.aoiPoseRoot)
    }
    const newPrimaryId = scene.entityId?.trim() ?? ''
    // Keep the composite shell until the adopted worker has GPU (avoid a hole
    // while instancer rebakes). Hide later via markLiveSecondaryGraphReady.
    if (newPrimaryId) this.liveGraphReadyIds.delete(newPrimaryId)
    this.applyCityFillOrigin(newBase)
    this.rebakeShellPoses(newBase)
    this.applyShellVisibility()
    if (this.ctx) {
      this.syncNearRoadPhys(this.ctx, dclX, dclZ, /*force*/ true)
      this.syncNearEmptyLandPhys(this.ctx, dclX, dclZ, /*force*/ true)
    }
    console.info(
      `[aoi] retarget primary “${scene.title}” base=${newBase} ` +
        `(preserve tertiary — no unbind wipe)`
    )
    this.lastLiveCandidateSignature = ''
    void this.refresh(dclX, dclZ, visualWarmRadiusM(), 'full')
  }

  /** Call after primary scene is known — coords only. */
  bind(ctx: AoiVisualLayerContext): void {
    this.unbind()
    this.disposed = false
    this.ctx = ctx
    this.enabled = ctx.scene.source.kind === 'coords'
    this.neighborActivityEnabled = false
    this.liveReconcileEnabled = false
    this.primaryIsEmpty = !ctx.scene.entityId?.trim() && !ctx.scene.mainEntry?.trim()
    this.primaryParcelSet.clear()
    this.liveSecondaryIds.clear()
    this.liveGraphReadyIds.clear()
    this.residentParcelSet.clear()
    for (const p of ctx.scene.parcels) this.primaryParcelSet.add(p)
    this.loadedRoadIds.clear()
    this.roadParcelSignature = ''
    this.clearFirstFrameGroups()
    this.firstFrameSampler.reset()
    this.lastParcelKey = ''
    this.lastRadius = -1
    if (!this.enabled) return
    this.applyCityFillOrigin(ctx.scene.baseParcel)
    ctx.hostScene.add(this.root)
    if (ctx.host) ctx.host.poseRoot.add(this.aoiPoseRoot)
    else if (aoiNeighborShells()) {
      console.warn('[aoi] neighbor shells on but ctx.host missing — pass poseRoot + drawWorld')
    }
    console.info(
      '[aoi] bound — Scene Distance warm band (coords only); radius=',
      visualWarmRadiusM(),
      'm · first-frame visible≤',
      FF_MAX_VISIBLE,
      ' retained≤',
      FF_MAX_RETAINED,
      ' · FocusOwner=primary · neighbors deferred until play-ready',
      this.primaryIsEmpty ? '(empty primary)' : ''
    )
  }

  unbind(): void {
    this.refreshGen++
    this.clearRefreshDebounce()
    this.clearBlank()
    this.clearScatter()
    this.teardownShells()
    this.compositeRoot.clear()
    this.clearRoads()
    this.clearFirstFrameGroups()
    this.loadedRoadIds.clear()
    this.roadParcelSignature = ''
    this.lastLiveCandidateSignature = ''
    this.lastLiveLogSignature = ''
    this.pendingScatterParcels.clear()
    this.pendingCompositeIds.clear()
    this.cachedEntities = []
    this.cachedPointerSet.clear()
    this.hasDiscoveredOnce = false
    this.lastDiscoverFeet = { x: Number.NaN, z: Number.NaN }
    this.lastDiscoverRadius = -1
    this.lastFeetSample = { x: Number.NaN, z: Number.NaN }
    this.lastFeetMoveAt = 0
    this.drainInFlight = false
    this.idleDrainScheduled = false
    this.cancelPrewarm('unbind')
    this.allowDrainOnce = false
    this.neighborActivityEnabled = false
    this.liveReconcileEnabled = false
    this.lastParcelKey = ''
    this.lastRadius = -1
    this.liveSecondaryIds.clear()
    this.liveGraphReadyIds.clear()
    this.residentParcelSet.clear()
    this.primaryParcelSet.clear()
    this.firstFrameSampler.reset()
    this.aoiPoseRoot.removeFromParent()
    this.root.removeFromParent()
    this.ctx = null
    this.enabled = false
    this.primaryIsEmpty = false
  }

  dispose(): void {
    this.disposed = true
    this.firstFrameSampler.dispose()
    this.unbind()
  }

  /**
   * AOI tick from player feet (scene-local DCL meters).
   * Clock 1 (LOD / near PhysX / discover schedule) always runs.
   * Mesh drain never starts on a hot present — it idle-schedules instead.
   * Full rediscover stays 128 m + 600 ms.
   */
  update(dclX: number, dclZ: number, force = false): void {
    if (this.disposed || !this.enabled || !this.ctx) return
    if (!this.neighborActivityEnabled && !force) return
    const radius = visualWarmRadiusM()

    if (radius <= 0) {
      this.clearRefreshDebounce()
      if (this.lastRadius !== 0) {
        this.clearBlank()
        this.clearScatter()
        this.teardownShells()
        this.compositeRoot.clear()
        this.clearRoads()
        this.clearFirstFrameGroups()
        this.loadedRoadIds.clear()
        this.roadParcelSignature = ''
        this.pendingCompositeIds.clear()
        this.firstFrameSampler.reset()
        this.lastRadius = 0
        this.hasDiscoveredOnce = false
        if (this.primaryIsEmpty) void this.refreshEmptyPrimaryOnly()
      } else if (this.primaryIsEmpty && !this.blankRoot) {
        void this.refreshEmptyPrimaryOnly()
      }
      return
    }

    const base = this.ctx.scene.baseParcel
    const center = {
      x: parseParcelKey(base).x + Math.floor(dclX / 16),
      y: parseParcelKey(base).y + Math.floor(dclZ / 16)
    }
    const parcelKey = `${center.x},${center.y}`
    const now = performance.now()
    const movedParcel = parcelKey !== this.lastParcelKey
    const radiusChanged = radius !== this.lastRadius

    if (!Number.isFinite(this.lastFeetSample.x)) {
      this.lastFeetSample = { x: dclX, z: dclZ }
      this.lastFeetMoveAt = now
    } else {
      const fdx = dclX - this.lastFeetSample.x
      const fdz = dclZ - this.lastFeetSample.z
      if (fdx * fdx + fdz * fdz > WALK_MOVE_EPS2) {
        this.lastFeetSample = { x: dclX, z: dclZ }
        this.lastFeetMoveAt = now
      }
    }

    this.updateStickyScatterLod(dclX, dclZ)
    this.tickVacantGrass()
    this.maybeSyncNearEmptyLandPhys(dclX, dclZ)
    this.maybeSyncNearRoadPhys(dclX, dclZ)
    this.updateShellLod(dclX, dclZ)

    if (force) {
      this.clearRefreshDebounce()
      this.lastParcelKey = parcelKey
      this.lastRadius = radius
      this.allowDrainOnce = this.hasOutstandingWork()
      void this.refresh(dclX, dclZ, radius, 'full')
      return
    }

    if (radiusChanged) {
      this.lastParcelKey = parcelKey
      this.lastRadius = radius
      this.scheduleDiscover(dclX, dclZ, radius)
    } else if (movedParcel) {
      this.lastParcelKey = parcelKey
      this.lastRadius = radius
      if (this.shouldFullDiscover(dclX, dclZ, radius)) {
        this.scheduleDiscover(dclX, dclZ, radius)
      }
    }

    if (
      this.liveReconcileEnabled &&
      this.cachedEntities.length > 0 &&
      aoiLiveGuests()
    ) {
      this.emitLiveSecondaryCandidatesOnly(
        this.cachedEntities,
        this.cachedPrimaryId,
        this.cachedPrimaryBase || base,
        dclX,
        dclZ,
        this.cachedPointerSet
      )
    }

    if (!this.hasOutstandingWork()) return
    if (this.drainInFlight) return
    if (now - this.lastDrainAt < 400) return
    // Present tick is host-only. Mesh drain is always off-play after load.
    if (!this.prewarmActive) {
      this.scheduleIdleDrain(dclX, dclZ)
      return
    }
    this.lastDrainAt = now
    void this.drainOutstandingWork(dclX, dclZ)
  }

  /**
   * Plaza presents stay over 33 ms for long stretches. Skipping drain then
   * leaves neighbor composites (e.g. Spring in the Snow) in the queue forever.
   * Attach off the play rAF — one clone per idle turn.
   */
  private scheduleIdleDrain(dclX: number, dclZ: number): void {
    if (this.idleDrainScheduled || this.drainInFlight || this.disposed) return
    this.idleDrainScheduled = true
    scheduleOffPlayRaf(() => {
      this.idleDrainScheduled = false
      if (this.disposed || !this.enabled || !this.ctx) return
      if (this.drainInFlight || !this.hasOutstandingWork()) return
      this.lastDrainAt = performance.now()
      void this.drainOutstandingWork(dclX, dclZ, undefined, false, false, true)
    }, 64)
  }

  /** No feet motion for {@link WALK_IDLE_MS} — safe for main-thread mesh work. */
  private isPlayerSettled(now = performance.now()): boolean {
    if (this.prewarmActive) return true
    if (!Number.isFinite(this.lastFeetMoveAt) || this.lastFeetMoveAt <= 0) {
      // Unknown / never moved — do NOT treat as settled after play (was auto-drain bug).
      return false
    }
    return now - this.lastFeetMoveAt >= WALK_IDLE_MS
  }

  /**
   * Dev budget line: how big the warm ring is vs how many scripts we might run.
   * - warmParcels = player Scene Distance disc (+ primary collar)
   * - uniqueEntities = catalyst deployments returned for that pointer set
   * - liveEligible = occupied-scene distance ≤ Scene Distance (empty/road excluded)
   * - liveRunning = currently loaded secondary workers (cap is separate)
   */
  private logAoiBudget(opts: {
    warmParcels: number
    playerParcels: number
    primaryAdjacentParcels: number
    uniqueEntities: number
    radiusM: number
    primaryId: string
    entities: ActiveSceneEntity[]
    pointerSet: Set<string>
    dclX: number
    dclZ: number
    primaryBase: string
  }): void {
    const enterM = secondaryLiveEnterRadiusM()
    const keepM = secondaryLiveKeepRadiusM()
    const liveCap = secondaryLiveCap('high')
    let scriptableInWarm = 0
    let liveEligible = 0
    for (const e of opts.entities) {
      if (opts.primaryId && e.id === opts.primaryId) continue
      if (isOpenRoadEntity(e)) continue
      if (!isSecondarySceneCandidate(e)) continue
      const keys = (e.pointers.length ? e.pointers : e.parcels).map((p) => p.trim())
      if (!keys.some((p) => opts.pointerSet.has(p))) continue
      scriptableInWarm++
      if (enterM <= 0) continue
      const dist = minPlayerToFootprintDistanceM(opts.dclX, opts.dclZ, keys, opts.primaryBase)
      if (Number.isFinite(dist) && dist <= enterM) liveEligible++
    }
    const sig = [
      opts.warmParcels,
      opts.uniqueEntities,
      scriptableInWarm,
      liveEligible,
      this.liveSecondaryIds.size,
      opts.radiusM
    ].join('|')
    if (sig === this.lastBudgetLogSignature) return
    this.lastBudgetLogSignature = sig
    console.info(
      `[aoi] budget warmParcels=${opts.warmParcels} (playerDisc=${opts.playerParcels}` +
        ` +primaryCollar=${opts.primaryAdjacentParcels}) ` +
        `uniqueEntities=${opts.uniqueEntities} scriptableInWarm=${scriptableInWarm} ` +
        `liveEligible=${liveEligible} liveRunning=${this.liveSecondaryIds.size} liveCap=${liveCap} ` +
        `sceneDist=${opts.radiusM}m liveEnter=${enterM}m liveKeep=${keepM}m ` +
        `shells=${this.loadedShells.size} ` +
        `(warm=player feet · live guests=player→occupied footprint, empty excluded)`
    )
  }

  private hasPendingShellAttaches(): boolean {
    for (const rec of this.loadedShells.values()) {
      if (rec.attachedCount < rec.targetCount && rec.pendingSrcs.length > 0) return true
    }
    return false
  }

  private hasOutstandingWork(): boolean {
    if (this.pendingScatterParcels.size > 0) return true
    if (this.pendingRoadParcels.size > 0) return true
    if (aoiNeighborShells() && this.ctx?.host) {
      if (this.pendingCompositeIds.size > 0 && this.loadedShells.size < COMPOSITE_MAX_RETAINED) {
        return true
      }
      if (this.hasPendingShellAttaches()) return true
    }
    return false
  }

  /** True when we need a full warm-ring rediscover (not every parcel step). */
  private shouldFullDiscover(dclX: number, dclZ: number, radiusM: number): boolean {
    if (!this.hasDiscoveredOnce) return true
    if (this.lastDiscoverRadius !== radiusM) return true
    if (!Number.isFinite(this.lastDiscoverFeet.x)) return true
    const dx = dclX - this.lastDiscoverFeet.x
    const dz = dclZ - this.lastDiscoverFeet.z
    return dx * dx + dz * dz >= DISCOVER_MIN_MOVE_M * DISCOVER_MIN_MOVE_M
  }

  private clearRefreshDebounce(): void {
    if (this.refreshDebounceTimer != null) {
      clearTimeout(this.refreshDebounceTimer)
      this.refreshDebounceTimer = null
    }
    this.pendingRefresh = null
  }

  private scheduleDiscover(dclX: number, dclZ: number, radiusM: number): void {
    this.pendingRefresh = { dclX, dclZ, radiusM }
    if (this.refreshDebounceTimer != null) return
    this.refreshDebounceTimer = setTimeout(() => {
      this.refreshDebounceTimer = null
      const p = this.pendingRefresh
      this.pendingRefresh = null
      if (!p || this.disposed || !this.ctx) return
      // Re-sample settle at fire time — if still walking, enqueue-only path.
      void this.refresh(p.dclX, p.dclZ, p.radiusM, 'full')
    }, REFRESH_DEBOUNCE_MS)
  }

  /**
   * @param mode `full` = scatter/roads/composites; `light` = entities (cache) + live candidates only.
   */
  private async refresh(
    dclX: number,
    dclZ: number,
    radiusM: number,
    mode: 'full' | 'light' = 'full'
  ): Promise<void> {
    const ctx = this.ctx
    if (!ctx || this.disposed) return
    // Light path must not cancel an in-flight full refresh (gen thrash).
    const gen = mode === 'full' ? ++this.refreshGen : this.refreshGen
    const base = ctx.scene.baseParcel
    // Player warm band (composites/roads) ∪ primary-footprint collar so nested
    // hole scenes stay discoverable when you stand on the far side of a multi-parcel primary.
    const playerPointers = parcelsInLoadRadius(dclX, dclZ, base, radiusM)
    const keepM = secondaryLiveKeepRadiusM()
    const primaryAdjacent =
      keepM > 0 && this.primaryParcelSet.size
        ? parcelsNearFootprint([...this.primaryParcelSet], keepM)
        : []
    const pointers = [...new Set([...playerPointers, ...primaryAdjacent])]
    if (!pointers.length) return

    // Warm Explorer road catalog early so vacant layer can skip road parcels.
    if (mode === 'full') {
      await ensureExplorerRoadsReady()
      if (gen !== this.refreshGen || this.disposed || this.ctx !== ctx) return
    }

    const entities = await fetchActiveEntitiesForPointers(ctx.scene.realm.contentUrl, pointers)
    if (mode === 'full' && (gen !== this.refreshGen || this.disposed || this.ctx !== ctx)) return
    if (this.disposed || this.ctx !== ctx) return

    // Prefer multi-parcel scenes over classic roads when claims collide.
    const pointerToEntity = buildPointerOwnershipMap(entities)
    const pointerSet = new Set(pointers)
    const primaryId = ctx.scene.entityId?.trim() ?? ''

    // Cache for standstill drain (no re-fetch while outstanding work remains).
    this.cachedEntities = entities
    this.cachedPrimaryId = primaryId
    this.cachedPrimaryBase = base
    this.cachedPointerSet = pointerSet

    // Budget snapshot: warm ring vs live-script band (always log on discover).
    this.logAoiBudget({
      warmParcels: pointers.length,
      playerParcels: playerPointers.length,
      primaryAdjacentParcels: primaryAdjacent.length,
      uniqueEntities: entities.length,
      radiusM,
      primaryId,
      entities,
      pointerSet,
      dclX,
      dclZ,
      primaryBase: base
    })

    const mayDrainThisRefresh =
      this.prewarmActive || this.allowDrainOnce || aoiNeighborShells() || this.hasOutstandingWork()
    if (this.liveReconcileEnabled && aoiLiveGuests()) {
      this.emitLiveSecondaryCandidatesOnly(entities, primaryId, base, dclX, dclZ, pointerSet)
    }

    if (mode === 'light') return

    // Real deployed scenes in the ring (not vacant/catalyst-empty) — never scatter trees on these.
    // Include every in-ring parcel of a multi-parcel deployment if *any* of its parcels are in ring.
    const realSceneFootprint = new Set<string>()
    for (const ent of entities) {
      if (ent.id === primaryId) continue
      if (isOpenRoadEntity(ent)) continue
      if (isVacantForEmptyLayer(ent)) continue
      if (!isSecondarySceneCandidate(ent) && !ent.main) continue
      const keys = (ent.pointers.length ? ent.pointers : ent.parcels).map((p) => p.trim())
      const anyInRing = keys.some((p) => pointerSet.has(p) || pointerSet.has(p.trim()))
      if (!anyInRing) continue
      for (const p of keys) {
        if (pointerSet.has(p) || pointerSet.has(p.trim())) realSceneFootprint.add(p.trim())
      }
    }
    // Sticky demoted / live workers (CBD plaza as tertiary) — never empty-land scatter.
    for (const p of this.residentParcelSet) realSceneFootprint.add(p)
    for (const p of this.primaryParcelSet) {
      if (!this.primaryIsEmpty) realSceneFootprint.add(p)
    }
    for (const ent of entities) {
      if (ent.id && this.liveSecondaryIds.has(ent.id)) {
        for (const p of ent.pointers.length ? ent.pointers : ent.parcels) {
          if (pointerSet.has(p.trim())) realSceneFootprint.add(p.trim())
        }
      }
    }

    // --- Genesis City empty plane + sticky vacant scatter (add-only, LOD hide, purge >1km).
    // Load every vacant parcel in Scene Distance once; walking only appends newly entered parcels.
    const vacantKeys: string[] = []
    let skippedScatter = 0
    for (const key of pointers) {
      const k = key.trim()
      if (isExplorerRoadParcel(key) || isExplorerRoadParcel(k)) continue
      const ent = pointerToEntity.get(key) ?? pointerToEntity.get(k)
      if (ent && isOpenRoadEntity(ent)) continue
      // Never scatter under primary / sticky residents / live secondaries / real scenes.
      if (realSceneFootprint.has(k) || realSceneFootprint.has(key)) {
        skippedScatter++
        continue
      }
      if (!isVacantForEmptyLayer(ent)) {
        skippedScatter++
        continue
      }
      vacantKeys.push(key)
    }

    // Sticky city plane — only rebuild when primary base changes (promote retarget).
    await this.ensureGenesisEmptyPlane(ctx, gen, base)
    if (gen !== this.refreshGen || this.disposed || this.ctx !== ctx) return

    // Enqueue vacant parcels not yet meshed — drain pulls from this queue only.
    // Visual band only (keep ≤ 80 m). Scene Distance 200 m still fetched pointers above.
    const visualM = visualWarmRadiusM()
    for (const key of vacantKeys) {
      const k = key.trim()
      if (this.loadedScatterParcels.has(k)) continue
      try {
        const p = parseParcelKey(k)
        if (distanceToParcelCenterM(dclX, dclZ, p, base) > visualM) continue
      } catch {
        continue
      }
      this.pendingScatterParcels.add(k)
    }
    // Drop pending that are no longer vacant in this ring (real scene claimed, etc.).
    for (const k of [...this.pendingScatterParcels]) {
      if (this.loadedScatterParcels.has(k)) {
        this.pendingScatterParcels.delete(k)
        continue
      }
      // Keep pending outside current ring — may re-enter; only drop if now real footprint.
      if (realSceneFootprint.has(k)) this.pendingScatterParcels.delete(k)
      try {
        const p = parseParcelKey(k)
        if (distanceToParcelCenterM(dclX, dclZ, p, base) > visualM) {
          this.pendingScatterParcels.delete(k)
        }
      } catch {
        this.pendingScatterParcels.delete(k)
      }
    }

    // --- Classic open-road foundation tiles (catalog + ownership, full Scene Distance) ---
    await this.refreshRoadTiles(entities, pointerToEntity, base, gen, ctx, dclX, dclZ, pointers)
    if (gen !== this.refreshGen || this.disposed || this.ctx !== ctx) return

    this.lastDiscoverFeet = { x: dclX, z: dclZ }
    this.lastDiscoverRadius = radiusM
    this.hasDiscoveredOnce = true

    if (!aoiNeighborShells()) {
      this.teardownShells()
      this.clearFirstFrameGroups()
      this.firstFrameSampler.reset()
    } else {
      this.enqueueCompositeWork(entities, primaryId, pointerSet, dclX, dclZ, base)
    }

    if (mayDrainThisRefresh) {
      await this.drainOutstandingWork(dclX, dclZ, gen, this.prewarmActive, mayDrainThisRefresh)
    }
    this.allowDrainOnce = false
    if (gen !== this.refreshGen || this.disposed || this.ctx !== ctx) return

    if (aoiNeighborShells()) {
      this.queueFirstFrameSecondaries(entities, primaryId, base, dclX, dclZ, pointerSet)
    }

    if (gen === this.refreshGen) {
      let ffVis = 0
      for (const g of this.firstFrameGroups.values()) if (g.visible) ffVis++
      let pendingAttach = 0
      for (const rec of this.loadedShells.values()) {
        if (rec.attachedCount < rec.targetCount) pendingAttach += rec.targetCount - rec.attachedCount
      }
      clientDebugLog.consoleOnly(
        'info',
        `[aoi] discover parcels=${pointers.length} vacant=${vacantKeys.length} footprint=${realSceneFootprint.size} roads=${this.loadedRoadIds.size} shells=${this.loadedShells.size}/${COMPOSITE_MAX_RETAINED} pending=${this.pendingCompositeIds.size} attach=${pendingAttach} firstFrame=${ffVis}/${this.firstFrameGroups.size} pendingScatter=${this.pendingScatterParcels.size} radius=${radiusM}m settled=${this.isPlayerSettled() ? '1' : '0'}`
      )
    }
  }

  /**
   * Complete outstanding scatter / composite / road work from queues.
   * Hot presents skip and idle-schedule. `allowOverBudget` is the idle path.
   */
  private async drainOutstandingWork(
    dclX: number,
    dclZ: number,
    genHint?: number,
    forceUncappedScatter = false,
    _allow = false,
    allowOverBudget = false
  ): Promise<void> {
    const ctx = this.ctx
    if (!ctx || this.disposed || this.drainInFlight) return
    if (forceUncappedScatter && !this.prewarmActive) {
      return
    }
    if (!this.prewarmActive && !allowOverBudget && lastFrameOverBudget(33)) {
      this.scheduleIdleDrain(dclX, dclZ)
      return
    }
    this.drainInFlight = true
    const gen = genHint ?? this.refreshGen
    try {
      const uncapped =
        (forceUncappedScatter && this.prewarmActive) || this.loadedScatterParcels.size === 0
      if (this.pendingScatterParcels.size > 0) {
        await this.drainPendingScatter(
          ctx,
          gen,
          this.cachedPrimaryBase || ctx.scene.baseParcel,
          dclX,
          dclZ,
          uncapped
        )
      }
      if (gen !== this.refreshGen || this.disposed || this.ctx !== ctx) return

      this.updateStickyScatterLod(dclX, dclZ)
      this.purgeFarScatterLayers(ctx, dclX, dclZ)
      this.syncNearEmptyLandPhys(ctx, dclX, dclZ, /*force*/ true)

      if (this.pendingRoadParcels.size > 0) {
        await this.drainPendingRoads(ctx, gen, dclX, dclZ)
      }
      if (gen !== this.refreshGen || this.disposed || this.ctx !== ctx) return
      this.syncNearRoadPhys(ctx, dclX, dclZ, /*force*/ true)

      if (
        aoiNeighborShells() &&
        ctx.host &&
        (allowOverBudget || !lastFrameOverBudget(33))
      ) {
        await this.drainPendingComposites(ctx, gen, dclX, dclZ, allowOverBudget)
      }
    } finally {
      this.drainInFlight = false
    }
  }

  /**
   * Mark composite candidates as outstanding (add-only).
   * New shells inside {@link visualWarmRadiusM}; already-loaded stay until SD+80 purge.
   */
  private enqueueCompositeWork(
    entities: ActiveSceneEntity[],
    primaryId: string,
    pointerSet: Set<string>,
    dclX: number,
    dclZ: number,
    primaryBase: string
  ): void {
    const warmM = visualWarmRadiusM()
    if (warmM <= 0 || !this.ctx?.host) return
    for (const e of entities) {
      if (primaryId && e.id === primaryId) continue
      if (this.liveGraphReadyIds.has(e.id) || this.liveSecondaryIds.has(e.id)) continue
      if (!isSecondarySceneCandidate(e) || !findCompositeFile(e.content)) continue
      if (this.loadedShells.has(e.id)) {
        this.pendingCompositeIds.delete(e.id)
        continue
      }
      const keys = e.pointers.length ? e.pointers : e.parcels
      const inRing = keys.filter((p) => pointerSet.has(p.trim()))
      if (
        inRing.length > 0 &&
        inRing.every((p) => this.primaryParcelSet.has(p.trim())) &&
        !this.primaryIsEmpty
      ) {
        continue
      }
      if (!keys.some((p) => pointerSet.has(p.trim()))) continue
      const best = minPlayerToFootprintDistanceM(
        dclX,
        dclZ,
        keys.map((k) => k.trim()).filter(Boolean),
        primaryBase
      )
      if (Number.isFinite(best) && best > warmM) continue
      this.pendingCompositeIds.add(e.id)
    }
  }

  private entityDistM(
    e: ActiveSceneEntity,
    dclX: number,
    dclZ: number,
    primaryBase: string
  ): number {
    const keys = (e.pointers.length ? e.pointers : e.parcels).map((k) => k.trim()).filter(Boolean)
    return minPlayerToFootprintDistanceM(dclX, dclZ, keys, primaryBase)
  }

  private evictShellsIfNeeded(dclX: number, dclZ: number): void {
    const primaryBase = this.cachedPrimaryBase || this.ctx?.scene.baseParcel || '0,0'
    while (this.loadedShells.size >= COMPOSITE_MAX_RETAINED) {
      const ranked = [...this.loadedShells.values()]
        .map((rec) => {
          const ent = this.cachedEntities.find((c) => c.id === rec.entityId)
          const parcels = ent ? ent.parcels.length || ent.pointers.length : 0
          const dist = ent ? this.entityDistM(ent, dclX, dclZ, primaryBase) : rec.lastDistM
          return { rec, dist, mega: parcels >= 16 }
        })
        .sort((a, b) => {
          if (a.mega !== b.mega) return a.mega ? 1 : -1
          return b.dist - a.dist
        })
      const drop = ranked[0]
      if (!drop) break
      this.disposeShell(drop.rec.entityId)
    }
  }

  private disposeShell(entityId: string): void {
    const rec = this.loadedShells.get(entityId)
    if (!rec) return
    this.ctx?.host?.drawWorld.unregister(rec.visual)
    rec.pose.removeFromParent()
    rec.visual.removeFromParent()
    disposeObject3D(rec.visual)
    rec.pose.clear()
    this.loadedShells.delete(entityId)
    this.pendingCompositeIds.delete(entityId)
  }

  private teardownShells(): void {
    if (this.shellsTornDown && this.loadedShells.size === 0 && this.pendingCompositeIds.size === 0) {
      return
    }
    for (const id of [...this.loadedShells.keys()]) this.disposeShell(id)
    this.pendingCompositeIds.clear()
    this.shellsTornDown = true
  }

  private rebakeShellPoses(primaryBase: string): void {
    for (const rec of this.loadedShells.values()) {
      const offset = neighborOriginOffset(rec.neighborBase, primaryBase)
      dclToThreePos(offset.x, 0, offset.z, rec.pose.position)
      rec.pose.updateMatrix()
      rec.pose.updateMatrixWorld(true)
      rec.visual.userData.dclDrawStatic = false
    }
  }

  /**
   * Express the Genesis city-fill frame in the current FocusOwner world.
   * Children stay at parcel-0,0 local; only this root moves on promote.
   */
  private applyCityFillOrigin(primaryBase: string): void {
    const o = neighborOriginOffset(GENESIS_CITY_FILL_ORIGIN, primaryBase)
    dclToThreePos(o.x, 0, o.z, this.cityFillRoot.position)
    this.cityFillRoot.updateMatrix()
    this.cityFillRoot.updateMatrixWorld(true)
  }

  private genesisFeet(dclX: number, dclZ: number): { x: number; z: number } {
    const base = this.cachedPrimaryBase || this.ctx?.scene.baseParcel || GENESIS_CITY_FILL_ORIGIN
    return genesisMetersFromSceneLocal(dclX, dclZ, base)
  }

  /** PhysX is FocusOwner-local — bake Genesis-local collider matrices through the city-fill root. */
  private bakeCityFillColliders(descs: PhysicsColliderDesc[]): PhysicsColliderDesc[] {
    this.cityFillRoot.updateMatrixWorld(false)
    const parent = this.cityFillRoot.matrixWorld
    return descs.map((d) => ({
      ...d,
      matrix: new THREE.Matrix4().multiplyMatrices(parent, d.matrix)
    }))
  }

  private updateShellLod(dclX: number, dclZ: number): void {
    if (!this.loadedShells.size) return
    const d = visualWarmRadiusM()
    const primaryBase = this.cachedPrimaryBase || this.ctx?.scene.baseParcel || '0,0'
    const purgeM = d + SHELL_PURGE_PAST_SD_M
    for (const rec of [...this.loadedShells.values()]) {
      const ent = this.cachedEntities.find((c) => c.id === rec.entityId)
      const dist = ent ? this.entityDistM(ent, dclX, dclZ, primaryBase) : rec.lastDistM
      rec.lastDistM = dist
      if (Number.isFinite(dist) && dist > purgeM) {
        this.disposeShell(rec.entityId)
        continue
      }
      this.applyShellBand(rec, dist, d)
    }
    this.applyShellVisibility()
  }

  private applyShellBand(rec: AoiShellRecord, distM: number, warmM: number): void {
    const lock = rec.bandLockUntilDist
    let band = rec.band
    if (!lock || distM < lock.lo || distM > lock.hi) {
      band = shellBandForDistance(distM, warmM)
      rec.band = band
      rec.bandLockUntilDist = shellBandLock(band, warmM)
    }
    const nextTarget = band === 'hidden' ? 0 : compositeMaxGltfsForDistance(distM, 1)
    if (nextTarget === rec.targetCount) {
      this.applyPlacementLod(rec)
      return
    }
    rec.targetCount = nextTarget
    this.applyPlacementLod(rec)
  }

  private applyPlacementLod(rec: AoiShellRecord): void {
    for (let i = 0; i < rec.placements.length; i++) {
      const p = rec.placements[i]!
      if (!p.attached) continue
      p.node.visible = i < rec.targetCount
    }
  }

  private async createEmptyShell(
    ent: ActiveSceneEntity,
    ctx: NonNullable<typeof this.ctx>,
    gen: number,
    dclX: number,
    dclZ: number
  ): Promise<void> {
    const host = ctx.host
    if (!host) {
      this.pendingCompositeIds.delete(ent.id)
      return
    }
    // Sticky / live graph already on host — a second 24-GLB plaza shell is 6 fps.
    if (this.liveGraphReadyIds.has(ent.id) || this.liveSecondaryIds.has(ent.id)) {
      this.pendingCompositeIds.delete(ent.id)
      return
    }
    const comp = findCompositeFile(ent.content)
    if (!comp) {
      this.pendingCompositeIds.delete(ent.id)
      return
    }
    const primaryBase = this.cachedPrimaryBase || ctx.scene.baseParcel
    const distM = this.entityDistM(ent, dclX, dclZ, primaryBase)
    const targetCount = compositeMaxGltfsForDistance(distM, ent.parcels.length || ent.pointers.length)
    if (targetCount <= 0) {
      this.pendingCompositeIds.delete(ent.id)
      return
    }

    await yieldToIdle(48)
    if (gen !== this.refreshGen || this.disposed || this.ctx !== ctx) return

    const json = await fetchCompositeJson(ctx.scene.realm.contentUrl, comp.hash)
    if (gen !== this.refreshGen || this.disposed || this.ctx !== ctx) return
    if (!json) {
      this.pendingCompositeIds.delete(ent.id)
      return
    }

    const planned = planCompositeShell(json, { maxGltfs: COMPOSITE_PLAN_MAX_GLTFS })
    if (!planned.placements.length) {
      this.pendingCompositeIds.delete(ent.id)
      return
    }

    this.evictShellsIfNeeded(dclX, dclZ)
    if (this.loadedShells.has(ent.id)) {
      this.pendingCompositeIds.delete(ent.id)
      return
    }

    const pose = new THREE.Group()
    pose.name = `aoi-shell:${ent.id}`
    pose.userData.aoiEntityId = ent.id
    pose.userData.neighborBase = ent.base
    const origin = neighborOriginOffset(ent.base, primaryBase)
    dclToThreePos(origin.x, 0, origin.z, pose.position)

    const visual = new THREE.Group()
    visual.name = `aoi-shell-visual:${ent.id}`

    const transforms = extractCompositeTransforms(json)
    const nodes = buildShellHierarchy(visual, transforms, planned.placements)
    const placements: AoiShellPlacement[] = []
    const pendingSrcs: string[] = []
    for (const place of planned.placements) {
      const resolved = resolveContentUrl(place.src, ent.content, ctx.scene.realm.contentUrl)
      if (!resolved) continue
      const node = nodes.get(place.entityId) ?? visual
      placements.push({
        src: place.src,
        url: resolved.url,
        hash: resolved.hash,
        node,
        attached: false
      })
      pendingSrcs.push(place.src)
    }
    if (!placements.length) {
      this.pendingCompositeIds.delete(ent.id)
      return
    }

    this.aoiPoseRoot.add(pose)
    host.drawWorld.register(visual, pose)

    const warmM = visualWarmRadiusM()
    const band = shellBandForDistance(distM, warmM)
    const rec: AoiShellRecord = {
      entityId: ent.id,
      neighborBase: ent.base,
      pose,
      visual,
      pendingSrcs,
      attachedCount: 0,
      targetCount,
      band,
      bandLockUntilDist: shellBandLock(band, warmM),
      placements,
      lastDistM: distM
    }
    rec.pose.visible = band !== 'hidden' && !this.liveGraphReadyIds.has(ent.id)
    this.loadedShells.set(ent.id, rec)
    this.pendingCompositeIds.delete(ent.id)
    this.shellsTornDown = false
    console.info(
      `[aoi] shell “${ent.title || ent.base}” entity=${ent.id.slice(0, 16)}… ` +
        `dist≈${distM.toFixed(0)}m band=${band} target=${targetCount}/${placements.length}`
    )
  }

  private async attachOneShellClone(
    rec: AoiShellRecord,
    ctx: NonNullable<typeof this.ctx>,
    gen: number
  ): Promise<void> {
    if (rec.attachedCount >= rec.targetCount || rec.pendingSrcs.length === 0) return
    const src = rec.pendingSrcs[0]!
    const place = rec.placements.find((p) => p.src === src && !p.attached)
    if (!place) {
      rec.pendingSrcs.shift()
      return
    }

    await yieldToIdle(48)
    if (gen !== this.refreshGen || this.disposed || this.ctx !== ctx) return
    if (!this.loadedShells.has(rec.entityId)) return

    try {
      const { root, animations } = await ctx.cache.load(place.url, place.hash)
      if (gen !== this.refreshGen || this.disposed || this.ctx !== ctx) return
      if (!this.loadedShells.has(rec.entityId)) return

      const clone = root.clone(true)
      const clip = animations[0]
      if (clip) {
        const mixer = new THREE.AnimationMixer(clone)
        mixer.clipAction(clip).play()
        mixer.setTime(0)
        mixer.stopAllAction()
        mixer.uncacheRoot(clone)
      }
      clone.traverse((node) => {
        if (/collider/i.test(node.name)) node.visible = false
        if ((node as THREE.Mesh).isMesh) {
          node.castShadow = false
          node.userData.dclDrawStatic = true
          node.matrixAutoUpdate = false
          node.updateMatrix()
        }
      })
      clone.position.set(0, 0, 0)
      clone.quaternion.identity()
      clone.scale.set(1, 1, 1)
      clone.name = `aoi-gltf:${src.split('/').pop() ?? 'mesh'}`
      place.node.add(clone)
      place.node = clone
      place.attached = true
      rec.pendingSrcs.shift()
      rec.attachedCount++
      this.applyPlacementLod(rec)
    } catch (err) {
      rec.pendingSrcs.shift()
      console.warn('[aoi] shell clone failed', rec.entityId, src, err)
    }
  }

  /**
   * Live-guest candidates: occupied scenes only (empty/road excluded).
   * Distance = player feet → neighbor footprint (not the whole primary estate).
   */
  private emitLiveSecondaryCandidatesOnly(
    entities: ActiveSceneEntity[],
    primaryId: string,
    primaryBase: string,
    dclX: number,
    dclZ: number,
    pointerSet: Set<string>
  ): void {
    // Prewarm visuals only — do not boot workers until play-ready.
    if (!this.liveReconcileEnabled) {
      return
    }
    const enterM = secondaryLiveEnterRadiusM()
    const keepM = secondaryLiveKeepRadiusM()
    if (enterM <= 0 || keepM <= 0) {
      this.emitLiveCandidatesIfChanged([])
      return
    }

    const scriptBuilt = entities.filter((e) => {
      if (primaryId && e.id === primaryId) return false
      if (!isSecondarySceneCandidate(e)) return false
      if (isOpenRoadEntity(e)) return false
      const keys = e.pointers.length ? e.pointers : e.parcels
      if (!keys.some((p) => pointerSet.has(p.trim()))) return false
      return true
    })

    const withPlayerDist = scriptBuilt.map((e) => {
      const keys = [
        ...new Set((e.pointers.length ? e.pointers : e.parcels).map((p) => p.trim()).filter(Boolean))
      ]
      const dist = minPlayerToFootprintDistanceM(dclX, dclZ, keys, primaryBase)
      return { ent: e, dist, parcelCount: keys.length || 1, keys }
    })

    // Include keep band so already-live secondaries get dist updates for exit hysteresis.
    const ranked = withPlayerDist
      .filter((x) => Number.isFinite(x.dist) && x.dist <= keepM)
      .sort((a, b) => {
        if (a.dist !== b.dist) return a.dist - b.dist
        // Larger occupied scenes first — 1×1 interiors must not starve Winterfest / plaza.
        return b.parcelCount - a.parcelCount
      })

    const liveCandidates: Array<{
      entityId: string
      title: string
      base: string
      resolveX: number
      resolveY: number
      distM: number
      parcelCount: number
      parcels: string[]
    }> = []

    for (const { ent, dist, parcelCount, keys } of ranked) {
      try {
        const baseCoord = parseParcelKey(ent.base)
        liveCandidates.push({
          entityId: ent.id,
          title: ent.title || ent.base,
          base: ent.base,
          resolveX: baseCoord.x,
          resolveY: baseCoord.y,
          distM: dist,
          parcelCount,
          parcels: keys
        })
      } catch {
        /* skip */
      }
    }
    this.emitLiveCandidatesIfChanged(liveCandidates, enterM, keepM)
  }

  private emitLiveCandidatesIfChanged(
    liveCandidates: Array<{
      entityId: string
      title: string
      base: string
      resolveX: number
      resolveY: number
      distM: number
      parcelCount: number
      parcels: string[]
    }>,
    enterM?: number,
    keepM?: number
  ): void {
    // Include distances so keep-band hysteresis updates even when entity set is stable.
    const sig = liveCandidates.map((c) => `${c.entityId}:${c.distM.toFixed(0)}`).join('|')
    if (sig === this.lastLiveCandidateSignature) return
    this.lastLiveCandidateSignature = sig
    this.ctx?.onSecondaryCandidates?.(liveCandidates)
    if (liveCandidates.length && enterM != null) {
      const bootable = liveCandidates.filter((c) => c.distM <= enterM)
      const logSig = `${bootable.map((c) => c.entityId).join('|')}#${liveCandidates.length}`
      if (logSig === this.lastLiveLogSignature) return
      this.lastLiveLogSignature = logSig
      console.info(
        `[aoi] live guests (player enter≤${enterM}m keep≤${keepM ?? '?'}m) ` +
          `n=${liveCandidates.length} bootable=${bootable.length} nearest=${liveCandidates
            .slice(0, 5)
            .map(
              (c) =>
                `“${c.title}”@${c.base}(player ${c.distM.toFixed(0)}m,p=${c.parcelCount})`
            )
            .join(' · ')}`
      )
    }
  }

  /**
   * Inner radius: queue Explorer-style first-frame sampling for SDK7 secondaries
   * that have no main.composite (script creates GltfContainers on boot).
   *
   * LOD retain: leaving the ring **hides** the group; re-enter shows it again
   * without re-running the worker. True dispose only on LRU over FF_MAX_RETAINED
   * or primary unbind.
   */
  private queueFirstFrameSecondaries(
    entities: ActiveSceneEntity[],
    primaryId: string,
    primaryBase: string,
    dclX: number,
    dclZ: number,
    pointerSet: Set<string>
  ): void {
    const ctx = this.ctx
    if (!ctx || this.disposed) return
    if (!aoiNeighborShells()) return
    // Isolated SceneHost per sample is a second WebGL context — off for soak.
    // Composite shells cover Creator Hub estates; script-only neighbors stay plane.
    void entities
    void primaryId
    void primaryBase
    void dclX
    void dclZ
    void pointerSet
    return
  }


  private clearFirstFrameGroups(): void {
    for (const group of this.firstFrameGroups.values()) {
      group.removeFromParent()
      disposeObject3D(group)
    }
    this.firstFrameGroups.clear()
    this.firstFrameLastUse.clear()
    this.firstFrameRoot.clear()
  }

  /**
   * Sticky Genesis-wide empty plane under the whole city.
   * Authored once vs parcel 0,0 — FocusOwner retarget only moves cityFillRoot.
   */
  private async ensureGenesisEmptyPlane(
    ctx: NonNullable<typeof this.ctx>,
    gen: number,
    _primaryBase: string
  ): Promise<void> {
    if (this.blankRoot && this.blankPlaneReady) return
    try {
      const plane = await buildGenesisCityEmptyPlane(ctx.cache, GENESIS_CITY_FILL_ORIGIN)
      if (gen !== this.refreshGen || this.disposed || this.ctx !== ctx) {
        plane.traverse((o) => {
          if (o instanceof THREE.Mesh) {
            o.geometry?.dispose()
            const mats = Array.isArray(o.material) ? o.material : [o.material]
            for (const m of mats) m?.dispose?.()
          }
        })
        return
      }
      this.clearBlank()
      this.blankRoot = plane
      this.blankPlaneReady = true
      this.cityFillRoot.add(plane)
      const ud = plane.userData as {
        parcels?: { w?: number; d?: number }
        sizeM?: { x?: number; z?: number }
      }
      console.info(
        `[aoi] genesis empty plane ` +
          `${ud.parcels?.w ?? '?'}×${ud.parcels?.d ?? '?'} parcels ` +
          `(${((ud.sizeM?.x ?? 0) / 16).toFixed(0)}×${((ud.sizeM?.z ?? 0) / 16).toFixed(0)} @ 16m) ` +
          `origin=${GENESIS_CITY_FILL_ORIGIN}`
      )
    } catch (err) {
      console.warn('[aoi] genesis empty plane failed', err)
    }
  }

  /** Radius 0 but empty primary — still show city plane + sticky local trees. */
  private async refreshEmptyPrimaryOnly(): Promise<void> {
    const ctx = this.ctx
    if (!ctx || this.disposed || !this.primaryIsEmpty) return
    const gen = ++this.refreshGen
    const base = ctx.scene.baseParcel
    for (const k of this.primaryParcelSet) {
      if (!this.loadedScatterParcels.has(k)) this.pendingScatterParcels.add(k)
    }
    try {
      await this.ensureGenesisEmptyPlane(ctx, gen, base)
      if (gen !== this.refreshGen || this.disposed || this.ctx !== ctx) return
      this.cachedPrimaryBase = base
      await this.drainOutstandingWork(8, 8, gen)
    } catch (err) {
      console.warn('[aoi] empty primary fill failed', err)
    }
  }

  /**
   * Drain {@link pendingScatterParcels} into sticky 4×4 chunks.
   * Already-meshed parcels are never rebuilt. Cap per tick unless uncapped first fill.
   */
  private async drainPendingScatter(
    ctx: NonNullable<typeof this.ctx>,
    gen: number,
    primaryBase: string,
    dclX: number,
    dclZ: number,
    uncapped: boolean
  ): Promise<void> {
    // Drop anything already loaded.
    for (const k of [...this.pendingScatterParcels]) {
      if (this.loadedScatterParcels.has(k)) this.pendingScatterParcels.delete(k)
    }
    if (!this.pendingScatterParcels.size) return

    const fresh = [...this.pendingScatterParcels]
    let toLoad = fresh
    if (!uncapped && fresh.length > SCATTER_ADD_PER_REFRESH) {
      toLoad = [...fresh]
        .map((key) => {
          try {
            const p = parseParcelKey(key.trim())
            return { key, d: distanceToParcelCenterM(dclX, dclZ, p, primaryBase) }
          } catch {
            return { key, d: Infinity }
          }
        })
        .sort((a, b) => a.d - b.d)
        .slice(0, SCATTER_ADD_PER_REFRESH)
        .map((x) => x.key)
    }

    // 4×4 parcel chunks (~64m) — LOD/purge by chunk center, not one giant blob.
    const CHUNK = 4
    const byChunk = new Map<string, string[]>()
    for (const key of toLoad) {
      try {
        const p = parseParcelKey(key.trim())
        const ck = `${Math.floor(p.x / CHUNK)},${Math.floor(p.y / CHUNK)}`
        let list = byChunk.get(ck)
        if (!list) {
          list = []
          byChunk.set(ck, list)
        }
        list.push(key.trim())
      } catch {
        /* skip bad key */
      }
    }
    if (!byChunk.size) return

    const t0 = performance.now()
    let addedParcels = 0
    let addedColliders = 0
    let addedLayers = 0

    for (const [, chunkKeys] of byChunk) {
      if (gen !== this.refreshGen || this.disposed || this.ctx !== ctx) return
      try {
        const { root, colliders, grass } = await buildEmptyParcelScatter({
          cache: ctx.cache,
          parcelKeys: chunkKeys,
          primaryBase: GENESIS_CITY_FILL_ORIGIN
        })
        if (gen !== this.refreshGen || this.disposed || this.ctx !== ctx) {
          grass?.dispose()
          disposeScatterInstancedGeometry(root)
          root.clear()
          return
        }

        let cx = 0
        let cz = 0
        let n = 0
        for (const key of chunkKeys) {
          try {
            const p = parseParcelKey(key)
            cx += p.x * 16 + 8
            cz += p.y * 16 + 8
            n++
          } catch {
            /* skip */
          }
          this.loadedScatterParcels.add(key)
          this.pendingScatterParcels.delete(key)
        }
        if (n > 0) {
          cx /= n
          cz /= n
        } else {
          cx = dclX
          cz = dclZ
        }

        root.name = `aoi-scatter-layer:${this.scatterLayerSeq}`
        const layer: StickyScatterLayer = {
          id: this.scatterLayerSeq++,
          root,
          colliders,
          parcelKeys: chunkKeys,
          centerX: cx,
          centerZ: cz,
          grass
        }
        this.scatterLayers.push(layer)
        this.scatterRoot.add(root)
        addedParcels += chunkKeys.length
        addedColliders += colliders.length
        addedLayers++
      } catch (err) {
        console.warn('[aoi] sticky scatter chunk failed', err)
      }
    }

    if (addedLayers > 0) {
      // Descs stored on layers; PhysX only for near-player trees/rocks.
      this.syncNearEmptyLandPhys(ctx, dclX, dclZ, /*force*/ true)
      console.info(
        `[aoi] scatter drain +${addedParcels} parcels / ${addedLayers} chunks ` +
          `(loaded=${this.loadedScatterParcels.size} pending=${this.pendingScatterParcels.size} ` +
          `layers=${this.scatterLayers.length}) collidersDesc+${addedColliders} ` +
          `physNear≤${EMPTY_LAND_PHYS_RADIUS_M}m ` +
          `${(performance.now() - t0).toFixed(0)}ms`
      )
    }
  }

  /** Create at most one empty shell, then attach {@link COMPOSITE_LOAD_PER_DRAIN} clone. */
  private async drainPendingComposites(
    ctx: NonNullable<typeof this.ctx>,
    gen: number,
    dclX: number,
    dclZ: number,
    allowOverBudget = false
  ): Promise<void> {
    if (!ctx.host) return
    const cacheIds = new Set(this.cachedEntities.map((e) => e.id))
    for (const id of [...this.pendingCompositeIds]) {
      if (this.loadedShells.has(id) || !cacheIds.has(id)) this.pendingCompositeIds.delete(id)
    }

    if (this.pendingCompositeIds.size > 0 && this.loadedShells.size < COMPOSITE_MAX_RETAINED) {
      const frustum = this.cameraFrustum()
      const ranked = [...this.pendingCompositeIds]
        .map((id) => this.cachedEntities.find((e) => e.id === id))
        .filter((e): e is ActiveSceneEntity => !!e)
        .sort((a, b) => {
          const aView = this.entityLikelyInView(a, frustum) ? 0 : 1
          const bView = this.entityLikelyInView(b, frustum) ? 0 : 1
          if (aView !== bView) return aView - bView
          const da = this.entityDistM(a, dclX, dclZ, this.cachedPrimaryBase || ctx.scene.baseParcel)
          const db = this.entityDistM(b, dclX, dclZ, this.cachedPrimaryBase || ctx.scene.baseParcel)
          if (da !== db) return da - db
          const aParcels = a.parcels.length || a.pointers.length
          const bParcels = b.parcels.length || b.pointers.length
          return bParcels - aParcels
        })
      const openN = this.prewarmActive ? COMPOSITE_SHELLS_PER_PREWARM : 1
      for (const ent of ranked.slice(0, openN)) {
        await this.createEmptyShell(ent, ctx, gen, dclX, dclZ)
        if (gen !== this.refreshGen || this.disposed || this.ctx !== ctx) return
      }
    }

    if (!this.prewarmActive && !allowOverBudget && lastFrameOverBudget(33)) return

    const frustum = this.cameraFrustum()
    const attachOrder = [...this.loadedShells.values()].sort((a, b) => {
      const aView = this.poseInFrustum(a.pose, frustum) ? 0 : 1
      const bView = this.poseInFrustum(b.pose, frustum) ? 0 : 1
      if (aView !== bView) return aView - bView
      return a.lastDistM - b.lastDistM
    })
    let attached = 0
    const attachBudget = this.prewarmActive ? COMPOSITE_LOAD_PER_PREWARM : COMPOSITE_LOAD_PER_DRAIN
    for (const rec of attachOrder) {
      if (attached >= attachBudget) break
      if (rec.attachedCount >= rec.targetCount || rec.pendingSrcs.length === 0) continue
      await this.attachOneShellClone(rec, ctx, gen)
      attached++
    }
  }

  private cameraFrustum(): THREE.Frustum | null {
    const cam = this.ctx?.getCamera?.()
    if (!cam) return null
    cam.updateMatrixWorld(true)
    this.scratchProjView.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse)
    this.scratchFrustum.setFromProjectionMatrix(this.scratchProjView)
    return this.scratchFrustum
  }

  private poseInFrustum(pose: THREE.Object3D, frustum: THREE.Frustum | null): boolean {
    if (!frustum) return true
    pose.updateWorldMatrix(true, false)
    pose.getWorldPosition(this.scratchWorld)
    this.scratchBox.setFromCenterAndSize(this.scratchWorld, this.scratchSize)
    return frustum.intersectsBox(this.scratchBox)
  }

  private entityLikelyInView(ent: ActiveSceneEntity, frustum: THREE.Frustum | null): boolean {
    if (!frustum) return true
    const rec = this.loadedShells.get(ent.id)
    if (rec) return this.poseInFrustum(rec.pose, frustum)
    const primaryBase = this.cachedPrimaryBase || this.ctx?.scene.baseParcel || '0,0'
    const origin = neighborOriginOffset(ent.base, primaryBase)
    dclToThreePos(origin.x, 0, origin.z, this.scratchWorld)
    this.aoiPoseRoot.updateWorldMatrix(true, false)
    this.aoiPoseRoot.localToWorld(this.scratchWorld)
    this.scratchBox.setFromCenterAndSize(this.scratchWorld, this.scratchSize)
    return frustum.intersectsBox(this.scratchBox)
  }

  /**
   * Hide far scatter **meshes** (LOD). PhysX is separate — near-player only
   * ({@link EMPTY_LAND_PHYS_RADIUS_M}); grass never had colliders.
   */
  private updateStickyScatterLod(dclX: number, dclZ: number): void {
    const hideM = visualWarmRadiusM()
    const hideR2 = hideM * hideM
    const feet = this.genesisFeet(dclX, dclZ)
    for (const layer of this.scatterLayers) {
      const dx = layer.centerX - feet.x
      const dz = layer.centerZ - feet.z
      layer.root.visible = dx * dx + dz * dz <= hideR2
    }
  }

  /** Wind + camera LOD for vacant GPU blades. Camera in cityFillRoot local. */
  private tickVacantGrass(): void {
    let any = false
    for (const layer of this.scatterLayers) {
      if (layer.grass && layer.root.visible) {
        any = true
        break
      }
    }
    if (!any) return
    const now = performance.now()
    if (this.grassElapsedAt <= 0) this.grassElapsedAt = now
    const dt = Math.min(0.1, (now - this.grassElapsedAt) / 1000)
    this.grassElapsedAt = now
    this.grassElapsed += dt
    const cam = this.ctx?.getCamera?.()
    if (!cam) return
    this.cityFillRoot.updateMatrixWorld(false)
    this.scratchWorld.copy(cam.position)
    this.cityFillRoot.worldToLocal(this.scratchWorld)
    for (const layer of this.scatterLayers) {
      if (!layer.grass || !layer.root.visible) continue
      layer.grass.update(this.grassElapsed, this.scratchWorld)
    }
  }

  /** Dispose only when player is very far (teleport / cross-city walk). */
  private purgeFarScatterLayers(
    ctx: NonNullable<typeof this.ctx>,
    dclX: number,
    dclZ: number
  ): void {
    const purgeM = visualWarmRadiusM() + SHELL_PURGE_PAST_SD_M
    const purgeR2 = purgeM * purgeM
    const feet = this.genesisFeet(dclX, dclZ)
    const dropEntities: number[] = []
    let purged = 0
    for (let i = this.scatterLayers.length - 1; i >= 0; i--) {
      const layer = this.scatterLayers[i]!
      const dx = layer.centerX - feet.x
      const dz = layer.centerZ - feet.z
      if (dx * dx + dz * dz <= purgeR2) continue
      for (const c of layer.colliders) dropEntities.push(c.entity)
      disposeStickyScatterLayer(layer)
      for (const k of layer.parcelKeys) this.loadedScatterParcels.delete(k)
      this.scatterLayers.splice(i, 1)
      purged++
    }
    if (purged > 0) {
      ctx.purgeEmptyLandColliders?.(dropEntities)
      for (const id of dropEntities) this.lastNearEmptyLandIds.delete(id)
      this.syncNearEmptyLandPhys(ctx, dclX, dclZ, /*force*/ true)
      console.info(
        `[aoi] scatter purge >${visualWarmRadiusM() + SHELL_PURGE_PAST_SD_M}m layers=${purged} remain=${this.scatterLayers.length}`
      )
    }
  }

  /**
   * Throttled near-phys refresh while walking (parcel step or ~½ phys radius move).
   */
  private maybeSyncNearEmptyLandPhys(dclX: number, dclZ: number): void {
    const ctx = this.ctx
    if (!ctx || !this.scatterLayers.length) return
    const step = EMPTY_LAND_PHYS_RADIUS_M * 0.5
    const step2 = step * step
    if (Number.isFinite(this.lastEmptyLandPhysFeet.x)) {
      const dx = dclX - this.lastEmptyLandPhysFeet.x
      const dz = dclZ - this.lastEmptyLandPhysFeet.z
      if (dx * dx + dz * dz < step2) return
    }
    this.syncNearEmptyLandPhys(ctx, dclX, dclZ, /*force*/ false)
  }

  /**
   * Visual scatter can cover the full warm band; PhysX tree/rock boxes only near feet
   * (same idea as road furniture {@link ROAD_PHYS_RADIUS_M}).
   * Collider matrices are landscape-three (x = −dclX, z = dclZ).
   */
  private syncNearEmptyLandPhys(
    ctx: NonNullable<typeof this.ctx>,
    dclX: number,
    dclZ: number,
    force: boolean
  ): void {
    const r2 = EMPTY_LAND_PHYS_RADIUS_M * EMPTY_LAND_PHYS_RADIUS_M
    const feet = this.genesisFeet(dclX, dclZ)
    const near: PhysicsColliderDesc[] = []
    const nearIds = new Set<number>()
    for (const layer of this.scatterLayers) {
      for (const c of layer.colliders) {
        const e = c.matrix.elements
        // Matrices are Genesis-local three (x = −dclX).
        const dx = -e[12]! - feet.x
        const dz = e[14]! - feet.z
        if (dx * dx + dz * dz <= r2) {
          near.push(c)
          nearIds.add(c.entity)
        }
      }
    }

    const drop: number[] = []
    for (const id of this.lastNearEmptyLandIds) {
      if (!nearIds.has(id)) drop.push(id)
    }
    if (drop.length) {
      ctx.purgeEmptyLandColliders?.(drop)
    }

    // Skip no-op sync (same near set) unless forced after mesh drain.
    if (!force && drop.length === 0 && nearIds.size === this.lastNearEmptyLandIds.size) {
      let same = true
      for (const id of nearIds) {
        if (!this.lastNearEmptyLandIds.has(id)) {
          same = false
          break
        }
      }
      if (same) return
    }

    this.lastNearEmptyLandIds = nearIds
    this.lastEmptyLandPhysFeet = { x: dclX, z: dclZ }

    if (near.length === 0) {
      // Nothing near — tracking already purged far ids above.
      return
    }
    ctx.syncEmptyLandColliders?.(this.bakeCityFillColliders(near))
  }

  /**
   * Explorer-style roads: catalog + assemblies, batched as InstancedMesh
   * (one draw call per prop mesh leaf, not per parcel).
   */
  private async refreshRoadTiles(
    entities: ActiveSceneEntity[],
    ownership: Map<string, ActiveSceneEntity>,
    primaryBase: string,
    gen: number,
    ctx: AoiVisualLayerContext,
    dclX: number,
    dclZ: number,
    /** Full Scene Distance pointer ring — catalog roads may have no catalyst entity. */
    aoiPointers: string[]
  ): Promise<void> {
    await ensureExplorerRoadsReady()
    if (gen !== this.refreshGen || this.disposed || this.ctx !== ctx) return

    // Parcels in AOI that are Genesis roads (catalog) and not owned by a secondary scene.
    const roadParcels = new Map<string, ActiveSceneEntity | null>()
    for (const ent of entities) {
      const keys = (ent.parcels.length ? ent.parcels : ent.pointers).map((p) => p.trim())
      const isClassicRoad = isClassicOpenRoadEntity(ent)
      for (const parcel of keys.length ? keys : [ent.base.trim()]) {
        if (!parcel || this.primaryParcelSet.has(parcel)) continue
        const owner = ownership.get(parcel)
        if (owner && isSecondarySceneCandidate(owner) && !isExplorerRoadParcel(parcel)) {
          continue
        }
        if (isExplorerRoadParcel(parcel) || isClassicRoad) {
          roadParcels.set(parcel, ent)
        }
      }
    }
    // Ownership keys in AOI (catalyst may list road entities not first in entity walk).
    for (const key of ownership.keys()) {
      if (this.primaryParcelSet.has(key)) continue
      if (!isExplorerRoadParcel(key)) continue
      if (roadParcels.has(key)) continue
      const owner = ownership.get(key)
      if (owner && isSecondarySceneCandidate(owner) && !isOpenRoadEntity(owner)) continue
      roadParcels.set(key, owner ?? null)
    }
    // Full radius catalog pass: Explorer roads with no catalyst entity still load tiles.
    for (const key of aoiPointers) {
      const k = key.trim()
      if (!k || this.primaryParcelSet.has(k) || this.primaryParcelSet.has(key)) continue
      if (!isExplorerRoadParcel(k) && !isExplorerRoadParcel(key)) continue
      if (roadParcels.has(k) || roadParcels.has(key)) continue
      const owner = ownership.get(k) ?? ownership.get(key)
      if (owner && isSecondarySceneCandidate(owner) && !isOpenRoadEntity(owner)) continue
      roadParcels.set(k, owner ?? null)
    }

    const signature = [...roadParcels.keys()].sort().join('|')
    const visualM = visualWarmRadiusM()
    this.lastRoadParcelEntities = roadParcels

    if (aoiSceneDistanceVisuals()) {
      for (const [parcelKey] of roadParcels) {
        if (this.loadedRoadParcelSet.has(parcelKey) || this.pendingRoadParcels.has(parcelKey)) {
          continue
        }
        try {
          const p = parseParcelKey(parcelKey)
          if (distanceToParcelCenterM(dclX, dclZ, p, primaryBase) > visualM) continue
        } catch {
          continue
        }
        this.pendingRoadParcels.add(parcelKey)
      }
      this.roadParcelSignature = signature
      return
    }

    if (signature === this.roadParcelSignature && this.roadRoot.children.length > 0) {
      return
    }

    const placements: RoadTilePlacement[] = []
    for (const [parcelKey, ent] of roadParcels) {
      if (gen !== this.refreshGen || this.disposed || this.ctx !== ctx) return
      try {
        const p = parseParcelKey(parcelKey)
        if (distanceToParcelCenterM(dclX, dclZ, p, primaryBase) > visualM) continue
        const placement = await this.resolveRoadPlacement(parcelKey, ent, ctx)
        if (placement) placements.push(placement)
      } catch (err) {
        console.warn('[aoi] road placement resolve failed', parcelKey, err)
      }
    }

    if (gen !== this.refreshGen || this.disposed || this.ctx !== ctx) return

    try {
      const built = await buildInstancedRoadLayer({
        placements,
        primaryBase: GENESIS_CITY_FILL_ORIGIN,
        cache: ctx.cache,
        contentBaseUrl: ctx.scene.realm.contentUrl
      })
      if (gen !== this.refreshGen || this.disposed || this.ctx !== ctx) {
        disposeRoadInstancedRoot(built.root)
        return
      }
      this.roadRoot.clear()
      this.roadRoot.add(built.root)
      this.roadParcelSignature = signature
      this.loadedRoadIds.clear()
      this.loadedRoadParcelSet.clear()
      this.roadColliderDescs.length = 0
      this.roadColliderDescs.push(...built.colliders)
      for (const p of placements) {
        this.loadedRoadIds.add(`parcel:${p.parcelKey}`)
        this.loadedRoadParcelSet.add(p.parcelKey)
      }
      this.syncNearRoadPhys(ctx, dclX, dclZ, /*force*/ true)
    } catch (err) {
      console.warn('[aoi] instanced roads failed', err)
    }
  }

  private async resolveRoadPlacement(
    parcelKey: string,
    ent: ActiveSceneEntity | null,
    ctx: AoiVisualLayerContext
  ): Promise<RoadTilePlacement | null> {
    let placement = ent ? await resolveRoadTilePlacement(ent, ctx.scene.realm.contentUrl) : null
    if (placement) return placement
    const entry = getExplorerRoadEntry(parcelKey)
    if (!entry) return null
    return {
      entityId: `parcel:${parcelKey}`,
      parcelKey,
      model: entry.model,
      rotation: entry.rotation,
      source: 'explorer-catalog'
    }
  }

  private async drainPendingRoads(
    ctx: NonNullable<typeof this.ctx>,
    gen: number,
    dclX: number,
    dclZ: number
  ): Promise<void> {
    if (!this.pendingRoadParcels.size) return
    const primaryBase = this.cachedPrimaryBase || ctx.scene.baseParcel
    const visualM = visualWarmRadiusM()
    const ranked = [...this.pendingRoadParcels]
      .map((key) => {
        try {
          const p = parseParcelKey(key.trim())
          return { key, d: distanceToParcelCenterM(dclX, dclZ, p, primaryBase) }
        } catch {
          return { key, d: Infinity }
        }
      })
      .filter((x) => Number.isFinite(x.d) && x.d <= visualM)
      .sort((a, b) => a.d - b.d)
      .slice(0, ROAD_ADD_PER_DRAIN)

    const placements: RoadTilePlacement[] = []
    for (const { key } of ranked) {
      this.pendingRoadParcels.delete(key)
      if (this.loadedRoadParcelSet.has(key)) continue
      const ent = this.lastRoadParcelEntities.get(key) ?? null
      try {
        const placement = await this.resolveRoadPlacement(key, ent, ctx)
        if (placement) placements.push(placement)
      } catch (err) {
        console.warn('[aoi] road placement resolve failed', key, err)
      }
      if (gen !== this.refreshGen || this.disposed || this.ctx !== ctx) return
    }
    if (!placements.length) return

    try {
      const built = await buildInstancedRoadLayer({
        placements,
        primaryBase: GENESIS_CITY_FILL_ORIGIN,
        cache: ctx.cache,
        contentBaseUrl: ctx.scene.realm.contentUrl
      })
      if (gen !== this.refreshGen || this.disposed || this.ctx !== ctx) {
        disposeRoadInstancedRoot(built.root)
        return
      }
      this.roadRoot.add(built.root)
      this.roadColliderDescs.push(...built.colliders)
      for (const p of placements) {
        this.loadedRoadIds.add(`parcel:${p.parcelKey}`)
        this.loadedRoadParcelSet.add(p.parcelKey)
      }
      this.syncNearRoadPhys(ctx, dclX, dclZ, /*force*/ true)
    } catch (err) {
      console.warn('[aoi] incremental roads failed', err)
    }
  }

  private maybeSyncNearRoadPhys(dclX: number, dclZ: number): void {
    const ctx = this.ctx
    if (!ctx || !this.roadColliderDescs.length) return
    const step = ROAD_PHYS_RADIUS_M * 0.5
    const step2 = step * step
    if (Number.isFinite(this.lastRoadPhysFeet.x)) {
      const dx = dclX - this.lastRoadPhysFeet.x
      const dz = dclZ - this.lastRoadPhysFeet.z
      if (dx * dx + dz * dz < step2) return
    }
    this.syncNearRoadPhys(ctx, dclX, dclZ, /*force*/ false)
  }

  private syncNearRoadPhys(
    ctx: NonNullable<typeof this.ctx>,
    dclX: number,
    dclZ: number,
    force: boolean
  ): void {
    if (!this.roadColliderDescs.length) return
    const r2 = ROAD_PHYS_RADIUS_M * ROAD_PHYS_RADIUS_M
    const feet = this.genesisFeet(dclX, dclZ)
    const near = this.roadColliderDescs.filter((c) => {
      const e = c.matrix.elements
      const dx = -e[12]! - feet.x
      const dz = e[14]! - feet.z
      return dx * dx + dz * dz <= r2
    })
    if (!force && near.length === 0) return
    this.lastRoadPhysFeet = { x: dclX, z: dclZ }
    ctx.syncRoadColliders?.(this.bakeCityFillColliders(near))
  }

  private clearRoads(): void {
    this.roadRoot.clear()
    this.loadedRoadIds.clear()
    this.loadedRoadParcelSet.clear()
    this.pendingRoadParcels.clear()
    this.roadColliderDescs.length = 0
    this.lastRoadParcelEntities = new Map()
    this.lastRoadPhysFeet = { x: Number.NaN, z: Number.NaN }
    this.roadParcelSignature = ''
    this.ctx?.clearRoadColliders?.()
  }

  private clearBlank(): void {
    if (!this.blankRoot) return
    this.blankRoot.removeFromParent()
    this.blankRoot.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.geometry?.dispose()
        // City plane owns cloned materials/maps; InstancedMesh ground shared mats carefully.
        if (this.blankRoot?.userData?.genesisEmptyPlane) {
          const mats = Array.isArray(o.material) ? o.material : [o.material]
          for (const m of mats) {
            if (!m) continue
            if ('map' in m && m.map instanceof THREE.Texture) {
              // Cloned map from EMPTY_LAND — dispose clone only.
              m.map.dispose()
            }
            m.dispose()
          }
        }
      }
    })
    this.blankRoot = null
    this.blankPlaneReady = false
  }

  private clearScatter(): void {
    for (const layer of this.scatterLayers) {
      disposeStickyScatterLayer(layer)
    }
    this.scatterLayers.length = 0
    this.loadedScatterParcels.clear()
    this.pendingScatterParcels.clear()
    this.lastNearEmptyLandIds.clear()
    this.lastEmptyLandPhysFeet = { x: Number.NaN, z: Number.NaN }
    this.grassElapsed = 0
    this.grassElapsedAt = 0
    this.scatterRoot.clear()
    // scatterRoot stays attached under cityFillRoot for sticky adds.
    this.ctx?.clearEmptyLandColliders?.()
  }
}

function disposeStickyScatterLayer(layer: StickyScatterLayer): void {
  layer.grass?.dispose()
  layer.grass = null
  layer.root.removeFromParent()
  disposeScatterInstancedGeometry(layer.root)
  layer.root.clear()
}

function disposeScatterInstancedGeometry(root: THREE.Object3D): void {
  root.traverse((o) => {
    if (o instanceof THREE.InstancedMesh && o.name !== 'aoi-vacant-grass') {
      o.geometry?.dispose()
    }
  })
}

function disposeRoadInstancedRoot(root: THREE.Object3D): void {
  // Shared geo/mat from prop cache — leave them.
  root.clear()
}

function isClassicOpenRoadEntity(ent: ActiveSceneEntity): boolean {
  if (/^Road at /i.test(ent.title)) return true
  const main = ent.main.toLowerCase()
  if (main !== 'game.js' && !main.endsWith('/game.js')) return false
  return ent.content.some((c) => {
    const base = c.file.split('/').pop() ?? c.file
    return /^(OpenRoad_|OpenFork_|OpenCorner_|Road_|DeadEnd_|Fork_|Corner_|EmptyFork_)/i.test(
      base
    )
  })
}

function disposeObject3D(root: THREE.Object3D): void {
  root.traverse((o) => {
    if (o instanceof THREE.Mesh) {
      o.geometry?.dispose()
      // Materials are often shared from AssetCache clones — do not dispose textures.
    }
  })
  root.clear()
}

function shellBandEdges(warmM: number): { near: number; mid: number; far: number } {
  return {
    near: Math.min(48, warmM * 0.35),
    mid: Math.min(120, warmM * 0.75),
    far: warmM
  }
}

function shellBandForDistance(distM: number, warmM: number): AoiShellBand {
  if (warmM <= 0 || !Number.isFinite(distM) || distM > warmM) return 'hidden'
  const e = shellBandEdges(warmM)
  if (distM <= e.near) return 'near'
  if (distM <= e.mid) return 'mid'
  return 'far'
}

function shellBandLock(band: AoiShellBand, warmM: number): { lo: number; hi: number } {
  const e = shellBandEdges(warmM)
  const h = SHELL_BAND_HYSTERESIS_M
  if (band === 'near') return { lo: Number.NEGATIVE_INFINITY, hi: e.near + h }
  if (band === 'mid') return { lo: e.near - h, hi: e.mid + h }
  if (band === 'far') return { lo: e.mid - h, hi: e.far + h }
  return { lo: e.far - h, hi: Number.POSITIVE_INFINITY }
}

function buildShellHierarchy(
  visual: THREE.Group,
  transforms: CompositeTransform[],
  planned: CompositeGltfPlacement[]
): Map<string, THREE.Object3D> {
  const byId = new Map(transforms.map((t) => [t.entityId, t]))
  const wanted = new Set<string>()
  for (const p of planned) {
    let id: string | null = p.entityId
    const guard = new Set<string>()
    while (id && !guard.has(id)) {
      guard.add(id)
      wanted.add(id)
      const tf = byId.get(id)
      id = tf?.parentId ?? (id === p.entityId ? p.parentId : null)
    }
  }

  const nodes = new Map<string, THREE.Object3D>()
  for (const id of wanted) {
    const tf = byId.get(id)
    const obj = new THREE.Object3D()
    obj.name = `aoi-ent:${id}`
    if (tf) {
      applyDclLocalTransform(obj, tf)
    } else {
      const place = planned.find((p) => p.entityId === id)
      if (place) applyDclLocalTransform(obj, place)
    }
    nodes.set(id, obj)
  }

  for (const [id, obj] of nodes) {
    const tf = byId.get(id)
    const pid = tf?.parentId ?? null
    if (pid && nodes.has(pid) && pid !== id) {
      nodes.get(pid)!.add(obj)
    } else {
      visual.add(obj)
    }
  }
  return nodes
}
