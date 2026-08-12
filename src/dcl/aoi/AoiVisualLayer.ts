import * as THREE from 'three'
import type { AssetCache } from '../../rendering/AssetCache'
import { renderQuality } from '../../rendering/RenderQualitySettings'
import type { ResolvedScene } from '../content/types'
import { parseParcelKey } from '../content/parseParcel'
import { buildGenesisCityEmptyPlane } from './genesisEmptyPlane'
import { buildCompositeVisualGroup } from './compositeVisuals'
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
import {
  FF_HIERARCHY_VERSION,
  SecondaryFirstFrameSampler
} from './SecondaryFirstFrameSampler'
import { clientDebugLog } from '../../client/debug/ClientDebugLog'
import {
  aoiGlbShellsOnly,
  aoiLiveSecondariesOnly,
  AOI_SHELL_ENTER_M,
  AOI_SHELL_KEEP_M,
  COMPOSITE_MAX_RETAINED,
  compositeMaxGltfsForDistance,
  EMPTY_LAND_PHYS_RADIUS_M,
  ROAD_PHYS_RADIUS_M,
  secondaryLiveCap,
  secondaryLiveEnterRadiusM,
  secondaryLiveKeepRadiusM
} from '../multiScene/caps'
import { lastFrameOverBudget, yieldToIdle } from '../../rendering/mainThreadYield'

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
 * - Dispose mesh + PhysX only when player is > SCATTER_PURGE_M away.
 */
/** Hide scatter layers beyond this (keep in memory + PhysX until purge). */
const SCATTER_LOD_HIDE_M = 160
/** Hard unload mesh + colliders — huge walk / teleport only. */
const SCATTER_PURGE_M = 1000
/** Cap new parcels meshed per drain tick (first ring fill is uncapped). */
const SCATTER_ADD_PER_REFRESH = 48
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
/** Composites to load per drain tick (true settle only). */
const COMPOSITE_LOAD_PER_DRAIN = 1
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
  /** DCL scene-local meters (for distance LOD / purge). */
  centerX: number
  centerZ: number
}

/**
 * Neighbor scene meshes (composite GLBs + first-frame) + live-secondary candidates.
 * Prefer URL kill switch `?noaoi` (World skips bind entirely). This only gates meshes.
 */
const LOAD_AOI_SCENE_VISUALS = true

export type AoiVisualLayerContext = {
  scene: ResolvedScene
  cache: AssetCache
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
}

/**
 * Phase A2+ — coords-only AOI (radius = user Scene Distance warm band):
 * - Empty layer: **one Genesis City empty plane** + **sticky** trees/rocks/grass
 *   (load once in Scene Distance, add on walk, hide LOD, purge only >1km)
 * - Genesis roads via **Explorer catalog + OriginalAssets FBX** (tile + street
 *   furniture), not runtime SDK6 game.js
 * - Neighbor main.composite GLBs (render-only, no colliders / anim) — full Scene Distance
 * - First-frame samples for script-built scenes (tertiary when no live worker)
 * - Live secondary: **player** ≤16m boots; keep until player ≤80m (cap ≤3)
 */
export class AoiVisualLayer {
  private root = new THREE.Group()
  private blankRoot: THREE.Object3D | null = null
  /** Primary base the city empty plane is centered on — rebuild on retarget. */
  private blankPlaneBase = ''
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
  /** Entity ids with composite wanted but not yet loaded (drain while standing). */
  private readonly pendingCompositeIds = new Set<string>()
  private compositeRoot = new THREE.Group()
  private roadRoot = new THREE.Group()
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
  private readonly loadedCompositeIds = new Set<string>()
  private readonly loadedRoadIds = new Set<string>()
  /** Sorted parcel keys currently baked into the instanced road layer. */
  private roadParcelSignature = ''
  /** Last live-secondary candidate id list (avoid spam + reconcile churn when identical). */
  private lastLiveCandidateSignature = ''
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

