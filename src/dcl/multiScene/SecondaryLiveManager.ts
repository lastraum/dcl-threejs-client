import type { EntityPose } from '../../bridge/ReservedEntitiesSync'
import type { AssetCache } from '../../rendering/AssetCache'
import type { SceneHost } from '../../rendering/SceneHost'
import type { PhysicsColliderDesc } from '../../physics/PhysXWorld'
import type { PerformanceTier } from '../../shim/types'
import type { SceneScriptSystem } from '../../core/systems/SceneScriptSystem'
import { resolveSceneFromRoute } from '../content/resolveScene'
import type { ResolvedScene } from '../content/types'
import {
  SECONDARY_LIVE_AUTO_MAX_PARCELS,
  SECONDARY_LIVE_BOOT_CONCURRENCY,
  secondaryLiveCap,
  secondaryLiveRadiusM,
  secondaryTickIntervalMs,
  tertiaryResidentCap
} from './caps'
import type { PrivilegedIntentArbiter } from './PrivilegedIntentArbiter'
import { secondaryPhysOffset } from './physOffsets'
import { SceneWorkerSlot, type ResidentMode } from './SceneWorkerSlot'
import type { SecondaryLiveRequest } from './types'

export type PromoteHandoffPayload = {
  entityId: string
  scene: ResolvedScene
  system: SceneScriptSystem
  /** Phys ids that were registered under secondary offset — World should invalidate. */
  physIds: number[]
}

/**
 * Long-lived secondary **and** tertiary residents.
 *
 * Continuity contract (COD bar):
 * - Never dispose a loaded graph just because it left the 16m live ring.
 * - Leave ring → tertiary (scripts off + visual LOD, meshes stay).
 * - Re-enter ring → secondary (scripts on only — no GLB reload).
 * - Cap pressure: demote secondary→tertiary first; only dispose farthest non-sticky tertiary.
 * - Sticky demoted primaries always retained.
 */
export class SecondaryLiveManager {
  private readonly slots = new Map<string, SceneWorkerSlot>()
  /** Demoted primaries — never auto-evicted (only by promote handoff). */
  private readonly stickyIds = new Set<string>()
  private readonly booting = new Set<string>()
  private disposed = false
  private tier: PerformanceTier = 'high'
  private primaryScene: ResolvedScene | null = null
  private cache: AssetCache | null = null
  private host: SceneHost | null = null
  private arbiter: PrivilegedIntentArbiter | null = null
  private poseProvider: (() => { player: EntityPose; camera: EntityPose }) | null = null
  private onLiveIdsChange: ((ids: ReadonlySet<string>) => void) | null = null
  private lastReconcileAt = 0
  private nextSlotIndex = 0
  /**
   * Parcel under feet (absolute) — always prefer a covering candidate for live secondary
   * so walk-on promote can hand off without a cold /goto loading screen.
   */
  private priorityParcelKey: string | null = null

  bind(opts: {
    primaryScene: ResolvedScene
    cache: AssetCache
    host: SceneHost
    tier: PerformanceTier
    arbiter: PrivilegedIntentArbiter
    poseProvider: () => { player: EntityPose; camera: EntityPose }
    onLiveIdsChange?: (ids: ReadonlySet<string>) => void
  }): void {
    this.primaryScene = opts.primaryScene
    this.cache = opts.cache
    this.host = opts.host
    this.tier = opts.tier
    this.arbiter = opts.arbiter
    this.poseProvider = opts.poseProvider
    this.onLiveIdsChange = opts.onLiveIdsChange ?? null
  }

  setPrimaryScene(scene: ResolvedScene): void {
    this.primaryScene = scene
    // Every secondary was authored relative to its own SW; host origin is now
    // the new primary SW — re-apply (neighbor − primary) offsets or demoted
    // content piles on the new primary (rogue GLBs).
    const base = scene.baseParcel
    for (const slot of this.slots.values()) {
      slot.retargetPrimaryBase(base)
    }
  }

  setTier(tier: PerformanceTier): void {
    this.tier = tier
  }

  /** Live secondary script budget (tertiary residents use a separate cap). */
  private maxSecondarySlots(): number {
    return Math.max(1, secondaryLiveCap(this.tier))
  }

