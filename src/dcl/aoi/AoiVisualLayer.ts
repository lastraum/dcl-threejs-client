import * as THREE from 'three'
import type { AssetCache } from '../../rendering/AssetCache'
import { renderQuality } from '../../rendering/RenderQualitySettings'
import type { ResolvedScene } from '../content/types'
import { EMPTY_LAND } from '../landscape/Data/EmptyLandCatalog'
import { buildInstancedGroundTiles } from '../landscape/gltfInstancing'
import { parseParcelKey } from '../content/parseParcel'
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
  minSceneFootprintDistanceM,
  parcelsInLoadRadius,
  parcelsNearFootprint,
  parcelSwSceneLocal
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
  aoiLiveSecondariesOnly,
  COMPOSITE_MAX_RETAINED,
  compositeMaxGltfsForDistance,
  ROAD_PHYS_RADIUS_M,
  secondaryLiveRadiusM
} from '../multiScene/caps'

/** Visible first-frame secondaries inside the inner radius. */
const FF_MAX_VISIBLE = 3
/**
 * Keep this many first-frame groups in memory (visible + hidden).
 * Leaving the inner ring **hides** instead of destroying — re-enter is free.
 * Oldest hidden groups are disposed when over this cap.
 */
const FF_MAX_RETAINED = 6

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
 * - Empty layer: instanced blank ground + trees/bushes on vacant parcels
 * - Genesis roads via **Explorer catalog + OriginalAssets FBX** (tile + street
 *   furniture), not runtime SDK6 game.js
 * - Neighbor main.composite GLBs (render-only, no colliders / anim) — **tertiary**
 * - First-frame samples for script-built scenes (tertiary when no live worker)
 * - Live secondary candidates by **scene-to-scene** footprint proximity
 *   (budgeted workers; FocusOwner = primary only; frustum LOD is player-side)
 */
