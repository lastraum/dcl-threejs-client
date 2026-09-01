import type { EntityPose } from '../../bridge/ReservedEntitiesSync'
import type { AssetCache } from '../../rendering/AssetCache'
import type { SceneHost } from '../../rendering/SceneHost'
import type { PhysicsColliderDesc } from '../../physics/PhysXWorld'
import type { PerformanceTier, RealmResponse, UserDataResponse } from '../../shim/types'
import type { SceneScriptSystem } from '../../core/systems/SceneScriptSystem'
import { resolveSceneFromRoute } from '../content/resolveScene'
import type { ResolvedScene } from '../content/types'
import {
  aoiGlbShellsOnly,
  SECONDARY_LIVE_BOOT_CONCURRENCY,
  secondaryLiveCap,
  secondaryLiveEnterRadiusM,
  secondaryLiveKeepRadiusM,
  secondaryTickIntervalMs,
  tertiaryResidentCap,
  LIVE_SCENE_PHYS_RADIUS_M
} from './caps'
import type { PrivilegedIntentArbiter } from './PrivilegedIntentArbiter'
import { lastFrameOverBudget } from '../../rendering/mainThreadYield'
import { secondaryPhysOffset } from './physOffsets'
import { SceneWorkerSlot, type ResidentMode } from './SceneWorkerSlot'
import type { SecondaryLiveRequest } from './types'