  private maxTertiarySlots(): number {
    return Math.max(2, tertiaryResidentCap(this.tier))
  }

  /** Total resident slots (secondary + tertiary graphs). Sticky always kept. */
  private maxTotalSlots(): number {
    return this.maxSecondarySlots() + this.maxTertiarySlots()
  }

  liveEntityIds(): Set<string> {
    return new Set(this.slots.keys())
  }

  hasSecondaryForParcel(x: number, y: number): boolean {
    return this.findSlotForParcel(x, y) !== null
  }

  /** Prefer booting a live secondary that covers this absolute parcel (under feet). */
  setPriorityParcel(x: number, y: number | null): void {
    this.priorityParcelKey = x != null && y != null ? `${x},${y}` : null
  }

  private findSlotForParcel(x: number, y: number): SceneWorkerSlot | null {
    const key = `${x},${y}`
    for (const slot of this.slots.values()) {
      const base = slot.scene.baseParcel.trim()
      if (base === key || slot.scene.parcels.some((p) => p.trim() === key)) {
        return slot
      }
    }
    return null
  }

  private countMode(mode: ResidentMode): number {
    let n = 0
    for (const slot of this.slots.values()) {
      if (slot.residentMode === mode) n++
    }
    return n
  }

  /**
   * If a live secondary/tertiary covers parcel (x,y), detach it for primary handoff.
   * Tertiary promotes fine — detach unpauses scripts; World becomes FocusOwner.
   */
  takeForPromote(x: number, y: number): PromoteHandoffPayload | null {
    const key = `${x},${y}`
    for (const [entityId, slot] of this.slots) {
      const parcels = slot.scene.parcels
      const base = slot.scene.baseParcel.trim()
      if (base === key || parcels.some((p) => p.trim() === key)) {
        const fromMode = slot.residentMode
        this.slots.delete(entityId)
        this.stickyIds.delete(entityId)
        this.emitLiveIds()
        const physIds = [...slot.registeredPhysicsEntities()]
        const system = slot.detachForPromote()
        console.info(
          `[multi-scene] handoff ${fromMode} → primary “${slot.scene.title}” base=${base} parcel=${key}`
        )
        return {
          entityId,
          scene: slot.scene,
          system,
          physIds
        }
      }
    }
    return null
  }