  constructor() {
    this.root.name = 'aoi-visual-layer'
    this.scatterRoot.name = 'aoi-empty-scatter-sticky'
    this.compositeRoot.name = 'aoi-composite-secondaries'
    this.roadRoot.name = 'aoi-road-tiles'
    this.firstFrameRoot.name = 'aoi-first-frame-secondaries'
    this.root.add(this.scatterRoot)
    this.root.add(this.roadRoot)
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
    for (const [id, group] of this.firstFrameGroups) {
      // Hide shell only when full graph is ready (not merely "booting").
      group.visible = !this.liveGraphReadyIds.has(id)
    }
    for (const child of this.compositeRoot.children) {
      const name = child.name
      if (!name.startsWith('aoi-secondary:')) continue
      const id = name.slice('aoi-secondary:'.length)
      child.visible = !this.liveGraphReadyIds.has(id)
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
      console.info('[aoi] neighbor activity ON (primary play-ready — visuals + live)')
      // Kill background prewarm force-drain — it was still meshing after Jump In.
      this.cancelPrewarm('play-ready')
      // Prefer re-emit from prewarm cache (no 550-parcel rediscover hitch at unlock).
      if (this.hasDiscoveredOnce && this.cachedEntities.length > 0) {
        this.emitLiveSecondaryCandidatesOnly(
          this.cachedEntities,
          this.cachedPrimaryId,
          this.cachedPrimaryBase || this.ctx?.scene.baseParcel || '0,0',
          this.lastDiscoverFeet.x || 0,
          this.lastDiscoverFeet.z || 0,
          this.cachedPointerSet
        )
      } else {
        this.hasDiscoveredOnce = false
        this.lastParcelKey = ''
      }
    } else {
      console.info('[aoi] neighbor activity OFF (primary booting)')
    }
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
          `pendingScatter=${this.pendingScatterParcels.size} pendingComposite=${this.pendingCompositeIds.size}`
      )
    }
  }

  /**
   * Loading-phase warm: city plane + full warm-band scatter + composite shells
   * **before** play-ready. Live secondary **workers** stay off (capped + expensive).
   * Awaits until scatter queue is empty so play does not drain trees mid-walk.
   */
  prewarmVisuals(dclX: number, dclZ: number): void {
    if (this.disposed || !this.enabled || !this.ctx) return
    this.neighborActivityEnabled = true
    this.liveReconcileEnabled = false
    this.lastParcelKey = ''
    const radius = renderQuality.getSceneLoadRadiusM()
    const gen = ++this.prewarmGen
    this.prewarmActive = true
    console.info(
      `[aoi] prewarm visuals @ feet=(${dclX.toFixed(1)},${dclZ.toFixed(1)}) ` +
        `radius=${radius}m (live workers gated — drain only while prewarmActive)`
    )
    void this.runPrewarm(dclX, dclZ, radius, gen)
  }

  private async runPrewarm(
    dclX: number,
    dclZ: number,
    radiusM: number,
    gen: number
  ): Promise<void> {
    if (!this.prewarmActive || gen !== this.prewarmGen) return
    this.allowDrainOnce = true
    await this.refresh(dclX, dclZ, radiusM, 'full')
    if (!this.prewarmActive || gen !== this.prewarmGen || this.disposed) return

    // Drain only while still in loading (prewarmActive). Play-ready cancels this.
    let guard = 0
    while (
      this.prewarmActive &&
      gen === this.prewarmGen &&
      !this.disposed &&
      this.ctx &&
      (this.pendingScatterParcels.size > 0 || this.pendingCompositeIds.size > 0) &&
      guard++ < 80
    ) {
      await this.drainOutstandingWork(
        dclX,
        dclZ,
        this.refreshGen,
        /*forceUncapped*/ true,
        /*allow*/ true
      )
    }

    if (gen !== this.prewarmGen) return // cancelled mid-loop
    this.prewarmActive = false
    console.info(
      `[aoi] prewarm complete scatter=${this.loadedScatterParcels.size} ` +
        `pendingScatter=${this.pendingScatterParcels.size} ` +
        `composites=${this.loadedCompositeIds.size} ` +
        `pendingComposite=${this.pendingCompositeIds.size}`
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
    this.ctx = {
      ...this.ctx,
      scene
    }
    this.enabled = true
    this.primaryIsEmpty = !scene.entityId?.trim() && !scene.mainEntry?.trim()
    this.primaryParcelSet.clear()
    for (const p of scene.parcels) this.primaryParcelSet.add(p)
    // Keep composites/roads; force full rediscover under new primary + feet.
    this.lastParcelKey = ''
    this.lastRadius = -1
    this.hasDiscoveredOnce = false
    this.neighborActivityEnabled = true
    // Live worker reconcile stays off until settle (caller enables via setNeighborActivityEnabled).
    this.liveReconcileEnabled = false
    if (!this.root.parent && this.ctx.hostScene) {
      this.ctx.hostScene.add(this.root)
    }
    console.info(
      `[aoi] retarget primary “${scene.title}” base=${scene.baseParcel} ` +
        `(preserve tertiary — no unbind wipe)`
    )
    // Base parcel moved — city plane + scatter must re-anchor.
    this.blankPlaneBase = ''
    this.clearScatter()
    this.lastLiveCandidateSignature = ''
    void this.refresh(dclX, dclZ, renderQuality.getSceneLoadRadiusM(), 'full')
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
    this.loadedCompositeIds.clear()
    this.loadedRoadIds.clear()
    this.roadParcelSignature = ''
    this.clearFirstFrameGroups()
    this.firstFrameSampler.reset()
    this.lastParcelKey = ''
    this.lastRadius = -1
    if (!this.enabled) return
    ctx.hostScene.add(this.root)
    console.info(
      '[aoi] bound — Scene Distance warm band (coords only); radius=',
      renderQuality.getSceneLoadRadiusM(),
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
    this.compositeRoot.clear()
    this.clearRoads()
    this.clearFirstFrameGroups()
    this.loadedCompositeIds.clear()
    this.loadedRoadIds.clear()
    this.roadParcelSignature = ''
    this.lastLiveCandidateSignature = ''
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
   *
   * Heavy work (discover drain / composites / live-secondary emit) only after
   * **true settle** ({@link WALK_IDLE_MS} with no feet motion). Walking is LOD-only.
   */
  update(dclX: number, dclZ: number, force = false): void {
    if (this.disposed || !this.enabled || !this.ctx) return
    if (!this.neighborActivityEnabled && !force) return
    const radius = renderQuality.getSceneLoadRadiusM()

    if (radius <= 0) {
      this.clearRefreshDebounce()
      if (this.lastRadius !== 0) {
        this.clearBlank()
        this.clearScatter()
        this.compositeRoot.clear()
        this.clearRoads()
        this.clearFirstFrameGroups()
        this.loadedCompositeIds.clear()
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

    // Track locomotion — any real feet motion arms the settle timer.
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

    if (force) {
      this.clearRefreshDebounce()
      this.lastParcelKey = parcelKey
      this.lastRadius = radius
      // One-shot drain only if something is still pending after load — not continuous.
      this.allowDrainOnce = this.hasOutstandingWork()
      void this.refresh(dclX, dclZ, radius, 'full')
      return
    }

    if (radiusChanged) {
      this.lastParcelKey = parcelKey
      this.lastRadius = radius
      // Radius change is rare — allow discover but still settle-gated for drain.
      this.scheduleDiscover(dclX, dclZ, radius)
      return
    }

    if (movedParcel) {
      this.lastParcelKey = parcelKey
      this.lastRadius = radius
      this.updateStickyScatterLod(dclX, dclZ)
      // Tree/rock PhysX follows feet (visual scatter stays sticky / full warm band).
      this.maybeSyncNearEmptyLandPhys(dclX, dclZ)
      // Only schedule ring rediscover after a long walk; never on 1-parcel steps.
      if (this.shouldFullDiscover(dclX, dclZ, radius)) {
        this.scheduleDiscover(dclX, dclZ, radius)
      }
      return
    }

    // Settled on same parcel: LOD + deferred heavy work.
    this.updateStickyScatterLod(dclX, dclZ)
    this.maybeSyncNearEmptyLandPhys(dclX, dclZ)
    if (!this.isPlayerSettled(now)) return

    // True idle: live list + drain queues.
    if (
      this.liveReconcileEnabled &&
      this.cachedEntities.length > 0 &&
      LOAD_AOI_SCENE_VISUALS &&
      aoiLiveSecondariesOnly()
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
    // After play-ready, never attach composites on an already-over-budget frame.
    if (!this.prewarmActive && lastFrameOverBudget(33)) return
    this.lastDrainAt = now
    void this.drainOutstandingWork(dclX, dclZ)
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
   * - liveEligible = player→footprint ≤ enter (16m)
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
    console.info(
      `[aoi] budget warmParcels=${opts.warmParcels} (playerDisc=${opts.playerParcels}` +
        ` +primaryCollar=${opts.primaryAdjacentParcels}) ` +
        `uniqueEntities=${opts.uniqueEntities} scriptableInWarm=${scriptableInWarm} ` +
        `liveEligible=${liveEligible} liveRunning=${this.liveSecondaryIds.size} liveCap=${liveCap} ` +
        `sceneDist=${opts.radiusM}m liveEnter=${enterM}m liveKeep=${keepM}m ` +
        `composites=${this.loadedCompositeIds.size} ` +
        `(warm=player feet · live=player→scene enter/keep)`
    )
  }

  private hasOutstandingWork(): boolean {
    if (this.pendingScatterParcels.size > 0) return true
    if (
      this.pendingCompositeIds.size > 0 &&
      this.loadedCompositeIds.size < COMPOSITE_MAX_RETAINED
    ) {
      return true
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

    // Live secondary list: always while play-ready so we **pre-boot at ≤16m** before
    // stand-on promote (not only after 2s settle).
    const settled = this.isPlayerSettled()
    const mayDrainThisRefresh =
      this.prewarmActive || this.allowDrainOnce || settled
    // Live secondary workers off under GLB shells only — composites still load below.
    if (
      LOAD_AOI_SCENE_VISUALS &&
      aoiLiveSecondariesOnly() &&
      this.liveReconcileEnabled &&
      !aoiGlbShellsOnly()
    ) {
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
    for (const key of vacantKeys) {
      const k = key.trim()
      if (!this.loadedScatterParcels.has(k)) this.pendingScatterParcels.add(k)
    }
    // Drop pending that are no longer vacant in this ring (real scene claimed, etc.).
    for (const k of [...this.pendingScatterParcels]) {
      if (this.loadedScatterParcels.has(k)) {
        this.pendingScatterParcels.delete(k)
        continue
      }
      // Keep pending outside current ring — may re-enter; only drop if now real footprint.
      if (realSceneFootprint.has(k)) this.pendingScatterParcels.delete(k)
    }

    // --- Classic open-road foundation tiles (catalog + ownership, full Scene Distance) ---
    await this.refreshRoadTiles(entities, pointerToEntity, base, gen, ctx, dclX, dclZ, pointers)
    if (gen !== this.refreshGen || this.disposed || this.ctx !== ctx) return

    this.lastDiscoverFeet = { x: dclX, z: dclZ }
    this.lastDiscoverRadius = radiusM
    this.hasDiscoveredOnce = true

    // Enqueue-only unless prewarm / true settle / one-shot force. Never background-drain mid-play.
    if (!LOAD_AOI_SCENE_VISUALS) {
      this.compositeRoot.clear()
      this.loadedCompositeIds.clear()
      this.pendingCompositeIds.clear()
      this.clearFirstFrameGroups()
      this.firstFrameSampler.reset()
      ctx.onSecondaryCandidates?.([])
      if (mayDrainThisRefresh) {
        await this.drainOutstandingWork(dclX, dclZ, gen, this.prewarmActive, mayDrainThisRefresh)
      }
      this.allowDrainOnce = false
      return
    }

    // TEMP: hard-cap live workers + skip first-frame/script-warm thrash.
    if (aoiLiveSecondariesOnly()) {
      this.clearFirstFrameGroups()
      this.firstFrameSampler.reset()
      this.enqueueCompositeWork(entities, primaryId, pointerSet, dclX, dclZ, base)
      if (mayDrainThisRefresh) {
        await this.drainOutstandingWork(dclX, dclZ, gen, this.prewarmActive, mayDrainThisRefresh)
      }
      this.allowDrainOnce = false
      if (gen !== this.refreshGen || this.disposed || this.ctx !== ctx) return
      if (gen === this.refreshGen) {
        console.info(
          `[aoi] discover parcels=${pointers.length} vacantWarm=${vacantKeys.length} ` +
            `roads=${this.loadedRoadIds.size} composites=${this.loadedCompositeIds.size} ` +
            `pending={scatter:${this.pendingScatterParcels.size} composite:${this.pendingCompositeIds.size}} ` +
            `liveEnter=${secondaryLiveEnterRadiusM()}m liveKeep=${secondaryLiveKeepRadiusM()}m settled=${settled ? '1' : '0'} prewarm=${this.prewarmActive ? '1' : '0'}`
        )
      }
      return
    }

    this.enqueueCompositeWork(entities, primaryId, pointerSet, dclX, dclZ, base)
    if (mayDrainThisRefresh) {
      await this.drainOutstandingWork(dclX, dclZ, gen, this.prewarmActive, mayDrainThisRefresh)
    }
    this.allowDrainOnce = false
    if (gen !== this.refreshGen || this.disposed || this.ctx !== ctx) return

    // Script-built neighbors (Angzaar etc.): no composite → first-frame worker sample in inner radius.
    this.queueFirstFrameSecondaries(entities, primaryId, base, dclX, dclZ, pointerSet)

    if (gen === this.refreshGen) {
      let ffVis = 0
      for (const g of this.firstFrameGroups.values()) if (g.visible) ffVis++
      clientDebugLog.consoleOnly(
        'info',
        `[aoi] refresh parcels=${pointers.length} vacant=${vacantKeys.length} footprint=${realSceneFootprint.size} roads=${this.loadedRoadIds.size} composites=${this.loadedCompositeIds.size} firstFrame=${ffVis}/${this.firstFrameGroups.size} pendingScatter=${this.pendingScatterParcels.size} radius=${radiusM}m`
      )
    }
  }

  /**
   * Complete outstanding scatter / composite work from queues.
   * Prewarm always; otherwise only when {@link isPlayerSettled}.
   */
  private async drainOutstandingWork(
    dclX: number,
    dclZ: number,
    genHint?: number,
    forceUncappedScatter = false,
    /** Caller already decided drain is OK (prewarm / one-shot / settled). */
    allow = false
  ): Promise<void> {
    const ctx = this.ctx
    if (!ctx || this.disposed || this.drainInFlight) return
    // Force-uncapped is ONLY legal during active prewarm.
    if (forceUncappedScatter && !this.prewarmActive) {
      return
    }
    if (!forceUncappedScatter && !allow && !this.isPlayerSettled()) return
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
      // After mesh drain, (re)register only near-player tree/rock boxes.
      this.syncNearEmptyLandPhys(ctx, dclX, dclZ, /*force*/ true)

      if (
        this.pendingCompositeIds.size > 0 &&
        LOAD_AOI_SCENE_VISUALS &&
        (this.prewarmActive || allow || this.isPlayerSettled())
      ) {
        await this.drainPendingComposites(ctx, gen, dclX, dclZ)
      }
    } finally {
      this.drainInFlight = false
    }
  }

  /**
   * Mark composite candidates as outstanding (add-only).
   * New shells only inside {@link AOI_SHELL_ENTER_M}; already-loaded stay until KEEP.
   * Pointer fetch may still walk Scene Distance — this does not build 200m of clones.
   */
  private enqueueCompositeWork(
    entities: ActiveSceneEntity[],
    primaryId: string,
    pointerSet: Set<string>,
    dclX: number,
    dclZ: number,
    primaryBase: string
  ): void {
    const warmM = renderQuality.getSceneLoadRadiusM()
    if (warmM <= 0) return
    for (const e of entities) {
      if (primaryId && e.id === primaryId) continue
      if (!isSecondarySceneCandidate(e) || !findCompositeFile(e.content)) continue
      if (this.loadedCompositeIds.has(e.id)) {
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
      if (Number.isFinite(best) && best > AOI_SHELL_KEEP_M) continue
      if (Number.isFinite(best) && best > AOI_SHELL_ENTER_M && !this.loadedCompositeIds.has(e.id)) {
        continue
      }
      this.pendingCompositeIds.add(e.id)
    }
  }

  /**
   * main.composite tertiary meshes for multi-parcel neighbors (plaza ring, estates).
   * Entity-id dedupe; hide when a live secondary worker owns the same entity.
   * Distance-banded GLB caps + LRU retain so 200m walks don't unbounded-grow GPU.
   */
  private async loadSecondaryComposites(
    entities: ActiveSceneEntity[],
    primaryId: string,
    primaryBase: string,
    pointerSet: Set<string>,
    gen: number,
    ctx: NonNullable<typeof this.ctx>,
    dclX: number,
    dclZ: number
  ): Promise<void> {
    const distToEntity = (e: ActiveSceneEntity): number => {
      const keys = e.pointers.length ? e.pointers : e.parcels
      let best = Infinity
      for (const k of keys) {
        try {
          const p = parseParcelKey(k.trim())
          const d = distanceToParcelCenterM(dclX, dclZ, p, primaryBase)
          if (d < best) best = d
        } catch {
          /* bad key */
        }
      }
      return best
    }

    // Never re-load the primary entity as a secondary (full footprint already in primaryParcelSet).
    const compositeCandidates = entities.filter((e) => {
      if (primaryId && e.id === primaryId) return false
      if (!isSecondarySceneCandidate(e) || !findCompositeFile(e.content)) return false
      // Deployment whose entire in-ring footprint is already primary parcels → skip.
      const keys = e.pointers.length ? e.pointers : e.parcels
      const inRing = keys.filter((p) => pointerSet.has(p.trim()))
      if (
        inRing.length > 0 &&
        inRing.every((p) => this.primaryParcelSet.has(p.trim())) &&
        !this.primaryIsEmpty
      ) {
        return false
      }
      return true
    })

    // Drop secondaries that left the AOI, walked past KEEP, or are no longer composite-loadable.
    const wantIds = new Set(compositeCandidates.map((c) => c.id))
    for (const id of [...this.loadedCompositeIds]) {
      const ent = compositeCandidates.find((c) => c.id === id)
      const dist = ent ? distToEntity(ent) : Infinity
      if (!wantIds.has(id) || dist > AOI_SHELL_KEEP_M) {
        const child = this.compositeRoot.getObjectByName(`aoi-secondary:${id}`)
        child?.removeFromParent()
        this.loadedCompositeIds.delete(id)
        this.pendingCompositeIds.delete(id)
      }
    }

    // Multi-parcel shells first (CBD plaza around nested hole), then nearest.
    // Visual band: new attach ≤ ENTER; keep ≤ KEEP; past KEEP is road/ground only.
    const ranked = [...compositeCandidates]
      .filter((e) => {
        const d = distToEntity(e)
        if (d > AOI_SHELL_KEEP_M) return false
        if (d > AOI_SHELL_ENTER_M && !this.loadedCompositeIds.has(e.id)) return false
        return true
      })
      .sort((a, b) => {
      const aParcels = a.parcels.length || a.pointers.length
      const bParcels = b.parcels.length || b.pointers.length
      const aMega = aParcels >= 16 ? 1 : 0
      const bMega = bParcels >= 16 ? 1 : 0
      if (bMega !== aMega) return bMega - aMega
      if (bParcels !== aParcels) return bParcels - aParcels
      const da = distToEntity(a)
      const db = distToEntity(b)
      if (da !== db) return da - db
      const aHit = (a.pointers.length ? a.pointers : a.parcels).filter((p) => pointerSet.has(p)).length
      const bHit = (b.pointers.length ? b.pointers : b.parcels).filter((p) => pointerSet.has(p)).length
      return bHit - aHit
    })

    // LRU eviction when over retain cap — never drop multi-parcel shells first.
    if (this.loadedCompositeIds.size > COMPOSITE_MAX_RETAINED) {
      const loadedRanked = [...this.loadedCompositeIds]
        .map((id) => {
          const ent = compositeCandidates.find((c) => c.id === id)
          const parcels = ent ? ent.parcels.length || ent.pointers.length : 0
          return {
            id,
            dist: ent ? distToEntity(ent) : Infinity,
            mega: parcels >= 16
          }
        })
        .sort((a, b) => {
          if (a.mega !== b.mega) return a.mega ? 1 : -1 // drop non-mega first
          return b.dist - a.dist
        })
      while (this.loadedCompositeIds.size > COMPOSITE_MAX_RETAINED && loadedRanked.length) {
        const drop = loadedRanked.shift()!
        const child = this.compositeRoot.getObjectByName(`aoi-secondary:${drop.id}`)
        child?.removeFromParent()
        this.loadedCompositeIds.delete(drop.id)
      }
    }

    // Prefer plaza shells: load a small batch per drain tick (outstanding queue continues).
    const toLoad = ranked
      .filter((c) => !this.loadedCompositeIds.has(c.id) && this.pendingCompositeIds.has(c.id))
      .slice(0, COMPOSITE_LOAD_PER_DRAIN)
    // Fallback: if pending set empty but ranked has work (first call before enqueue), load ranked.
    const batch =
      toLoad.length > 0
        ? toLoad
        : ranked.filter((c) => !this.loadedCompositeIds.has(c.id)).slice(0, COMPOSITE_LOAD_PER_DRAIN)
    for (const ent of batch) {
      if (this.loadedCompositeIds.size >= COMPOSITE_MAX_RETAINED) break
      const comp = findCompositeFile(ent.content)
      if (!comp) {
        this.pendingCompositeIds.delete(ent.id)
        continue
      }
      const parcels = ent.parcels.length || ent.pointers.length
      const distM = distToEntity(ent)
      const maxGltfs = compositeMaxGltfsForDistance(distM, parcels)
      if (maxGltfs <= 0 || distM > AOI_SHELL_KEEP_M) {
        this.pendingCompositeIds.delete(ent.id)
        continue
      }
      try {
        await yieldToIdle(48)
        if (gen !== this.refreshGen || this.disposed || this.ctx !== ctx) return
        const group = await buildCompositeVisualGroup({
          cache: ctx.cache,
          contentBaseUrl: ctx.scene.realm.contentUrl,
          content: ent.content,
          compositeHash: comp.hash,
          neighborBase: ent.base,
          primaryBase,
          maxGltfs
        })
        if (gen !== this.refreshGen || this.disposed || this.ctx !== ctx) {
          group.clear()
          return
        }
        if (this.loadedCompositeIds.has(ent.id)) {
          this.pendingCompositeIds.delete(ent.id)
          continue
        }
        group.name = `aoi-secondary:${ent.id}`
        // Keep shell until full live graph is ready (avoids flash-reload on boot).
        group.visible = !this.liveGraphReadyIds.has(ent.id)
        // No shadows on tertiary — primary keeps the shadow budget.
        group.traverse((o) => {
          if ((o as THREE.Mesh).isMesh) {
            o.castShadow = false
            o.receiveShadow = true
          }
        })
        this.compositeRoot.add(group)
        this.loadedCompositeIds.add(ent.id)
        this.pendingCompositeIds.delete(ent.id)
        console.info(
          `[aoi] secondary composite entity=${ent.id.slice(0, 16)}… “${ent.title || ent.base}” ` +
            `parcels=${parcels} dist≈${distM.toFixed(0)}m gltfs≈${group.children.length}/${maxGltfs}`
        )
      } catch (err) {
        console.warn('[aoi] secondary composite failed', ent.id, err)
        // Leave in pending to retry once; avoid infinite fail loop on bad entity.
        this.pendingCompositeIds.delete(ent.id)
      }
    }
  }

  /**
   * Live-secondary candidates by **player → footprint** distance.
   * Emit up to keep radius (80m) so reconcile can hysteresis; boot only when ≤ enter (16m).
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
        return a.parcelCount - b.parcelCount
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
      console.info(
        `[aoi] live-secondary (player enter≤${enterM}m keep≤${keepM ?? '?'}m) ` +
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

    const scriptBuilt = entities.filter((e) => {
      if (primaryId && e.id === primaryId) return false
      if (!isSecondarySceneCandidate(e)) return false
      if (findCompositeFile(e.content)) return false // outer composite path owns these
      if (isOpenRoadEntity(e)) return false
      // Must intersect outer AOI pointers we already fetched
      const keys = e.pointers.length ? e.pointers : e.parcels
      const inRing = keys.filter((p) => pointerSet.has(p.trim()))
      if (!inRing.length) return false
      // Don't sample deployments already covered by the primary multi-parcel footprint.
      if (
        !this.primaryIsEmpty &&
        inRing.every((p) => this.primaryParcelSet.has(p.trim()))
      ) {
        return false
      }
      return true
    })

    // Prefer nearer / smaller estates.
    const ranked = [...scriptBuilt].sort((a, b) => {
      const da = minEntDist(a, dclX, dclZ, primaryBase)
      const db = minEntDist(b, dclX, dclZ, primaryBase)
      if (da !== db) return da - db
      return (a.parcels.length || a.pointers.length) - (b.parcels.length || b.pointers.length)
    })

    // Live secondaries: player→footprint (emit keep band; reconcile boots only at enter).
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
    const keepLiveM = secondaryLiveKeepRadiusM()
    for (const ent of ranked) {
      const keys = [
        ...new Set((ent.pointers.length ? ent.pointers : ent.parcels).map((p) => p.trim()).filter(Boolean))
      ]
      const dist = minPlayerToFootprintDistanceM(dclX, dclZ, keys, primaryBase)
      if (keepLiveM <= 0 || !Number.isFinite(dist) || dist > keepLiveM) continue
      try {
        const baseCoord = parseParcelKey(ent.base)
        liveCandidates.push({
          entityId: ent.id,
          title: ent.title || ent.base,
          base: ent.base,
          resolveX: baseCoord.x,
          resolveY: baseCoord.y,
          distM: dist,
          parcelCount: keys.length || 1,
          parcels: keys
        })
      } catch {
        /* skip */
      }
    }
    this.ctx?.onSecondaryCandidates?.(liveCandidates)

    // First-frame tertiary: still player warm band (visual LOD by where you stand).
    const warmRadiusM = renderQuality.getSceneLoadRadiusM()

    const wantFf = new Set<string>()
    let visibleSlots = 0
    const now = performance.now()

    for (const ent of ranked) {
      const dist = minEntDist(ent, dclX, dclZ, primaryBase)
      if (warmRadiusM <= 0 || dist > warmRadiusM) continue
      // Live secondary worker owns this scene — no static first-frame.
      if (this.liveSecondaryIds.has(ent.id)) continue
      if (visibleSlots >= FF_MAX_VISIBLE) break
      wantFf.add(ent.id)
      visibleSlots++
      this.firstFrameLastUse.set(ent.id, now)

      // Instant re-show — already sampled at current hierarchy version.
      const cached = this.firstFrameGroups.get(ent.id)
      if (cached) {
        if (cached.userData.ffHierarchyVer === FF_HIERARCHY_VERSION) {
          cached.visible = !this.liveGraphReadyIds.has(ent.id)
          continue
        }
        // Stale hierarchy bake — drop and re-sample.
        cached.removeFromParent()
        disposeObject3D(cached)
        this.firstFrameGroups.delete(ent.id)
        this.firstFrameSampler.forget(ent.id)
      }

      if (this.firstFrameSampler.knows(ent.id)) continue

      let baseCoord
      try {
        baseCoord = parseParcelKey(ent.base)
      } catch {
        continue
      }

      this.firstFrameSampler.enqueue({
        entityId: ent.id,
        title: ent.title || ent.base,
        base: ent.base,
        primaryBase,
        resolveX: baseCoord.x,
        resolveY: baseCoord.y,
        cache: ctx.cache,
        contentBaseUrl: ctx.scene.realm.contentUrl,
        onReady: (entityId, group) => {
          if (this.disposed || this.ctx !== ctx) {
            group.clear()
            return
          }
          const prev = this.firstFrameGroups.get(entityId)
          if (prev) {
            prev.removeFromParent()
            disposeObject3D(prev)
          }
          group.name = `aoi-secondary-ff:${entityId}`
          // Hide only when full live graph is ready (shell can overlap boot briefly).
          group.visible = !this.liveGraphReadyIds.has(entityId)
          this.firstFrameRoot.add(group)
          this.firstFrameGroups.set(entityId, group)
          this.firstFrameLastUse.set(entityId, performance.now())
          this.firstFrameSampler.markLoaded(entityId)
          this.pruneFirstFrameRetain()
        }
      })
    }

    // LOD hide — do **not** dispose or forget sampler (no full re-sample on re-enter).
    for (const [id, group] of this.firstFrameGroups) {
      if (wantFf.has(id) && !this.liveGraphReadyIds.has(id)) {
        group.visible = true
      } else {
        group.visible = false
      }
    }

    this.pruneFirstFrameRetain()
  }

  /** Evict oldest **hidden** first-frame groups when over retain cap. */
  private pruneFirstFrameRetain(): void {
    if (this.firstFrameGroups.size <= FF_MAX_RETAINED) return
    const hidden = [...this.firstFrameGroups.entries()]
      .filter(([, g]) => !g.visible)
      .sort(
        (a, b) =>
          (this.firstFrameLastUse.get(a[0]) ?? 0) - (this.firstFrameLastUse.get(b[0]) ?? 0)
      )
    while (this.firstFrameGroups.size > FF_MAX_RETAINED && hidden.length) {
      const [id, group] = hidden.shift()!
      group.removeFromParent()
      disposeObject3D(group)
      this.firstFrameGroups.delete(id)
      this.firstFrameLastUse.delete(id)
      // Allow a true re-sample only after eviction (meshes gone).
      this.firstFrameSampler.forget(id)
      console.info(`[aoi-ff] LRU evict first-frame secondary ${id.slice(0, 12)}… (retain>${FF_MAX_RETAINED})`)
    }
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
   * Coords AOI only (bind already gates worlds). Rebuilds only when primary base changes.
   */
  private async ensureGenesisEmptyPlane(
    ctx: NonNullable<typeof this.ctx>,
    gen: number,
    primaryBase: string
  ): Promise<void> {
    const baseKey = primaryBase.trim()
    if (this.blankRoot && this.blankPlaneBase === baseKey) return
    try {
      const plane = await buildGenesisCityEmptyPlane(ctx.cache, baseKey)
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
      this.blankPlaneBase = baseKey
      this.root.add(plane)
      const ud = plane.userData as {
        parcels?: { w?: number; d?: number }
        sizeM?: { x?: number; z?: number }
      }
      console.info(
        `[aoi] genesis empty plane ` +
          `${ud.parcels?.w ?? '?'}×${ud.parcels?.d ?? '?'} parcels ` +
          `(${((ud.sizeM?.x ?? 0) / 16).toFixed(0)}×${((ud.sizeM?.z ?? 0) / 16).toFixed(0)} @ 16m) ` +
          `base=${baseKey}`
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

    const baseCoord = parseParcelKey(primaryBase)
    const t0 = performance.now()
    let addedParcels = 0
    let addedColliders = 0
    let addedLayers = 0

    for (const [, chunkKeys] of byChunk) {
      if (gen !== this.refreshGen || this.disposed || this.ctx !== ctx) return
      try {
        const { root, colliders } = await buildEmptyParcelScatter({
          cache: ctx.cache,
          parcelKeys: chunkKeys,
          primaryBase
        })
        if (gen !== this.refreshGen || this.disposed || this.ctx !== ctx) {
          root.traverse((o) => {
            if (o instanceof THREE.InstancedMesh) o.geometry?.dispose()
          })
          root.clear()
          return
        }

        let cx = 0
        let cz = 0
        let n = 0
        for (const key of chunkKeys) {
          try {
            const p = parseParcelKey(key)
            cx += (p.x - baseCoord.x) * 16 + 8
            cz += (p.y - baseCoord.y) * 16 + 8
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
          centerZ: cz
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

  /** Load up to COMPOSITE_LOAD_PER_DRAIN outstanding composites from cached entities. */
  private async drainPendingComposites(
    ctx: NonNullable<typeof this.ctx>,
    gen: number,
    dclX: number,
    dclZ: number
  ): Promise<void> {
    if (!this.pendingCompositeIds.size || !this.cachedEntities.length) return
    const primaryBase = this.cachedPrimaryBase || ctx.scene.baseParcel
    const primaryId = this.cachedPrimaryId
    const pointerSet = this.cachedPointerSet

    // Reuse existing loader — it already caps per call; then sync pending set.
    await this.loadSecondaryComposites(
      this.cachedEntities,
      primaryId,
      primaryBase,
      pointerSet,
      gen,
      ctx,
      dclX,
      dclZ
    )
    if (gen !== this.refreshGen || this.disposed || this.ctx !== ctx) return

    // Clear pending for anything now loaded; drop ids no longer in cache.
    const cacheIds = new Set(this.cachedEntities.map((e) => e.id))
    for (const id of [...this.pendingCompositeIds]) {
      if (this.loadedCompositeIds.has(id) || !cacheIds.has(id)) {
        this.pendingCompositeIds.delete(id)
      }
    }
  }

  /**
   * Hide far scatter **meshes** (LOD). PhysX is separate — near-player only
   * ({@link EMPTY_LAND_PHYS_RADIUS_M}); grass never had colliders.
   */
  private updateStickyScatterLod(dclX: number, dclZ: number): void {
    const hideR2 = SCATTER_LOD_HIDE_M * SCATTER_LOD_HIDE_M
    for (const layer of this.scatterLayers) {
      const dx = layer.centerX - dclX
      const dz = layer.centerZ - dclZ
      layer.root.visible = dx * dx + dz * dz <= hideR2
    }
  }

  /** Dispose only when player is very far (teleport / cross-city walk). */
  private purgeFarScatterLayers(
    ctx: NonNullable<typeof this.ctx>,
    dclX: number,
    dclZ: number
  ): void {
    const purgeR2 = SCATTER_PURGE_M * SCATTER_PURGE_M
    const dropEntities: number[] = []
    let purged = 0
    for (let i = this.scatterLayers.length - 1; i >= 0; i--) {
      const layer = this.scatterLayers[i]!
      const dx = layer.centerX - dclX
      const dz = layer.centerZ - dclZ
      if (dx * dx + dz * dz <= purgeR2) continue
      for (const c of layer.colliders) dropEntities.push(c.entity)
      layer.root.removeFromParent()
      layer.root.traverse((o) => {
        if (o instanceof THREE.InstancedMesh) o.geometry?.dispose()
      })
      layer.root.clear()
      for (const k of layer.parcelKeys) this.loadedScatterParcels.delete(k)
      this.scatterLayers.splice(i, 1)
      purged++
    }
    if (purged > 0) {
      ctx.purgeEmptyLandColliders?.(dropEntities)
      for (const id of dropEntities) this.lastNearEmptyLandIds.delete(id)
      this.syncNearEmptyLandPhys(ctx, dclX, dclZ, /*force*/ true)
      console.info(
        `[aoi] scatter purge >${SCATTER_PURGE_M}m layers=${purged} remain=${this.scatterLayers.length}`
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
    const near: PhysicsColliderDesc[] = []
    const nearIds = new Set<number>()
    for (const layer of this.scatterLayers) {
      for (const c of layer.colliders) {
        const e = c.matrix.elements
        // three.x = −sceneX → sceneX = −e[12]; compare in scene-local feet space.
        const dx = -e[12]! - dclX
        const dz = e[14]! - dclZ
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
    ctx.syncEmptyLandColliders?.(near)
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
    if (signature === this.roadParcelSignature && this.roadRoot.children.length > 0) {
      return
    }

    const placements: RoadTilePlacement[] = []
    for (const [parcelKey, ent] of roadParcels) {
      if (gen !== this.refreshGen || this.disposed || this.ctx !== ctx) return
      try {
        let placement = ent
          ? await resolveRoadTilePlacement(ent, ctx.scene.realm.contentUrl)
          : null
        if (!placement) {
          const entry = getExplorerRoadEntry(parcelKey)
          if (!entry) continue
          placement = {
            entityId: `parcel:${parcelKey}`,
            parcelKey,
            model: entry.model,
            rotation: entry.rotation,
            source: 'explorer-catalog'
          }
        }
        placements.push(placement)
      } catch (err) {
        console.warn('[aoi] road placement resolve failed', parcelKey, err)
      }
    }

    if (gen !== this.refreshGen || this.disposed || this.ctx !== ctx) return

    try {
      const built = await buildInstancedRoadLayer({
        placements,
        primaryBase,
        cache: ctx.cache,
        contentBaseUrl: ctx.scene.realm.contentUrl
      })
      if (gen !== this.refreshGen || this.disposed || this.ctx !== ctx) {
        disposeRoadInstancedRoot(built.root)
        return
      }
      // Swap visuals first, then sync colliders without a pre-wipe gap.
      // clearRoads() used to clearRoadColliders() before rebuild → ~400 soft planters mid-hitch.
      this.roadRoot.clear()
      this.roadRoot.add(built.root)
      this.roadParcelSignature = signature
      this.loadedRoadIds.clear()
      for (const p of placements) this.loadedRoadIds.add(`parcel:${p.parcelKey}`)
      // Visual roads = full Scene Distance; PhysX furniture only near player (CCT budget).
      const physR2 = ROAD_PHYS_RADIUS_M * ROAD_PHYS_RADIUS_M
      const nearColliders = built.colliders.filter((c) => {
        const e = c.matrix.elements
        const dx = e[12]! - dclX
        const dz = e[14]! - dclZ
        return dx * dx + dz * dz <= physR2
      })
      // syncAoiRoadColliders replace-keeps live actors and drops orphans — no clear first.
      ctx.syncRoadColliders?.(nearColliders)
    } catch (err) {
      console.warn('[aoi] instanced roads failed', err)
    }
  }

  private clearRoads(): void {
    // Geometry/materials are shared from the prop template cache — do not dispose.
    this.roadRoot.clear()
    this.loadedRoadIds.clear()
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
    this.blankPlaneBase = ''
  }

  private clearScatter(): void {
    for (const layer of this.scatterLayers) {
      layer.root.removeFromParent()
      layer.root.traverse((o) => {
        if (o instanceof THREE.InstancedMesh) o.geometry?.dispose()
      })
      layer.root.clear()
    }
    this.scatterLayers.length = 0
    this.loadedScatterParcels.clear()
    this.pendingScatterParcels.clear()
    this.lastNearEmptyLandIds.clear()
    this.lastEmptyLandPhysFeet = { x: Number.NaN, z: Number.NaN }
    this.scatterRoot.clear()
    // scatterRoot stays attached under this.root for sticky adds.
    this.ctx?.clearEmptyLandColliders?.()
  }
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

function minEntDist(
  ent: ActiveSceneEntity,
  dclX: number,
  dclZ: number,
  primaryBase: string
): number {
  const keys = ent.pointers.length ? ent.pointers : ent.parcels
  let best = Infinity
  for (const key of keys) {
    try {
      const p = parseParcelKey(key)
      const d = distanceToParcelCenterM(dclX, dclZ, p, primaryBase)
      if (d < best) best = d
    } catch {
      /* bad pointer */
    }
  }
  if (!Number.isFinite(best)) {
    try {
      return distanceToParcelCenterM(dclX, dclZ, parseParcelKey(ent.base), primaryBase)
    } catch {
      return Infinity
    }
  }
  return best
}