export type PromoteHandoffPayload = {
  entityId: string
  scene: ResolvedScene
  system: SceneScriptSystem
  /** Phys ids registered under secondary offset — rekey back to native (no recook). */
  physIds: number[]
  /** Offset applied to native ecs phys ids while resident. */
  physOffset: number
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
  /** In-flight kickHydrate pumps — avoid idle-callback starve + duplicate pumps. */
  private readonly hydratePumps = new Set<string>()
  private disposed = false
  private tier: PerformanceTier = 'high'
  private primaryScene: ResolvedScene | null = null
  private cache: AssetCache | null = null
  private host: SceneHost | null = null
  private arbiter: PrivilegedIntentArbiter | null = null
  private poseProvider: (() => { player: EntityPose; camera: EntityPose }) | null = null
  private getUserData: (() => Promise<UserDataResponse>) | null = null
  private getRealm: (() => Promise<RealmResponse>) | null = null
  private onLiveIdsChange: ((ids: ReadonlySet<string>) => void) | null = null
  /** Full secondary graph meshes ready — AOI can hide composite shells. */
  private onLiveGraphReady: ((entityId: string) => void) | null = null
  private lastReconcileAt = 0
  private nextSlotIndex = 0
  /** SceneLoop.send owns play-frame; tickSync / tickStickySync must not call tickPlayFrame. */
  private playFrameOwnedExternally = false
  /**
   * Parcel under feet (absolute) — always prefer a covering candidate for live secondary
   * so walk-on promote can hand off without a cold /goto loading screen.
   */
  private priorityParcelKey: string | null = null
  /**
   * Catalyst/AOI footprints by entity id. `ResolvedScene.parcels` can miss
   * non-base cells; occupancy must use the same pointers AOI ranked.
   */
  private readonly footprints = new Map<string, Set<string>>()
  /** Last player→footprint meters from AOI (updated even when boot reconcile is throttled). */
  private readonly lastDistM = new Map<string, number>()
  /** Jog: only boot the parcel under feet (first snappy walk = no extra isolates). */
  private locomoting = false
  /** Loading overlay — skip reconcile throttle so live-guest GLBs attach before Jump In. */
  private loadBoot = false
  /** Last reconcile boot list size (loading-screen progress). */
  private lastBootTarget = 0
  /** Last boot-list titles (loading overlay / `[aoi] live-guest load` log). */
  private lastBootTitles: string[] = []

  bind(opts: {
    primaryScene: ResolvedScene
    cache: AssetCache
    host: SceneHost
    tier: PerformanceTier
    arbiter: PrivilegedIntentArbiter
    poseProvider: () => { player: EntityPose; camera: EntityPose }
    getUserData?: () => Promise<UserDataResponse>
    getRealm?: () => Promise<RealmResponse>
    onLiveIdsChange?: (ids: ReadonlySet<string>) => void
    onLiveGraphReady?: (entityId: string) => void
  }): void {
    this.primaryScene = opts.primaryScene
    this.cache = opts.cache
    this.host = opts.host
    this.tier = opts.tier
    this.arbiter = opts.arbiter
    this.poseProvider = opts.poseProvider
    this.getUserData = opts.getUserData ?? null
    this.getRealm = opts.getRealm ?? null
    this.onLiveIdsChange = opts.onLiveIdsChange ?? null
    this.onLiveGraphReady = opts.onLiveGraphReady ?? null
  }

  private notifyGraphReady(entityId: string, slot: SceneWorkerSlot): void {
    const meshes = slot.system.countGpuVisuals()
    if (meshes > 0) this.onLiveGraphReady?.(entityId)
  }

  setPrimaryScene(scene: ResolvedScene): void {
    this.primaryScene = scene
    // Every secondary was authored relative to its own SW; host origin is now
    // the new primary SW — re-apply (neighbor − primary) offsets or demoted
    // content piles on the new primary (rogue GLBs).
    const base = scene.baseParcel
    for (const slot of this.slots.values()) {
      slot.retargetPrimaryBase(base)
      // Cheap recapture from existing collider extract (NO syncCollisionForce — that
      // full plaza walk every handoff was the 3fps death spiral).
      try {
        slot.captureRemappedColliders()
      } catch {
        /* optional during teardown */
      }
    }
  }

  setTier(tier: PerformanceTier): void {
    this.tier = tier
  }

  /**
   * When true, SceneLoop.send owns play-frame. {@link tickSync} / {@link tickStickySync}
   * still refresh reserved poses but never call tickPlayFrame.
   */
  setPlayFrameOwnedExternally(owned: boolean): void {
    this.playFrameOwnedExternally = owned
    for (const slot of this.slots.values()) slot.setPlayFrameOwnedExternally(owned)
  }

  /**
   * Running secondary-mode slots for SceneLoop.reconcileLiveGuests.
   * Tertiary is not a guest.
   */
  listSecondaryModeSystems(): Array<{
    id: string
    getSystem: () => SceneScriptSystem
    distM: number
  }> {
    const out: Array<{ id: string; getSystem: () => SceneScriptSystem; distM: number }> = []
    for (const [entityId, slot] of this.slots) {
      if (slot.residentMode !== 'secondary') continue
      const dist = this.lastDistM.get(entityId)
      out.push({
        id: `secondary:${entityId}`,
        getSystem: () => slot.system,
        distM: Number.isFinite(dist) ? (dist as number) : Number.POSITIVE_INFINITY
      })
    }
    return out
  }

  hasResidentSlots(): boolean {
    return this.slots.size > 0
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

  /**
   * Scene graphs that should advance host Animator/Tween this frame.
   * Live **secondary** only — tertiary keeps mixers sleeping by design.
   */
  getSecondaryMotionSystems(): SceneScriptSystem[] {
    const out: SceneScriptSystem[] = []
    for (const slot of this.slots.values()) {
      if (slot.residentMode !== 'secondary') continue
      out.push(slot.system)
    }
    return out
  }

  /** Every resident graph (live secondary + tertiary sticky) — UI hide/release. */
  allResidentSystems(): SceneScriptSystem[] {
    const out: SceneScriptSystem[] = []
    for (const slot of this.slots.values()) out.push(slot.system)
    return out
  }

  motionSystemForGuestId(guestId: string): SceneScriptSystem | null {
    return this.slotForGuestId(guestId)?.system ?? null
  }

  sceneForGuestId(guestId: string): ResolvedScene | null {
    return this.slotForGuestId(guestId)?.scene ?? null
  }

  setFocusSendBinary(
    guestId: string,
    sendBinary: Parameters<SceneWorkerSlot['setFocusSendBinary']>[0]
  ): void {
    this.slotForGuestId(guestId)?.setFocusSendBinary(sendBinary)
  }

  private slotForGuestId(guestId: string): SceneWorkerSlot | null {
    if (!guestId.startsWith('secondary:')) return null
    const slot = this.slots.get(guestId.slice('secondary:'.length))
    if (!slot || slot.residentMode !== 'secondary') return null
    return slot
  }

  private rememberFootprint(entityId: string, keys: readonly string[] | undefined): void {
    if (!entityId) return
    let set = this.footprints.get(entityId)
    if (!set) {
      set = new Set()
      this.footprints.set(entityId, set)
    }
    if (!keys) return
    for (const k of keys) {
      const t = k.trim()
      if (t) set.add(t)
    }
  }

  private slotCoversParcel(slot: SceneWorkerSlot, key: string): boolean {
    if (slot.scene.baseParcel.trim() === key) return true
    if (slot.scene.parcels.some((p) => p.trim() === key)) return true
    return this.footprints.get(slot.id)?.has(key) === true
  }

  /**
   * Absolute parcel keys for every resident graph (secondary + tertiary sticky).
   * AOI must skip empty-land ground under these — otherwise demoted CBD becomes red void.
   */
  residentParcelKeys(): string[] {
    const out: string[] = []
    const seen = new Set<string>()
    for (const slot of this.slots.values()) {
      for (const p of slot.scene.parcels ?? []) {
        const k = p.trim()
        if (!k || seen.has(k)) continue
        seen.add(k)
        out.push(k)
      }
      const base = slot.scene.baseParcel?.trim()
      if (base && !seen.has(base)) {
        seen.add(base)
        out.push(base)
      }
      const extra = this.footprints.get(slot.id)
      if (extra) {
        for (const k of extra) {
          if (!k || seen.has(k)) continue
          seen.add(k)
          out.push(k)
        }
      }
    }
    return out
  }

  /**
   * After promote handoff: put every resident on tertiary (scripts off) so only
   * the new primary runs full scripts during settle. Meshes stay.
   */
  forceAllResidentsTertiary(reason: string): void {
    for (const slot of this.slots.values()) {
      if (slot.residentMode === 'secondary') {
        slot.setResidentMode('tertiary')
      }
    }
    console.info(
      `[multi-scene] force all residents tertiary (${reason}) slots=${this.slots.size}`
    )
  }

  /** Settle-end: scripts back on for sticky residents so SceneLoop guests return. */
  restoreStickySecondaries(): void {
    for (const [entityId, slot] of this.slots) {
      if (!this.stickyIds.has(entityId) || slot.residentMode !== 'tertiary' || !slot.isRunning) {
        continue
      }
      slot.setResidentMode('secondary')
    }
  }

  /**
   * After demote/retarget: force every resident pose root visible.
   * Roots stay on poseRoot — never reparent onto host.scene.
   */
  ensureResidentsVisible(): void {
    for (const slot of this.slots.values()) {
      try {
        const root = slot.system.getEntityStore()?.root
        if (!root) continue
        root.visible = true
        root.updateMatrixWorld(true)
      } catch {
        /* ignore */
      }
    }
  }

  /**
   * All sticky/live remapped colliders for immediate PhysX sync after demote
   * (must land before World invalidates native primary entity ids).
   */
  collectAllCachedColliders(): PhysicsColliderDesc[] {
    const out: PhysicsColliderDesc[] = []
    for (const slot of this.slots.values()) {
      out.push(...slot.getCachedRemappedColliders())
    }
    return out
  }

  collectCachedCollidersFor(entityId: string): PhysicsColliderDesc[] {
    const slot = this.slots.get(entityId)
    if (!slot) return []
    return [...slot.getCachedRemappedColliders()]
  }

  recaptureColliders(entityId: string): PhysicsColliderDesc[] {
    const slot = this.slots.get(entityId)
    if (!slot) return []
    try {
      return slot.captureRemappedColliders()
    } catch {
      return [...slot.getCachedRemappedColliders()]
    }
  }

  /** After World pushes sticky colliders once — stop re-streaming them every async frame. */
  markAllCollidersSynced(): void {
    for (const slot of this.slots.values()) {
      slot.markCollidersSynced()
    }
  }

  /** Continuity assert after demote — mesh count + root pose for logs. */
  assertResidentVisible(entityId: string): {
    ok: boolean
    meshCount: number
    rootPos: { x: number; y: number; z: number } | null
    parented: boolean
  } {
    const slot = this.slots.get(entityId)
    if (!slot) return { ok: false, meshCount: 0, rootPos: null, parented: false }
    const root = slot.system.getEntityStore()?.root
    if (!root) return { ok: false, meshCount: 0, rootPos: null, parented: false }
    const meshCount = slot.system.countGpuVisuals()
    const parented = !!root.parent
    root.visible = true
    return {
      ok: parented && root.visible && meshCount > 0,
      meshCount,
      rootPos: { x: root.position.x, y: root.position.y, z: root.position.z },
      parented
    }
  }

  hasSecondaryForParcel(x: number, y: number): boolean {
    return this.findSlotForParcel(x, y) !== null
  }

  /** SceneLoop guest id for the live secondary covering this parcel, or null. */
  liveGuestIdForParcel(x: number, y: number): string | null {
    const slot = this.findSlotForParcel(x, y)
    if (!slot || slot.residentMode !== 'secondary') return null
    return `secondary:${slot.id}`
  }

  /** Focus/LiveKit only after the first GPU mesh — empty hydrate must not swap rooms. */
  liveGuestGraphReady(guestId: string): boolean {
    const entityId = guestId.startsWith('secondary:') ? guestId.slice('secondary:'.length) : guestId
    const slot = this.slots.get(entityId)
    if (!slot || slot.residentMode !== 'secondary') return false
    return slot.system.countGpuVisuals() > 0
  }

  /** Prefer booting a live secondary that covers this absolute parcel (under feet). */
  setPriorityParcel(x: number, y: number | null): void {
    this.priorityParcelKey = x != null && y != null ? `${x},${y}` : null
  }

  setLocomoting(locomoting: boolean): void {
    this.locomoting = locomoting
  }

  /** Loading overlay: boot live guests without walk/throttle gates. */
  setLoadBoot(enabled: boolean): void {
    this.loadBoot = enabled
    if (enabled) this.lastReconcileAt = 0
  }

  /**
   * Loading-screen progress: live guests with at least one GPU mesh vs the
   * last boot target (capped occupied neighbors).
   */
  liveGuestLoadStats(): {
    ready: number
    target: number
    booting: number
    titles: string[]
  } {
    let ready = 0
    for (const slot of this.slots.values()) {
      if (slot.residentMode !== 'secondary') continue
      if (slot.system.countGpuVisuals() > 0) ready++
    }
    return {
      ready,
      target: this.lastBootTarget,
      booting: this.booting.size,
      titles: this.lastBootTitles
    }
  }

  private findSlotForParcel(x: number, y: number): SceneWorkerSlot | null {
    const key = `${x},${y}`
    for (const slot of this.slots.values()) {
      if (this.slotCoversParcel(slot, key)) return slot
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
      if (this.slotCoversParcel(slot, key)) {
        const fromMode = slot.residentMode
        this.slots.delete(entityId)
        this.stickyIds.delete(entityId)
        this.emitLiveIds()
        const physIds = [...slot.registeredPhysicsEntities()]
        const physOffset = slot.physOffset
        const system = slot.detachForPromote()
        console.info(
          `[multi-scene] handoff ${fromMode} → primary “${slot.scene.title}” base=${slot.scene.baseParcel} parcel=${key}`
        )
        return {
          entityId,
          scene: slot.scene,
          system,
          physIds,
          physOffset
        }
      }
    }
    return null
  }

  /** Phys offset for a resident entity id (sticky demote rekey). */
  physOffsetForEntityId(entityId: string): number | null {
    const slot = this.slots.get(entityId)
    return slot ? slot.physOffset : null
  }

  /**
   * Keep outgoing primary **resident** as sticky — never unload into void.
   *
   * Mode policy (NOT parcel-count — parcel size never gates secondary):
   * - Sticky demote of prior primary → **secondary** (scripts on, mute).
   * - Tertiary only later: leave 16m live ring or secondary-cap pressure
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
        }
      } catch {
        /* ignore */
      }
      return null
    }

    const id = scene.entityId
    const parcelCount = scene.parcels?.length || 1
    // Sticky demote is ALWAYS secondary (muted scripts, meshes stay).
    // Tertiary is only leave-ring / secondary-cap pressure — never parcel count.
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
          }
        } catch {
          /* ignore */
        }
        // Never dispose demoted primary system on identity collision — void risk.
      }
      this.stickyIds.add(id)
      existing.retargetPrimaryBase(primaryBase)
      // Stay tertiary until promote-settle ends. Flipping secondary here ran
      // scripts for one frame then forceAllResidentsTertiary turned them off.
      this.emitLiveIds()
      return { entityId: id, primaryPhysIds: [] }
    }

    // Make room for a secondary sticky — demote other non-sticky first (cap pressure only).
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
      getUserData: this.getUserData ?? undefined,
      getRealm: this.getRealm ?? undefined,
      physOffset: secondaryPhysOffset(slotIndex),
      primaryBaseParcel: primaryBase,
      existingSystem: system,
      initialMode
    })
    slot.setPlayFrameOwnedExternally(this.playFrameOwnedExternally)
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
    this.notifyGraphReady(id, slot)
    const assert = this.assertResidentVisible(id)
    console.info(
      `[multi-scene] demoted “${scene.title}” → sticky secondary parcels=${parcelCount} ` +
        `offset vs primary=${primaryBase} meshes=${assert.meshCount} ` +
        `rootPos=(${assert.rootPos?.x.toFixed(1) ?? '?'},${assert.rootPos?.z.toFixed(1) ?? '?'}) ` +
        `parented=${assert.parented} ok=${assert.ok}`
    )
    if (!assert.ok) {
      console.error(
        `[multi-scene] STICKY DEMOTO INTEGRITY FAIL “${scene.title}” — meshes may void; ` +
          `forcing root visible on host`
      )
      try {
        const root = system.getEntityStore()?.root
        if (root) root.visible = true
      } catch {
        /* ignore */
      }
    }
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
    if (aoiGlbShellsOnly()) return false
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
    // Exclusive boot: only one secondary full boot at a time (no CBD thrash chain).
    if (this.booting.size > 0 && !this.booting.has(key)) {
      // If under-feet priority is this parcel, wait for other boot to finish first.
      if (this.priorityParcelKey === key) {
        console.info(
          `[multi-scene] ensureSecondary wait — boot in flight, priority=${key}`
        )
      } else {
        console.info(
          `[multi-scene] ensureSecondary skip ${key} — exclusive boot busy ` +
            `(inFlight=${[...this.booting].join(',')})`
        )
        return false
      }
    }
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
      this.rememberFootprint(scene.entityId, [scene.baseParcel, ...scene.parcels, key])
      if (this.slots.has(scene.entityId)) {
        const slot = this.slots.get(scene.entityId)!
        if (slot.residentMode === 'tertiary') {
          slot.setResidentMode('secondary')
          this.balanceModes()
        }
        return true
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
        getUserData: this.getUserData ?? undefined,
        getRealm: this.getRealm ?? undefined,
        physOffset: secondaryPhysOffset(slotIndex),
        primaryBaseParcel: this.primaryScene?.baseParcel,
        initialMode: 'secondary'
      })
      slot.setPlayFrameOwnedExternally(this.playFrameOwnedExternally)
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
        this.notifyGraphReady(scene.entityId, slot)
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
      if (pri && this.slotCoversParcel(slot, pri)) {
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
      if (pri && this.slotCoversParcel(slot, pri)) {
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
    for (const c of candidates) {
      this.rememberFootprint(c.entityId, [
        c.base,
        `${c.resolveX},${c.resolveY}`,
        ...(c.parcels ?? [])
      ])
      if (Number.isFinite(c.distM)) this.lastDistM.set(c.entityId, c.distM)
    }
    // Single-primary + composite shells only — never boot live secondary workers.
    if (aoiGlbShellsOnly()) {
      if (candidates.length) {
        // One log per session would spam — silence unless debugging.
      }
      return
    }
    const cap = this.maxSecondarySlots()
    if (cap <= 0) return
    const now = performance.now()
    const minGap = this.loadBoot ? 0 : this.priorityParcelKey ? 200 : 800
    if (now - this.lastReconcileAt < minGap) return
    this.lastReconcileAt = now

    // distM = occupied-scene distance (empty/road excluded). Enter = Scene Distance.
    const enterM = secondaryLiveEnterRadiusM()
    const keepM = secondaryLiveKeepRadiusM()
    const pri = this.priorityParcelKey
    const coversPri = (c: SecondaryLiveRequest): boolean => this.requestCoversParcel(c, pri)

    // Candidates for boot / re-promote: player within enter radius (or under-feet priority).
    const bootEligible = candidates.filter(
      (c) => enterM > 0 && (c.distM <= enterM || coversPri(c))
    )
    const priorityReq = pri
      ? candidates.find((c) => coversPri(c)) ?? bootEligible.find((c) => coversPri(c))
      : undefined

    const sortedBoot = [...bootEligible].sort((a, b) => {
      const ap = coversPri(a) ? 0 : 1
      const bp = coversPri(b) ? 0 : 1
      if (ap !== bp) return ap - bp
      if (a.distM !== b.distM) return a.distM - b.distM
      return (b.parcelCount ?? 1) - (a.parcelCount ?? 1)
    })

    const bootList: SecondaryLiveRequest[] = []
    if (priorityReq && (priorityReq.distM <= enterM || coversPri(priorityReq))) {
      bootList.push(priorityReq)
    }
    for (const c of sortedBoot) {
      if (bootList.some((x) => x.entityId === c.entityId)) continue
      if (bootList.length >= Math.max(cap, 0)) break
      bootList.push(c)
    }
    this.lastBootTarget = bootList.length
    this.lastBootTitles = bootList.map((c) => c.title || c.base)

    const wantSecondary = new Set(bootList.map((c) => c.entityId))
    // Hysteresis: already-loaded (or sticky) stay secondary while player ≤ keepM.
    for (const [id, slot] of this.slots) {
      const cand = candidates.find((c) => c.entityId === id)
      const dist = cand?.distM
      if (dist != null && dist <= keepM) wantSecondary.add(id)
      // No candidate this frame (discover lag): keep sticky demoted in secondary.
      if (this.stickyIds.has(id) && (dist == null || dist <= keepM)) {
        wantSecondary.add(id)
      }
      // Under-feet always secondary while standing on footprint.
      if (pri && this.slotCoversParcel(slot, pri)) {
        wantSecondary.add(id)
      }
    }
    for (const id of this.stickyIds) {
      const cand = candidates.find((c) => c.entityId === id)
      if (!cand || cand.distM <= keepM) wantSecondary.add(id)
    }

    // Mode transitions — never dispose on leave keep radius.
    for (const [id, slot] of this.slots) {
      const isPri = !!pri && this.slotCoversParcel(slot, pri)
      if (wantSecondary.has(id) || isPri) {
        if (slot.residentMode === 'tertiary') {
          slot.setResidentMode('secondary')
        }
      } else {
        // Player > keepM — tertiary (scripts off), keep meshes.
        if (slot.residentMode === 'secondary') {
          slot.setResidentMode('tertiary')
          console.info(
            `[multi-scene] leave keep (${keepM}m) → tertiary “${slot.scene.title}” (scripts off, meshes stay)`
          )
        }
      }
    }

    // Cap secondary scripts after promotes.
    this.balanceModes()
    this.emitLiveIds()

    // Under-feet is sort priority only. Never exclusive — a 4-parcel neighbor
    // 14 m away must boot while standing on plaza (player→footprint, not parcel pin).
    const bootSlots = Math.max(0, SECONDARY_LIVE_BOOT_CONCURRENCY - this.booting.size)
    let started = 0
    for (const req of bootList) {
      if (started >= bootSlots) break
      if (this.slots.has(req.entityId) || this.booting.has(req.entityId)) continue
      if (req.distM > enterM && !coversPri(req)) continue
      // Dying rAF / jog: only boot the parcel under feet. Approaching BrandonManus
      // while Snow was hydrating stacked a third isolate on 7 FPS.
      if (!this.loadBoot && (lastFrameOverBudget(28) || this.locomoting) && !coversPri(req)) {
        continue
      }
      if (this.countMode('secondary') + this.booting.size >= cap) {
        this.demoteOneSecondaryToTertiary({ preferNonSticky: true })
        if (this.countMode('secondary') + this.booting.size >= cap) break
      }
      this.ensureCapacityForNew('secondary')
      console.info(
        `[multi-scene] boot “${req.title}” playerDist≈${req.distM.toFixed(0)}m ` +
          `enter=${enterM}m pri=${pri ?? '—'} parcels=${req.parcelCount ?? '?'}`
      )
      void this.bootOne(req, coversPri(req) ? pri : null)
      started++
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
      let scene = await resolveSceneFromRoute({
        kind: 'coords',
        x: rx,
        y: ry,
        segment: `${rx},${ry}`
      })
      // Under-feet parcel can miss the catalyst pointer index (125,104 empty;
      // covering scene is indexed at 125,103). Retry the deployment base.
      if (
        (!scene?.mainEntry || !scene.entityId) &&
        (rx !== req.resolveX || ry !== req.resolveY)
      ) {
        scene = await resolveSceneFromRoute({
          kind: 'coords',
          x: req.resolveX,
          y: req.resolveY,
          segment: `${req.resolveX},${req.resolveY}`
        })
      }
      if (this.disposed || !scene?.mainEntry || !scene.entityId) return
      if (this.primaryScene?.entityId === scene.entityId) return
      this.rememberFootprint(req.entityId, [req.base, ...(req.parcels ?? scene.parcels)])
      this.rememberFootprint(scene.entityId, [scene.baseParcel, ...scene.parcels, ...(req.parcels ?? [])])
      if (req.parcels?.length) {
        const merged = new Set(scene.parcels.map((p) => p.trim()).filter(Boolean))
        for (const p of req.parcels) {
          const t = p.trim()
          if (t) merged.add(t)
        }
        scene.parcels = [...merged]
      }
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
        getUserData: this.getUserData ?? undefined,
        getRealm: this.getRealm ?? undefined,
        physOffset: secondaryPhysOffset(slotIndex),
        primaryBaseParcel: this.primaryScene?.baseParcel,
        initialMode: 'secondary'
      })
      slot.setPlayFrameOwnedExternally(this.playFrameOwnedExternally)
      try {
        await slot.start()
        if (this.disposed) {
          slot.dispose()
          return
        }
        this.slots.set(slotId, slot)
        this.balanceModes()
        this.emitLiveIds()
        this.notifyGraphReady(slotId, slot)
        this.kickHydrate(slot)
        console.info(
          `[multi-scene] secondary live “${req.title}” base=${req.base} ` +
            `playerDist≈${req.distM.toFixed(0)}m parcels=${req.parcelCount ?? '?'} ` +
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
      // Tertiary tickSync is a no-op (scripts off). Always skip play-frame (SceneLoop.send owns it).
      slot.tickSync(player, camera, interval, true)
    }
  }

  /**
   * During post-promote settle (new boots paused), still advance **sticky demoted**
   * residents so the world never goes void. Tertiary sticky no-ops cheaply.
   * Must not become a tickPlayFrame back door while SceneLoop owns the clock.
   */
  tickStickySync(player: EntityPose, camera: EntityPose): void {
    const interval = secondaryTickIntervalMs(this.tier)
    for (const [id, slot] of this.slots) {
      if (!this.stickyIds.has(id)) continue
      slot.tickSync(player, camera, interval, true)
    }
  }

  /** Round-robin cursor — at most one secondary full renderer/bridges pass per async frame. */
  private asyncFullWorkCursor = 0

  /**
   * Async projection + bridges for live secondaries.
   * Scripts run on SceneLoop.send; full renderer/bridges are staggered
   * so N neighbors cannot each pay plaza-scale attach/animator cost on the same rAF.
   *
   * COD F1 — when `applyBudgetMs` is exhausted (PE already spent remainder), all
   * secondaries dirty-collider-only this frame (no full syncRenderer).
   */
  hasHydratingSecondary(): boolean {
    for (const slot of this.slots.values()) {
      if (slot.needsHydrationApply()) return true
    }
    return false
  }

  /** Empty GPU graph only — do not steal leftover for pending=1 after first mesh. */
  hasEmptyGraphHydrating(): boolean {
    for (const slot of this.slots.values()) {
      if (slot.needsEmptyGraphHydration()) return true
    }
    return false
  }

  /**
   * Off-play attach pump — plaza leftover is often 0 ms so new guests never
   * get syncRenderer and stay empty (snow worker started, 0 GLBs).
   *
   * Must use setTimeout, not requestIdleCallback: plaza rAF stays busy and
   * idle callbacks never run, so the pump died silently (no hydrate log).
   */
  private kickHydrate(slot: SceneWorkerSlot): void {
    const id = slot.scene.entityId ?? ''
    if (this.hydratePumps.has(id)) return
    this.hydratePumps.add(id)
    let n = 0
    const startedAt = performance.now()
    const MAX_MS = 30_000
    const pump = (): void => {
      if (this.disposed || !this.cache || !this.slots.has(id)) {
        this.hydratePumps.delete(id)
        return
      }
      const elapsed = performance.now() - startedAt
      const done = !slot.needsHydrationApply() || elapsed > MAX_MS
      if (done) {
        this.hydratePumps.delete(id)
        this.notifyGraphReady(id, slot)
        console.info(
          `[multi-scene] hydrate “${slot.scene.title}” gpu=${slot.system.countGpuVisuals()} ` +
            `pumps=${n} ${elapsed.toFixed(0)}ms`
        )
        return
      }
      n++
      if (n === 1 || n % 10 === 0) {
        console.info(
          `[multi-scene] hydrate pump “${slot.scene.title}” #${n} ` +
            `gpu=${slot.system.countGpuVisuals()} pending=${slot.system.hasContentApplyWork() ? 1 : 0}`
        )
      }
      if (lastFrameOverBudget(22)) {
        setTimeout(pump, 200)
        return
      }
      const lite = slot.needsEmptyGraphHydration()
      void slot
        .tickAsync(this.primaryScene, this.cache, {
          fullWork: true,
          deadlineMs: lite ? 6 : 8,
          hydrateLite: lite,
          pushPhys: false
        })
        .finally(() => {
          setTimeout(pump, lite ? 80 : 64)
        })
    }
    setTimeout(pump, 0)
  }

  /**
   * Live secondaries close enough to cook PhysX (floors/walls).
   * Radius matches empty-land trees ({@link LIVE_SCENE_PHYS_RADIUS_M}) so adjacent
   * occupied land is solid — not only the cell under the feet (old ≤2 m gate).
   */
  nearbyPhysGuestIds(): string[] {
    const out: string[] = []
    for (const [id, dist] of this.lastDistM) {
      if (!Number.isFinite(dist) || dist > LIVE_SCENE_PHYS_RADIUS_M) continue
      const slot = this.slots.get(id)
      if (!slot) continue
      if (slot.residentMode !== 'secondary' && slot.residentMode !== 'tertiary') continue
      out.push(`secondary:${id}`)
    }
    return out
  }

  /** @deprecated Use {@link nearbyPhysGuestIds}. */
  standingInPhysGuestIds(): string[] {
    return this.nearbyPhysGuestIds()
  }

  async tickAsync(opts?: {
    applyBudgetMs?: number
    /** SceneLoop guests that may cook PhysX (`secondary:<id>`). Empty = none. */
    physGuestIds?: string[]
  }): Promise<PhysicsColliderDesc[]> {
    if (!this.cache) return []
    const descs: PhysicsColliderDesc[] = []
    const slots = [...this.slots.values()]
    const secondaries = slots.filter((s) => !s.isTertiary)
    const budgetMs = opts?.applyBudgetMs
    const physGuestIds = opts?.physGuestIds
    const MIN_FULL_MS = 2
    const hydrating = secondaries.filter((s) => s.needsHydrationApply())
    for (const slot of hydrating) this.kickHydrate(slot)
    const allowFull = budgetMs === undefined || budgetMs >= MIN_FULL_MS || hydrating.length > 0
    const physStanding = secondaries.find((s) => this.slotMatchesPhysGuest(s.id, physGuestIds))
    const prefer = hydrating[0] ?? physStanding
    const fullIdx =
      allowFull && secondaries.length > 0
        ? this.asyncFullWorkCursor++ % secondaries.length
        : -1
    const fullSlot = prefer ?? (fullIdx >= 0 ? secondaries[fullIdx] : null)
    const t0 = performance.now()

    for (const slot of slots) {
      const pushPhys = this.slotMatchesPhysGuest(slot.id, physGuestIds)
      if (slot.isTertiary) {
        descs.push(
          ...(await slot.tickAsync(this.primaryScene, this.cache, { pushPhys }))
        )
        continue
      }
      const spent = performance.now() - t0
      const rem = budgetMs === undefined ? undefined : budgetMs - spent
      const stillRoom = rem === undefined || rem >= MIN_FULL_MS
      const fullWork = allowFull && stillRoom && slot === fullSlot
      descs.push(
        ...(await slot.tickAsync(this.primaryScene, this.cache, {
          fullWork,
          deadlineMs: fullWork ? rem : undefined,
          pushPhys
        }))
      )
    }
    return descs
  }

  /** Sticky-only async (settle window) — colliders for demoted residents. */
  async tickStickyAsync(): Promise<PhysicsColliderDesc[]> {
    // World already rekey+translated sticky hulls. setPrimaryScene recapture used
    // to dirty-push the whole plaza into syncStaticColliders (52M expand → 4fps).
    return []
  }

  allRegisteredPhysIds(physGuestIds?: string[]): number[] {
    const out: number[] = []
    for (const [id, slot] of this.slots) {
      // Sticky always stays in `next`. Empty physGuestIds during promote-settle
      // used to drop them → invalidateStaticCollider → static=2 → recook.
      if (!this.stickyIds.has(id) && !this.slotMatchesPhysGuest(id, physGuestIds)) continue
      out.push(...slot.registeredPhysicsEntities())
    }
    return out
  }

  private slotMatchesPhysGuest(slotId: string, physGuestIds?: string[]): boolean {
    if (physGuestIds === undefined) return true
    for (const g of physGuestIds) {
      if (g === slotId || g === `secondary:${slotId}`) return true
    }
    return false
  }

  dispose(): void {
    this.disposed = true
    this.hydratePumps.clear()
    this.footprints.clear()
    this.lastDistM.clear()
    for (const slot of this.slots.values()) slot.dispose()
    this.slots.clear()
    this.stickyIds.clear()
    this.booting.clear()
    this.emitLiveIds()
  }
}