  /**
   * Keep outgoing primary **resident** as sticky — never unload into void.
   *
   * Mode policy (NOT parcel-count):
   * - Promote always steps onto an adjacent/under-feet scene → prior primary is still
   *   inside the live ring of the new primary → start **secondary** (scripts on, mute).
   * - Size gate ({@link SECONDARY_LIVE_AUTO_MAX_PARCELS}) is only for **cold auto-boot**
   *   of distant neighbors as live workers — never for sticky demote of the scene you left.
   * - Tertiary only later: leave 16m live ring (reconcile) or secondary-cap pressure
   *   (prefer demoting non-sticky first; sticky last).
   *
   * @param newPrimaryBaseParcel — **incoming** primary SW (required on promote handoff).
   *   Demoted meshes must be offset vs the NEW host origin, not the old one.
   *
   * Returns phys entity ids that used primary (native) ids — World must invalidate them.
   */
  async adoptDemotedPrimary(
    system: SceneScriptSystem,
    scene: ResolvedScene,
    newPrimaryBaseParcel?: string
  ): Promise<{ entityId: string; primaryPhysIds: number[] } | null> {
    if (this.disposed || !this.cache || !this.host || !this.arbiter || !this.poseProvider) {
      // Continuity P0: never dispose demoted primary if multi-scene is mid-teardown.
      console.error(
        `[multi-scene] demote refused (unbound) “${scene.title}” — caller must keep system resident`
      )
      return null
    }
    if (!scene.entityId || !scene.mainEntry) {
      // Missing identity — still keep meshes if any (do NOT dispose into void).
      console.error(
        `[multi-scene] demote refused (no entityId/main) “${scene.title}” — keeping system (no dispose)`
      )
      try {
        const root = system.getEntityStore()?.root
        if (root) {
          root.visible = true
          root.name = `secondary-orphan:noid`
          if (this.host.scene && root.parent !== this.host.scene) {
            this.host.scene.add(root)
          }
        }
      } catch {
        /* ignore */
      }
      return null
    }

    const id = scene.entityId
    const parcelCount = scene.parcels?.length || 1
    // Sticky demote is always "still next to you" on parcel walk — secondary scripts.
    // Cap pressure may demote secondary→tertiary later; leave-ring does too.
    const initialMode: ResidentMode = 'secondary'

    // Host origin is the NEW primary SW after promote — always prefer explicit base.
    const primaryBase =
      (newPrimaryBaseParcel ?? this.primaryScene?.baseParcel ?? scene.baseParcel).trim()

    // Already have this entity as resident — keep graph, drop duplicate system.
    if (this.slots.has(id)) {
      const existing = this.slots.get(id)!
      console.info(
        `[multi-scene] demote skip — already resident “${scene.title}” mode=${existing.residentMode}`
      )
      if (existing.system !== system) {
        // Keep the graph that is already slotted; orphan the unused system root if different.
        try {
          const orphanRoot = system.getEntityStore()?.root
          if (orphanRoot && orphanRoot !== existing.system.getEntityStore()?.root) {
            orphanRoot.visible = true
            orphanRoot.name = `secondary-orphan-dup:${id.slice(0, 12)}`
            if (this.host.scene && orphanRoot.parent !== this.host.scene) {
              this.host.scene.add(orphanRoot)
            }
          }
        } catch {
          /* ignore */
        }
        // Never dispose demoted primary system on identity collision — void risk.
      }
      this.stickyIds.add(id)
      existing.retargetPrimaryBase(primaryBase)
      // Always bring sticky prior primary back to secondary while still adjacent.
      if (existing.residentMode === 'tertiary') {
        existing.setResidentMode('secondary')
      }
      this.emitLiveIds()
      return { entityId: id, primaryPhysIds: [] }
    }

    // Make room for a secondary sticky — demote other non-sticky first (never size-force tertiary).
    this.ensureCapacityForNew(initialMode)

    // Collect native primary phys ids before remapping under offset.
    let primaryPhysIds: number[] = []
    try {
      primaryPhysIds = system.getAllPhysicsColliderDescs().map((d) => d.entity)
    } catch {
      primaryPhysIds = []
    }

    const slotIndex = this.nextSlotIndex++
    const slot = new SceneWorkerSlot({
      id,
      kind: 'secondary',
      scene,
      cache: this.cache,
      host: this.host,
      performanceTier: this.tier,
      arbiter: this.arbiter,
      poseProvider: this.poseProvider,
      physOffset: secondaryPhysOffset(slotIndex),
      primaryBaseParcel: primaryBase,
      existingSystem: system,
      initialMode
    })
    try {
      await slot.start()
    } catch (err) {
      // Continuity P0: slot start failed — still keep system + meshes on host.
      console.error(
        `[multi-scene] demote slot.start failed “${scene.title}” — keeping orphan resident`,
        err
      )
      try {
        system.setFocusPolicy('secondary')
        const root = system.getEntityStore()?.root
        if (root) {
          root.visible = true
          root.name = `secondary-orphan:${id.slice(0, 16)}`
          if (this.host.scene && root.parent !== this.host.scene) {
            this.host.scene.add(root)
          }
        }
      } catch {
        /* ignore */
      }
      return null
    }
    // Always retain slot even if manager disposed mid-await — never drop demoted graph.
    this.slots.set(id, slot)
    this.stickyIds.add(id)
    this.emitLiveIds()
    console.info(
      `[multi-scene] demoted “${scene.title}” → sticky secondary parcels=${parcelCount} ` +
        `offset vs primary=${primaryBase} (still in live ring — size does not force tertiary)`
    )
    return { entityId: id, primaryPhysIds }
  }