export class AoiVisualLayer {
  private root = new THREE.Group()
  private blankRoot: THREE.Object3D | null = null
  private scatterRoot: THREE.Object3D | null = null
  private compositeRoot = new THREE.Group()
  private roadRoot = new THREE.Group()
  private firstFrameRoot = new THREE.Group()
  private ctx: AoiVisualLayerContext | null = null
  private enabled = false
  private disposed = false
  private refreshGen = 0
  private lastParcelKey = ''
  private lastRadius = -1
  private lastRefreshAt = 0
  private readonly loadedCompositeIds = new Set<string>()
  private readonly loadedRoadIds = new Set<string>()
  /** Sorted parcel keys currently baked into the instanced road layer. */
  private roadParcelSignature = ''
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
    this.compositeRoot.name = 'aoi-composite-secondaries'
    this.roadRoot.name = 'aoi-road-tiles'
    this.firstFrameRoot.name = 'aoi-first-frame-secondaries'
    this.root.add(this.roadRoot)
    this.root.add(this.compositeRoot)
    this.root.add(this.firstFrameRoot)
  }

  /**
   * Live secondary workers own these entity ids — hide tertiary first-frame
   * and composite meshes so we don't double-draw. **Restores** visibility when
   * a live worker is evicted (previously only hid, never re-showed).
   */
  setLiveSecondaryIds(ids: ReadonlySet<string>): void {
    this.liveSecondaryIds.clear()
    for (const id of ids) this.liveSecondaryIds.add(id)
    for (const [id, group] of this.firstFrameGroups) {
      group.visible = !this.liveSecondaryIds.has(id)
    }
    for (const child of this.compositeRoot.children) {
      const name = child.name
      if (!name.startsWith('aoi-secondary:')) continue
      const id = name.slice('aoi-secondary:'.length)
      child.visible = !this.liveSecondaryIds.has(id)
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
      // Force refresh next update so ring fills after boot gate lifts.
      this.lastParcelKey = ''
      this.lastRefreshAt = 0
    } else {
      console.info('[aoi] neighbor activity OFF (primary booting)')
    }
  }

  /**
   * Loading-phase warm: fill default ground + roads + empty scatter + composites
   * for Scene Distance **before** play-ready. Live secondary workers stay off
   * until {@link setNeighborActivityEnabled}(true).
   */
  prewarmVisuals(dclX: number, dclZ: number): void {
    if (this.disposed || !this.enabled || !this.ctx) return
    this.neighborActivityEnabled = true
    this.liveReconcileEnabled = false
    this.lastParcelKey = ''
    this.lastRefreshAt = 0
    console.info(
      `[aoi] prewarm visuals @ feet=(${dclX.toFixed(1)},${dclZ.toFixed(1)}) ` +
        `radius=${renderQuality.getSceneLoadRadiusM()}m (live workers still gated)`
    )
    void this.refresh(dclX, dclZ, renderQuality.getSceneLoadRadiusM())
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
    // Keep composites/roads/scatter; force refresh under new primary + feet.
    this.lastParcelKey = ''
    this.lastRadius = -1
    this.lastRefreshAt = 0
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
    void this.refresh(dclX, dclZ, renderQuality.getSceneLoadRadiusM())
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
    this.clearBlank()
    this.clearScatter()
    this.compositeRoot.clear()
    this.clearRoads()
    this.clearFirstFrameGroups()
    this.loadedCompositeIds.clear()
    this.loadedRoadIds.clear()
    this.roadParcelSignature = ''
    this.liveSecondaryIds.clear()
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
   * Throttled refresh from player feet (scene-local DCL meters).
   * No-op for worlds / radius 0 / until neighbor activity enabled.
   */
  update(dclX: number, dclZ: number, force = false): void {
    if (this.disposed || !this.enabled || !this.ctx) return
    if (!this.neighborActivityEnabled && !force) return
    const radius = renderQuality.getSceneLoadRadiusM()
    if (radius <= 0) {
      if (this.lastRadius !== 0) {
        this.clearBlank()
        this.clearScatter()
            this.compositeRoot.clear()
        this.clearRoads()
        this.clearFirstFrameGroups()
        this.loadedCompositeIds.clear()
        this.loadedRoadIds.clear()
        this.roadParcelSignature = ''
        this.firstFrameSampler.reset()
        this.lastRadius = 0
        // Empty primary still needs local blank+scatter even at radius 0.
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
    if (!force && !movedParcel && !radiusChanged && now - this.lastRefreshAt < 2500) return

    this.lastParcelKey = parcelKey
    this.lastRadius = radius
    this.lastRefreshAt = now
    void this.refresh(dclX, dclZ, radius)
  }

  private async refresh(dclX: number, dclZ: number, radiusM: number): Promise<void> {
    const ctx = this.ctx
    if (!ctx || this.disposed) return
    const gen = ++this.refreshGen
    const base = ctx.scene.baseParcel
    // Player warm band (composites/roads) ∪ primary-footprint + live proximity
    // so nested hole scenes are always discovered regardless of where you stand.
    const playerPointers = parcelsInLoadRadius(dclX, dclZ, base, radiusM)
    const liveProxM = secondaryLiveRadiusM()
    const primaryAdjacent =
      liveProxM > 0 && this.primaryParcelSet.size
        ? parcelsNearFootprint([...this.primaryParcelSet], liveProxM)
        : []
    const pointers = [...new Set([...playerPointers, ...primaryAdjacent])]
    if (!pointers.length) return

    // Warm Explorer road catalog early so vacant layer can skip road parcels.
    await ensureExplorerRoadsReady()
    if (gen !== this.refreshGen || this.disposed || this.ctx !== ctx) return

    const entities = await fetchActiveEntitiesForPointers(ctx.scene.realm.contentUrl, pointers)
    if (gen !== this.refreshGen || this.disposed || this.ctx !== ctx) return

    // Prefer multi-parcel scenes over classic roads when claims collide.
    const pointerToEntity = buildPointerOwnershipMap(entities)
    const pointerSet = new Set(pointers)
    const primaryId = ctx.scene.entityId?.trim() ?? ''

    // Footprint fill only for parcels actually in the AOI (never whole 400-parcel estates).
    const secondaryFootprint = new Set<string>()
    for (const ent of entities) {
      if (!isSecondarySceneCandidate(ent)) continue
      if (ent.id === primaryId) continue
      for (const p of ent.pointers.length ? ent.pointers : ent.parcels) {
        if (!pointerSet.has(p)) continue
        if (this.primaryParcelSet.has(p) && !this.primaryIsEmpty) continue
        secondaryFootprint.add(p)
      }
    }

    // --- Already-loaded scenes (any ring): never empty-land candidates ---
    // Primary, sticky demoted, live secondary/tertiary, composite shells, first-frame samples.
    const loadedEntityIds = new Set<string>()
    if (primaryId) loadedEntityIds.add(primaryId)
    for (const id of this.liveSecondaryIds) loadedEntityIds.add(id)
    for (const id of this.loadedCompositeIds) loadedEntityIds.add(id)
    for (const id of this.firstFrameGroups.keys()) loadedEntityIds.add(id)

    const loadedParcelSet = new Set<string>()
    if (!this.primaryIsEmpty) {
      for (const p of this.primaryParcelSet) loadedParcelSet.add(p)
    }
    for (const p of this.residentParcelSet) loadedParcelSet.add(p)
    for (const ent of entities) {
      if (!loadedEntityIds.has(ent.id)) continue
      for (const p of ent.pointers.length ? ent.pointers : ent.parcels) {
        if (pointerSet.has(p)) loadedParcelSet.add(p.trim())
      }
    }

    // Empty-land = true vacant / catalyst-empty only. Never under a loaded scene graph.
    const vacantKeys: string[] = []
    const groundKeys: string[] = []
    let skippedLoadedGround = 0
    for (const key of pointers) {
      const k = key.trim()
      // Already-loaded scene owns this parcel at any ring — never empty fill.
      if (loadedParcelSet.has(k)) {
        skippedLoadedGround++
        continue
      }
      const ent = pointerToEntity.get(key) ?? pointerToEntity.get(k)
      if (ent?.id && loadedEntityIds.has(ent.id)) {
        skippedLoadedGround++
        continue
      }
      // Real non-empty scene footprint (even before our graph is registered) — not empty land.
      if (secondaryFootprint.has(k) || secondaryFootprint.has(key)) {
        skippedLoadedGround++
        continue
      }
      if (ent && isSecondarySceneCandidate(ent) && !isVacantForEmptyLayer(ent)) {
        skippedLoadedGround++
        continue
      }
      // Explorer roads have their own tiles
      if (isExplorerRoadParcel(key) || isExplorerRoadParcel(k)) continue
      if (ent && isOpenRoadEntity(ent)) continue
      // Only true vacant / catalyst empty parcels get blank ground + scatter.
      if (ent && !isVacantForEmptyLayer(ent)) continue
      groundKeys.push(key)
      vacantKeys.push(key)
    }
    if (skippedLoadedGround > 0) {
      console.info(
        `[aoi] empty-land skip loaded-scene parcels=${skippedLoadedGround} ` +
          `(loadedEntities=${loadedEntityIds.size} loadedParcels=${loadedParcelSet.size})`
      )
    }

    const blankTiles = groundKeys.map((key) => {
      const sw = parcelSwSceneLocal(key, base)
      return { x: sw.x, z: sw.z }
    })

    try {
      // Pass base so tiles use dclSceneToLandscapeThree (X reflection) like InfiniteGround.
      const blankGroup = await buildInstancedGroundTiles(
        ctx.cache,
        EMPTY_LAND.ground,
        blankTiles,
        'aoi-blank-ground',
        parseParcelKey(base)
      )
      if (gen !== this.refreshGen || this.disposed || this.ctx !== ctx) {
        blankGroup.traverse((o) => {
          if (o instanceof THREE.Mesh) {
            o.geometry?.dispose()
          }
        })
        return
      }
      this.clearBlank()
      this.blankRoot = blankGroup
      this.root.add(blankGroup)
    } catch (err) {
      console.warn('[aoi] blank ground failed', err)
    }

    try {
      const { root: scatter, colliders } = await buildEmptyParcelScatter({
        cache: ctx.cache,
        parcelKeys: vacantKeys,
        primaryBase: base
      })
      if (gen !== this.refreshGen || this.disposed || this.ctx !== ctx) {
        scatter.clear()
        return
      }
      this.clearScatter()
      this.scatterRoot = scatter
      this.root.add(scatter)
      ctx.syncEmptyLandColliders?.(colliders)
    } catch (err) {
      console.warn('[aoi] empty scatter failed', err)
    }

    // --- Classic open-road foundation tiles (only if ownership still maps to the road) ---
    await this.refreshRoadTiles(entities, pointerToEntity, base, gen, ctx, dclX, dclZ)
    if (gen !== this.refreshGen || this.disposed || this.ctx !== ctx) return

    if (!LOAD_AOI_SCENE_VISUALS) {
      // Hotfix: roads + empty only — clear any prior scene bakes, no secondary workers.
      this.compositeRoot.clear()
      this.loadedCompositeIds.clear()
      this.clearFirstFrameGroups()
      this.firstFrameSampler.reset()
      ctx.onSecondaryCandidates?.([])
      if (gen === this.refreshGen) {
        clientDebugLog.consoleOnly(
          'info',
          `[aoi] refresh parcels=${pointers.length} vacant=${vacantKeys.length} footprint=${secondaryFootprint.size} roads=${this.loadedRoadIds.size} composites=off firstFrame=off radius=${radiusM}m`
        )
      }
      return
    }

    // TEMP: hard-cap live workers + skip first-frame/script-warm thrash.
    // Still load multi-parcel composites so CBD plaza ring stays visible when nested
    // hole scenes (Spring in the Snow @ -142,99) are primary.
    if (aoiLiveSecondariesOnly()) {
      this.clearFirstFrameGroups()
      this.firstFrameSampler.reset()
      this.emitLiveSecondaryCandidatesOnly(entities, primaryId, base, dclX, dclZ, pointerSet)
      await this.loadSecondaryComposites(entities, primaryId, base, pointerSet, gen, ctx, dclX, dclZ)
      if (gen !== this.refreshGen || this.disposed || this.ctx !== ctx) return
      if (gen === this.refreshGen) {
        console.info(
          `[aoi] refresh LIVE+COMPOSITE parcels=${pointers.length} roads=${this.loadedRoadIds.size} ` +
            `composites=${this.loadedCompositeIds.size} liveRadius=${secondaryLiveRadiusM()}m ` +
            `(no first-frame/script-warm — plaza ring via composite)`
        )
      }
      return
    }

    // --- Secondary visuals: main.composite (outer) + first-frame sample (inner).
    await this.loadSecondaryComposites(entities, primaryId, base, pointerSet, gen, ctx, dclX, dclZ)
    if (gen !== this.refreshGen || this.disposed || this.ctx !== ctx) return

    // Script-built neighbors (Angzaar etc.): no composite → first-frame worker sample in inner radius.
    this.queueFirstFrameSecondaries(entities, primaryId, base, dclX, dclZ, pointerSet)

    if (gen === this.refreshGen) {
      let ffVis = 0
      for (const g of this.firstFrameGroups.values()) if (g.visible) ffVis++
      clientDebugLog.consoleOnly(
        'info',
        `[aoi] refresh parcels=${pointers.length} vacant=${vacantKeys.length} footprint=${secondaryFootprint.size} roads=${this.loadedRoadIds.size} composites=${this.loadedCompositeIds.size} firstFrame=${ffVis}/${this.firstFrameGroups.size} radius=${radiusM}m`
      )
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

    // Drop secondaries that left the AOI or are no longer composite-loadable
    const wantIds = new Set(compositeCandidates.map((c) => c.id))
    for (const id of [...this.loadedCompositeIds]) {
      if (!wantIds.has(id)) {
        const child = this.compositeRoot.getObjectByName(`aoi-secondary:${id}`)
        child?.removeFromParent()
        this.loadedCompositeIds.delete(id)
      }
    }

    // Multi-parcel shells first (CBD plaza around nested hole), then nearest.
    const ranked = [...compositeCandidates].sort((a, b) => {
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

    // Prefer plaza shells: load up to 3/refresh, mega-parcel first (ranked above).
    const toLoad = ranked.filter((c) => !this.loadedCompositeIds.has(c.id)).slice(0, 3)
    for (const ent of toLoad) {
      if (this.loadedCompositeIds.size >= COMPOSITE_MAX_RETAINED) break
      const comp = findCompositeFile(ent.content)
      if (!comp) continue
      const parcels = ent.parcels.length || ent.pointers.length
      const distM = distToEntity(ent)
      const maxGltfs = compositeMaxGltfsForDistance(distM, parcels)
      try {
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
        if (this.loadedCompositeIds.has(ent.id)) continue
        group.name = `aoi-secondary:${ent.id}`
        // Hide if a live secondary worker owns this entity (avoid double-draw).
        group.visible = !this.liveSecondaryIds.has(ent.id)
        // No shadows on tertiary — primary keeps the shadow budget.
        group.traverse((o) => {
          if ((o as THREE.Mesh).isMesh) {
            o.castShadow = false
            o.receiveShadow = true
          }
        })
        this.compositeRoot.add(group)
        this.loadedCompositeIds.add(ent.id)
        console.info(
          `[aoi] secondary composite entity=${ent.id.slice(0, 16)}… “${ent.title || ent.base}” ` +
            `parcels=${parcels} dist≈${distM.toFixed(0)}m gltfs≈${group.children.length}/${maxGltfs}`
        )
      } catch (err) {
        console.warn('[aoi] secondary composite failed', ent.id, err)
      }
    }
  }

  /**
   * Live-secondary candidates by **scene-to-scene** footprint proximity (not player).
   * Nested hole scenes (Spring @ plaza cutout) have ~0m edge distance → always live.
   * Player frustum LOD is applied later on the live worker meshes, not for eligibility.
   */
  private emitLiveSecondaryCandidatesOnly(
    entities: ActiveSceneEntity[],
    primaryId: string,
    _primaryBase: string,
    _dclX: number,
    _dclZ: number,
    pointerSet: Set<string>
  ): void {
    // Prewarm visuals only — do not boot workers until play-ready.
    if (!this.liveReconcileEnabled) {
      return
    }
    const liveProxM = secondaryLiveRadiusM()
    if (liveProxM <= 0) {
      this.ctx?.onSecondaryCandidates?.([])
      return
    }

    const primaryParcels = [...this.primaryParcelSet]
    if (!primaryParcels.length) {
      this.ctx?.onSecondaryCandidates?.([])
      return
    }

    const scriptBuilt = entities.filter((e) => {
      if (primaryId && e.id === primaryId) return false
      if (!isSecondarySceneCandidate(e)) return false
      if (isOpenRoadEntity(e)) return false
      const keys = e.pointers.length ? e.pointers : e.parcels
      // Must appear in fetched pointer set (player warm ∪ primary+proximity ring).
      if (!keys.some((p) => pointerSet.has(p.trim()))) return false
      return true
    })

    const withSceneDist = scriptBuilt.map((e) => {
      const keys = [
        ...new Set((e.pointers.length ? e.pointers : e.parcels).map((p) => p.trim()).filter(Boolean))
      ]
      const dist = minSceneFootprintDistanceM(primaryParcels, keys)
      // Nested hole: zero edge distance and no parcel owned by primary (Spring in plaza cutout).
      const nestedHole =
        dist === 0 && keys.length > 0 && keys.every((p) => !this.primaryParcelSet.has(p))
      return { ent: e, dist, parcelCount: keys.length || 1, keys, nestedHole }
    })

    const ranked = withSceneDist
      .filter((x) => Number.isFinite(x.dist) && x.dist <= liveProxM)
      .sort((a, b) => {
        // Nested hole scenes first (always live when standing in CBD plaza).
        if (a.nestedHole !== b.nestedHole) return a.nestedHole ? -1 : 1
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
    this.ctx?.onSecondaryCandidates?.(liveCandidates)
    if (liveCandidates.length) {
      console.info(
        `[aoi] live-secondary (scene-prox≤${liveProxM}m) n=${liveCandidates.length} nearest=${liveCandidates
          .slice(0, 5)
          .map(
            (c) =>
              `“${c.title}”@${c.base}(scene ${c.distM.toFixed(0)}m,p=${c.parcelCount})`
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

    // Live secondaries: scene-to-scene footprint proximity (not player distance).
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
    const liveProxM = secondaryLiveRadiusM()
    const primaryParcels = [...this.primaryParcelSet]
    for (const ent of ranked) {
      const keys = [
        ...new Set((ent.pointers.length ? ent.pointers : ent.parcels).map((p) => p.trim()).filter(Boolean))
      ]
      const dist = minSceneFootprintDistanceM(primaryParcels, keys)
      if (liveProxM <= 0 || !Number.isFinite(dist) || dist > liveProxM) continue
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
          cached.visible = !this.liveSecondaryIds.has(ent.id)
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
          // Race: live secondary may have started while this sample was in flight.
          // Never show a static first-frame over a live worker (dual prize portal / rotators).
          group.visible = !this.liveSecondaryIds.has(entityId)
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
      if (wantFf.has(id) && !this.liveSecondaryIds.has(id)) {
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

  /** Radius 0 but empty primary — still show local blank + trees. */
  private async refreshEmptyPrimaryOnly(): Promise<void> {
    const ctx = this.ctx
    if (!ctx || this.disposed || !this.primaryIsEmpty) return
    const gen = ++this.refreshGen
    const base = ctx.scene.baseParcel
    const vacantKeys = [...this.primaryParcelSet]
    const blankTiles = vacantKeys.map((key) => {
      const sw = parcelSwSceneLocal(key, base)
      return { x: sw.x, z: sw.z }
    })
    try {
      const blankGroup = await buildInstancedGroundTiles(
        ctx.cache,
        EMPTY_LAND.ground,
        blankTiles,
        'aoi-blank-ground',
        parseParcelKey(base)
      )
      if (gen !== this.refreshGen || this.disposed || this.ctx !== ctx) return
      this.clearBlank()
      this.blankRoot = blankGroup
      this.root.add(blankGroup)

      const { root: scatter, colliders } = await buildEmptyParcelScatter({
        cache: ctx.cache,
        parcelKeys: vacantKeys,
        primaryBase: base
      })
      if (gen !== this.refreshGen || this.disposed || this.ctx !== ctx) return
      this.clearScatter()
      this.scatterRoot = scatter
      this.root.add(scatter)
      ctx.syncEmptyLandColliders?.(colliders)
      console.info(
        `[aoi] empty primary fill parcels=${vacantKeys.length} colliders=${colliders.length}`
      )
    } catch (err) {
      console.warn('[aoi] empty primary fill failed', err)
    }
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
    dclZ: number
  ): Promise<void> {
    await ensureExplorerRoadsReady()
    if (gen !== this.refreshGen || this.disposed || this.ctx !== ctx) return

    // Parcels in AOI that are Genesis roads (catalog) and not owned by a secondary scene.
    const roadParcels = new Map<string, ActiveSceneEntity | null>()
    for (const ent of entities) {
      const parcel = (ent.parcels[0] ?? ent.pointers[0] ?? ent.base).trim()
      if (!parcel || this.primaryParcelSet.has(parcel)) continue
      const owner = ownership.get(parcel)
      if (owner && isSecondarySceneCandidate(owner) && !isExplorerRoadParcel(parcel)) {
        continue
      }
      if (isExplorerRoadParcel(parcel) || isClassicOpenRoadEntity(ent)) {
        roadParcels.set(parcel, ent)
      }
    }
    // Catalog-only: entity list may omit some roads; use ownership keys in AOI
    for (const key of ownership.keys()) {
      if (this.primaryParcelSet.has(key)) continue
      if (!isExplorerRoadParcel(key)) continue
      if (roadParcels.has(key)) continue
      const owner = ownership.get(key)
      if (owner && isSecondarySceneCandidate(owner)) continue
      roadParcels.set(key, owner ?? null)
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
      if (o instanceof THREE.InstancedMesh) {
        o.geometry?.dispose()
      }
    })
    this.blankRoot = null
  }

  private clearScatter(): void {
    if (!this.scatterRoot) return
    this.scatterRoot.removeFromParent()
    this.scatterRoot.traverse((o) => {
      if (o instanceof THREE.InstancedMesh) {
        o.geometry?.dispose()
      }
    })
    this.scatterRoot = null
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