  /**
   * Force-boot a secondary for parcel if missing.
   * Prefer not calling this from promote — cold dual-boot kills CBD.
   * Under-feet priority always allowed (any parcel count) so handoff can demote prior primary.
   */
  async ensureSecondaryForParcel(
    x: number,
    y: number,
    timeoutMs = 28_000
  ): Promise<boolean> {
    if (this.disposed || !this.cache || !this.host || !this.arbiter || !this.poseProvider) {
      return false
    }
    const existing = this.findSlotForParcel(x, y)
    if (existing) {
      // Promote tertiary→secondary scripts only (no GLB reload).
      if (existing.residentMode === 'tertiary') {
        existing.setResidentMode('secondary')
        this.balanceModes()
      }
      return true
    }

    const key = `${x},${y}`
    this.booting.add(key)
    try {
      const scene = await resolveSceneFromRoute({
        kind: 'coords',
        x,
        y,
        segment: key
      })
      if (this.disposed || !scene?.mainEntry || !scene.entityId) return false
      if (this.primaryScene?.entityId === scene.entityId) return false
      if (this.slots.has(scene.entityId)) {
        const slot = this.slots.get(scene.entityId)!
        if (slot.residentMode === 'tertiary') {
          slot.setResidentMode('secondary')
          this.balanceModes()
        }
        return true
      }

      // Under-feet promote target: always allow force-boot (any parcel count).
      const parcelCount = scene.parcels?.length ?? 0
      const isPriority =
        this.priorityParcelKey === key ||
        scene.baseParcel.trim() === this.priorityParcelKey ||
        scene.parcels.some((p) => p.trim() === this.priorityParcelKey)
      if (parcelCount > SECONDARY_LIVE_AUTO_MAX_PARCELS && !isPriority) {
        console.info(
          `[multi-scene] refuse force-boot “${scene.title}” parcels=${parcelCount} ` +
            `(not under-feet priority — composite only)`
        )
        return false
      }

      this.ensureCapacityForNew('secondary')

      const slotIndex = this.nextSlotIndex++
      const slot = new SceneWorkerSlot({
        id: scene.entityId,
        kind: 'secondary',
        scene,
        cache: this.cache,
        host: this.host,
        performanceTier: this.tier,
        arbiter: this.arbiter,
        poseProvider: this.poseProvider,
        physOffset: secondaryPhysOffset(slotIndex),
        primaryBaseParcel: this.primaryScene?.baseParcel,
        initialMode: 'secondary'
      })
      try {
        const boot = slot.start()
        const timed = await Promise.race([
          boot.then(() => true),
          new Promise<boolean>((resolve) => window.setTimeout(() => resolve(false), timeoutMs))
        ])
        if (!timed || this.disposed) {
          // Boot timed out — dispose incomplete slot only (never the prior primary).
          slot.dispose()
          return false
        }
        this.slots.set(scene.entityId, slot)
        this.emitLiveIds()
        console.info(
          `[multi-scene] force-boot secondary for promote “${scene.title}” @ ${key}`
        )
        return true
      } finally {
        // Always put primary content map back — secondary boot must not starve primary resolve.
        if (this.primaryScene && this.cache) this.cache.setScene(this.primaryScene)
      }
    } catch (err) {
      console.warn(`[multi-scene] ensureSecondaryForParcel failed ${key}`, err)
      if (this.primaryScene && this.cache) this.cache.setScene(this.primaryScene)
      return false
    } finally {
      this.booting.delete(key)
    }
  }

  /**
   * Ensure room for one new resident of the given mode.
   * Prefer demote secondary→tertiary over dispose; only dispose non-sticky tertiary over cap.
   */
  private ensureCapacityForNew(mode: ResidentMode): void {
    if (mode === 'secondary') {
      // Free a secondary script slot first (demote to tertiary, meshes stay).
      while (this.countMode('secondary') >= this.maxSecondarySlots()) {
        if (!this.demoteOneSecondaryToTertiary({ preferNonSticky: true })) break
      }
    }
    // Total graph budget.
    while (this.slots.size >= this.maxTotalSlots()) {
      if (this.disposeOneTertiary({ preferNonSticky: true })) continue
      // Still full — demote a secondary then dispose tertiary.
      if (this.demoteOneSecondaryToTertiary({ preferNonSticky: true })) {
        if (this.disposeOneTertiary({ preferNonSticky: true })) continue
      }
      // Last resort: dispose any non-sticky (never sticky).
      if (this.disposeOneAnyNonSticky()) continue
      break
    }
    // Tertiary-only pressure after demotes.
    while (this.countMode('tertiary') > this.maxTertiarySlots()) {
      if (!this.disposeOneTertiary({ preferNonSticky: true })) break
    }
  }

  /** Demote one secondary-mode slot → tertiary (scripts off). Sticky last. */
  private demoteOneSecondaryToTertiary(opts: { preferNonSticky: boolean }): boolean {
    const entries = [...this.slots.entries()].filter(([, s]) => s.residentMode === 'secondary')
    if (!entries.length) return false
    entries.sort(([aId], [bId]) => {
      const as = this.stickyIds.has(aId) ? 1 : 0
      const bs = this.stickyIds.has(bId) ? 1 : 0
      if (opts.preferNonSticky && as !== bs) return as - bs
      return 0
    })
    // Never demote under-feet priority if sticky-protected? Priority can demote if not sticky.
    const pri = this.priorityParcelKey
    for (const [id, slot] of entries) {
      if (this.stickyIds.has(id) && opts.preferNonSticky) continue
      if (
        pri &&
        (slot.scene.baseParcel.trim() === pri ||
          slot.scene.parcels.some((p) => p.trim() === pri))
      ) {
        continue // keep under-feet secondary for promote handoff
      }
      slot.setResidentMode('tertiary')
      console.info(
        `[multi-scene] demote secondary→tertiary “${slot.scene.title}” (scripts off, meshes stay)`
      )
      return true
    }
    // Fallback: demote non-priority sticky only if nothing else (rare).
    for (const [, slot] of entries) {
      if (
        pri &&
        (slot.scene.baseParcel.trim() === pri ||
          slot.scene.parcels.some((p) => p.trim() === pri))
      ) {
        continue
      }
      slot.setResidentMode('tertiary')
      console.info(
        `[multi-scene] demote secondary→tertiary “${slot.scene.title}” (capacity)`
      )
      return true
    }
    return false
  }

  /** Dispose one tertiary non-sticky (or any tertiary if allowed). Returns true if disposed. */
  private disposeOneTertiary(opts: { preferNonSticky: boolean }): boolean {
    const entries = [...this.slots.entries()].filter(([, s]) => s.residentMode === 'tertiary')
    if (!entries.length) return false
    entries.sort(([aId], [bId]) => {
      const as = this.stickyIds.has(aId) ? 1 : 0
      const bs = this.stickyIds.has(bId) ? 1 : 0
      if (opts.preferNonSticky && as !== bs) return as - bs
      return 0
    })
    for (const [id, slot] of entries) {
      if (this.stickyIds.has(id)) continue // never dispose sticky
      slot.dispose()
      this.slots.delete(id)
      console.info(
        `[multi-scene] tertiary dispose “${slot.scene.title}” ${id.slice(0, 12)}… (cap)`
      )
      this.emitLiveIds()
      return true
    }
    return false
  }

  private disposeOneAnyNonSticky(): boolean {
    for (const [id, slot] of this.slots) {
      if (this.stickyIds.has(id)) continue
      slot.dispose()
      this.slots.delete(id)
      console.info(`[multi-scene] resident dispose ${id.slice(0, 12)}… (cap last-resort)`)
      this.emitLiveIds()
      return true
    }
    return false
  }

  /**
   * After promoting a tertiary→secondary, push excess secondaries back to tertiary.
   */
  private balanceModes(): void {
    while (this.countMode('secondary') > this.maxSecondarySlots()) {
      if (!this.demoteOneSecondaryToTertiary({ preferNonSticky: true })) break
    }
    while (this.countMode('tertiary') > this.maxTertiarySlots()) {
      if (!this.disposeOneTertiary({ preferNonSticky: true })) break
    }
  }

  private requestCoversParcel(c: SecondaryLiveRequest, key: string | null): boolean {
    if (!key) return false
    if (c.base.trim() === key) return true
    if (`${c.resolveX},${c.resolveY}` === key) return true
    if (c.parcels?.some((p) => p.trim() === key)) return true
    return false
  }

  reconcile(candidates: SecondaryLiveRequest[]): void {
    if (this.disposed || !this.cache || !this.host || !this.arbiter || !this.poseProvider) return
    const cap = this.maxSecondarySlots()
    const now = performance.now()
    // Faster when under-feet priority is pinned (promote path needs quick boot).
    const minGap = this.priorityParcelKey ? 200 : 800
    if (now - this.lastReconcileAt < minGap) return
    this.lastReconcileAt = now

    // distM is **scene-to-scene** footprint edge distance (not player).
    // Nested hole scenes (Spring in plaza) are ~0m → always in range when primary is plaza.
    const liveProxM = secondaryLiveRadiusM()
    const pri = this.priorityParcelKey
    const coversPri = (c: SecondaryLiveRequest): boolean => this.requestCoversParcel(c, pri)

    const eligible = candidates.filter((c) => liveProxM > 0 && c.distM <= liveProxM)
    const priorityReq = pri ? eligible.find((c) => coversPri(c)) : undefined

    const sorted = [...eligible].sort((a, b) => {
      // Under-feet parcel first so promote handoff is ready without /goto rebuild.
      const ap = coversPri(a) ? 0 : 1
      const bp = coversPri(b) ? 0 : 1
      if (ap !== bp) return ap - bp
      // Closer scene footprints first; then smaller over mega-estates.
      if (a.distM !== b.distM) return a.distM - b.distM
      return (a.parcelCount ?? 1) - (b.parcelCount ?? 1)
    })

    // Always reserve a slot for under-feet priority even if it was outside top-N noise.
    const inRange: SecondaryLiveRequest[] = []
    if (priorityReq) inRange.push(priorityReq)
    for (const c of sorted) {
      if (inRange.some((x) => x.entityId === c.entityId)) continue
      if (inRange.length >= Math.max(cap, 0)) break
      inRange.push(c)
    }

    const wantSecondary = new Set(inRange.map((c) => c.entityId))
    // Sticky demoted prior primary: secondary while still in live ring (or unknown dist —
    // just demoted on parcel walk = adjacent). Size / top-N noise must NOT drop them.
    for (const id of this.stickyIds) {
      const cand = candidates.find((c) => c.entityId === id)
      if (!cand || cand.distM <= liveProxM) {
        wantSecondary.add(id)
      }
    }

    // Mode transitions for existing residents — never dispose on leave ring.
    for (const [id, slot] of this.slots) {
      const isPri =
        !!pri &&
        (slot.scene.baseParcel.trim() === pri ||
          slot.scene.parcels.some((p) => p.trim() === pri))
      if (wantSecondary.has(id) || isPri) {
        if (slot.residentMode === 'tertiary') {
          // Re-enter live ring: scripts only, no GLB reload.
          slot.setResidentMode('secondary')
        }
      } else {
        // Left live ring — tertiary (scripts off), keep meshes.
        if (slot.residentMode === 'secondary') {
          slot.setResidentMode('tertiary')
          console.info(
            `[multi-scene] leave ring → tertiary “${slot.scene.title}” (scripts off, meshes stay)`
          )
        }
      }
    }

    // Cap secondary scripts after promotes.
    this.balanceModes()
    this.emitLiveIds()

    // Serial boot — one full secondary worker at a time.
    if (this.booting.size >= SECONDARY_LIVE_BOOT_CONCURRENCY) return

    // Boot missing live candidates. Skip plaza-scale auto-boots unless under-feet.
    const bootOrder = [...inRange]
    for (const req of bootOrder) {
      if (this.slots.has(req.entityId) || this.booting.has(req.entityId)) continue
      const parcels = req.parcelCount ?? 1
      if (parcels > SECONDARY_LIVE_AUTO_MAX_PARCELS && !coversPri(req)) {
        continue
      }
      // Need a secondary script slot.
      if (this.countMode('secondary') + this.booting.size >= cap) {
        this.demoteOneSecondaryToTertiary({ preferNonSticky: true })
        if (this.countMode('secondary') + this.booting.size >= cap) break
      }
      this.ensureCapacityForNew('secondary')
      void this.bootOne(req, coversPri(req) ? pri : null)
      break // only start one per reconcile
    }
  }

  private async bootOne(req: SecondaryLiveRequest, preferParcelKey: string | null = null): Promise<void> {
    if (this.disposed || !this.cache || !this.host || !this.arbiter || !this.poseProvider) return
    this.booting.add(req.entityId)
    try {
      // Resolve via under-feet parcel when pinned (base alone can miss multi-parcel cells).
      let rx = req.resolveX
      let ry = req.resolveY
      if (preferParcelKey) {
        try {
          const [px, py] = preferParcelKey.split(',').map(Number)
          if (Number.isFinite(px) && Number.isFinite(py)) {
            rx = px
            ry = py
          }
        } catch {
          /* keep base */
        }
      }
      const scene = await resolveSceneFromRoute({
        kind: 'coords',
        x: rx,
        y: ry,
        segment: `${rx},${ry}`
      })
      if (this.disposed || !scene?.mainEntry || !scene.entityId) return
      if (this.primaryScene?.entityId === scene.entityId) return
      // Already resident (maybe tertiary) — scripts on only.
      const existing =
        this.slots.get(req.entityId) ?? this.slots.get(scene.entityId) ?? null
      if (existing) {
        if (existing.residentMode === 'tertiary') {
          existing.setResidentMode('secondary')
          this.balanceModes()
          console.info(
            `[multi-scene] tertiary→secondary “${existing.scene.title}” (scripts on, no GLB reload)`
          )
        }
        return
      }

      const slotIndex = this.nextSlotIndex++
      const slotId = scene.entityId
      const slot = new SceneWorkerSlot({
        id: slotId,
        kind: 'secondary',
        scene,
        cache: this.cache,
        host: this.host,
        performanceTier: this.tier,
        arbiter: this.arbiter,
        poseProvider: this.poseProvider,
        physOffset: secondaryPhysOffset(slotIndex),
        primaryBaseParcel: this.primaryScene?.baseParcel,
        initialMode: 'secondary'
      })
      try {
        await slot.start()
        if (this.disposed) {
          slot.dispose()
          return
        }
        this.slots.set(slotId, slot)
        this.balanceModes()
        this.emitLiveIds()
        console.info(
          `[multi-scene] secondary live “${req.title}” base=${req.base} ` +
            `sceneDist≈${req.distM.toFixed(0)}m parcels=${req.parcelCount ?? '?'} ` +
            (preferParcelKey ? `priority=${preferParcelKey}` : '')
        )
      } finally {
        if (this.primaryScene && this.cache) this.cache.setScene(this.primaryScene)
      }
    } catch (err) {
      console.warn(`[multi-scene] secondary boot failed “${req.title}”`, err)
      if (this.primaryScene && this.cache) this.cache.setScene(this.primaryScene)
    } finally {
      this.booting.delete(req.entityId)
    }
  }

  private emitLiveIds(): void {
    this.onLiveIdsChange?.(this.liveEntityIds())
  }

  tickSync(player: EntityPose, camera: EntityPose): void {
    const interval = secondaryTickIntervalMs(this.tier)
    for (const slot of this.slots.values()) {
      // Tertiary tickSync is a no-op (scripts off).
      slot.tickSync(player, camera, interval)
    }
  }

  /**
   * During post-promote settle (new boots paused), still advance **sticky demoted**
   * residents so the world never goes void. Tertiary sticky no-ops cheaply.
   */
  tickStickySync(player: EntityPose, camera: EntityPose): void {
    const interval = secondaryTickIntervalMs(this.tier)
    for (const [id, slot] of this.slots) {
      if (!this.stickyIds.has(id)) continue
      slot.tickSync(player, camera, interval)
    }
  }

  async tickAsync(): Promise<PhysicsColliderDesc[]> {
    if (!this.cache) return []
    const descs: PhysicsColliderDesc[] = []
    for (const slot of this.slots.values()) {
      descs.push(...(await slot.tickAsync(this.primaryScene, this.cache)))
    }
    return descs
  }

  /** Sticky-only async (settle window) — colliders for demoted residents. */
  async tickStickyAsync(): Promise<PhysicsColliderDesc[]> {
    if (!this.cache) return []
    const descs: PhysicsColliderDesc[] = []
    for (const [id, slot] of this.slots) {
      if (!this.stickyIds.has(id)) continue
      descs.push(...(await slot.tickAsync(this.primaryScene, this.cache)))
    }
    return descs
  }

  allRegisteredPhysIds(): number[] {
    const out: number[] = []
    for (const slot of this.slots.values()) {
      out.push(...slot.registeredPhysicsEntities())
    }
    return out
  }

  dispose(): void {
    this.disposed = true
    for (const slot of this.slots.values()) slot.dispose()
    this.slots.clear()
    this.stickyIds.clear()
    this.booting.clear()
    this.emitLiveIds()
  }
}
