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
  secondaryTickIntervalMs
} from './caps'
import type { PrivilegedIntentArbiter } from './PrivilegedIntentArbiter'
import { secondaryPhysOffset } from './physOffsets'
import { SceneWorkerSlot } from './SceneWorkerSlot'
import type { SecondaryLiveRequest } from './types'

export type PromoteHandoffPayload = {
  entityId: string
  scene: ResolvedScene
  system: SceneScriptSystem
  /** Phys ids that were registered under secondary offset — World should invalidate. */
  physIds: number[]
}

/**
 * Long-lived secondary workers for nearest inner-ring scenes + demoted primaries.
 * Demoted primaries are sticky (resume without reload when you walk back).
 */
export class SecondaryLiveManager {
  private readonly slots = new Map<string, SceneWorkerSlot>()
  /** Demoted primaries — never auto-evicted by AOI reconcile (only by cap pressure). */
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

  /** At least 1 slot so demoted primary can stay warm for resume. */
  private maxSlots(): number {
    return Math.max(1, secondaryLiveCap(this.tier))
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

  /**
   * If a live secondary covers parcel (x,y), detach it for primary handoff.
   */
  takeForPromote(x: number, y: number): PromoteHandoffPayload | null {
    const key = `${x},${y}`
    for (const [entityId, slot] of this.slots) {
      const parcels = slot.scene.parcels
      const base = slot.scene.baseParcel.trim()
      if (base === key || parcels.some((p) => p.trim() === key)) {
        this.slots.delete(entityId)
        this.stickyIds.delete(entityId)
        this.emitLiveIds()
        const physIds = [...slot.registeredPhysicsEntities()]
        const system = slot.detachForPromote()
        console.info(
          `[multi-scene] handoff secondary → primary “${slot.scene.title}” base=${base} parcel=${key}`
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
   * Keep outgoing primary **resident** as a sticky secondary — never unload into void.
   *
   * Modest scenes: full muted secondary (scripts warm, resume handoff).
   * Large multi-parcel (plaza): frozen-visual sticky — meshes stay, worker onUpdate paused
   * so dual full plazas don't thrash. Continuity > dispose-then-composite gap.
   *
   * Returns phys entity ids that used primary (native) ids — World must invalidate them.
   */
  async adoptDemotedPrimary(
    system: SceneScriptSystem,
    scene: ResolvedScene
  ): Promise<{ entityId: string; primaryPhysIds: number[] } | null> {
    if (this.disposed || !this.cache || !this.host || !this.arbiter || !this.poseProvider) {
      return null
    }
    if (!scene.entityId || !scene.mainEntry) {
      try {
        system.dispose()
      } catch {
        /* ignore */
      }
      return null
    }

    const id = scene.entityId
    const parcelCount = scene.parcels?.length || 1
    // Dual full plaza workers thrash — freeze scripts, keep meshes (never dispose).
    const frozenVisual = parcelCount > SECONDARY_LIVE_AUTO_MAX_PARCELS

    // Already have this entity as secondary — keep existing resident graph, drop demoted system
    // only if it's a different system instance (shouldn't double-dispose the live one).
    if (this.slots.has(id)) {
      const existing = this.slots.get(id)!
      console.info(
        `[multi-scene] demote skip — already secondary “${scene.title}” (keep resident)`
      )
      if (existing.system !== system) {
        try {
          system.dispose()
        } catch {
          /* ignore */
        }
      }
      this.stickyIds.add(id)
      this.emitLiveIds()
      return { entityId: id, primaryPhysIds: [] }
    }

    // Make room — never evict sticky; prefer non-sticky warm secondaries.
    // Always keep ≥1 slot for demoted primary (continuity).
    this.evictToCapacity(Math.max(0, this.maxSlots() - 1))

    // Collect native primary phys ids before remapping under offset.
    const primaryPhysIds = system.getAllPhysicsColliderDescs().map((d) => d.entity)

    const slotIndex = this.nextSlotIndex++
    // Prefer current primary base; handoff may still be mid-swap — notifyPrimaryChanged
    // retargets immediately after if needed.
    const primaryBase =
      this.primaryScene?.baseParcel?.trim() || scene.baseParcel
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
      frozenVisual
    })
    await slot.start()
    if (this.disposed) {
      // World still owns continuity — do not dispose demoted system if handoff aborted mid-way.
      this.slots.set(id, slot)
      this.stickyIds.add(id)
      return { entityId: id, primaryPhysIds }
    }
    this.slots.set(id, slot)
    this.stickyIds.add(id)
    this.emitLiveIds()
    console.info(
      `[multi-scene] demoted “${scene.title}” → sticky secondary parcels=${parcelCount}` +
        (frozenVisual
          ? ' frozen-visual (meshes resident, scripts paused)'
          : ' warm (walk back = resume handoff)')
    )
    return { entityId: id, primaryPhysIds }
  }

  /**
   * Force-boot a secondary for parcel if missing.
   * Refuses large multi-parcel scenes (use seamless promote instead).
   * Prefer not calling this from promote — cold dual-boot kills CBD.
   */
  async ensureSecondaryForParcel(
    x: number,
    y: number,
    timeoutMs = 28_000
  ): Promise<boolean> {
    if (this.disposed || !this.cache || !this.host || !this.arbiter || !this.poseProvider) {
      return false
    }
    if (this.hasSecondaryForParcel(x, y)) return true

    const key = `${x},${y}`
    // Resolve + boot
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
      if (this.slots.has(scene.entityId)) return true

      // Never force-boot plaza-scale estates as live secondaries (dual-resident freezes CBD).
      // Seamless promote (cold jump) handles walk-on to multi-parcel primaries.
      const parcelCount = scene.parcels?.length ?? 0
      if (parcelCount > SECONDARY_LIVE_AUTO_MAX_PARCELS) {
        console.info(
          `[multi-scene] refuse force-boot “${scene.title}” parcels=${parcelCount} ` +
            `(>${SECONDARY_LIVE_AUTO_MAX_PARCELS}) — seamless promote instead`
        )
        return false
      }

      this.evictToCapacity(this.maxSlots() - 1)

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
        primaryBaseParcel: this.primaryScene?.baseParcel
      })
      const boot = slot.start()
      const timed = await Promise.race([
        boot.then(() => true),
        new Promise<boolean>((resolve) => window.setTimeout(() => resolve(false), timeoutMs))
      ])
      if (!timed || this.disposed) {
        slot.dispose()
        return false
      }
      if (this.primaryScene) this.cache.setScene(this.primaryScene)
      this.slots.set(scene.entityId, slot)
      this.emitLiveIds()
      console.info(
        `[multi-scene] force-boot secondary for promote “${scene.title}” @ ${key}`
      )
      return true
    } catch (err) {
      console.warn(`[multi-scene] ensureSecondaryForParcel failed ${key}`, err)
      if (this.primaryScene && this.cache) this.cache.setScene(this.primaryScene)
      return false
    } finally {
      this.booting.delete(key)
    }
  }

  /** Evict until slots.size <= keepMax. Sticky last; dispose non-sticky first. */
  private evictToCapacity(keepMax: number): void {
    if (keepMax < 0) keepMax = 0
    while (this.slots.size > keepMax) {
      const nonSticky = [...this.slots.entries()].filter(([id]) => !this.stickyIds.has(id))
      const victim = nonSticky[0] ?? [...this.slots.entries()][0]
      if (!victim) break
      const [id, slot] = victim
      slot.dispose()
      this.slots.delete(id)
      this.stickyIds.delete(id)
      console.info(`[multi-scene] secondary evict ${id.slice(0, 12)}… (cap)`)
    }
    this.emitLiveIds()
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
    const cap = this.maxSlots()
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

    const want = new Set(inRange.map((c) => c.entityId))
    // Sticky demoted primaries always wanted (resume path).
    for (const id of this.stickyIds) want.add(id)

    for (const [id, slot] of this.slots) {
      if (!want.has(id)) {
        // Never evict the under-feet priority while pinned (promote path).
        if (pri && (slot.scene.baseParcel.trim() === pri || slot.scene.parcels.some((p) => p.trim() === pri))) {
          want.add(id)
          continue
        }
        slot.dispose()
        this.slots.delete(id)
        this.stickyIds.delete(id)
        console.info(`[multi-scene] secondary leave ring ${id.slice(0, 12)}…`)
      }
    }
    this.emitLiveIds()

    // Serial boot — one full secondary worker at a time (parallel boots starve seamless promote).
    if (this.booting.size >= SECONDARY_LIVE_BOOT_CONCURRENCY) return

    // Prefer booting priority parcel first. Evict non-priority to make room if needed.
    // Skip plaza-scale multi-parcel auto-boots (composite shows them) unless under-feet.
    const bootOrder = [...inRange]
    for (const req of bootOrder) {
      if (this.slots.has(req.entityId) || this.booting.has(req.entityId)) continue
      const parcels = req.parcelCount ?? 1
      if (parcels > SECONDARY_LIVE_AUTO_MAX_PARCELS && !coversPri(req)) {
        continue
      }
      if (this.slots.size + this.booting.size >= cap) {
        // Make room for priority / next candidate — drop non-sticky non-priority.
        this.evictToCapacity(cap - 1)
        if (this.slots.size + this.booting.size >= cap) break
      }
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
      if (this.slots.has(req.entityId)) return
      // Catalyst may return a different entity id than active-entities list — still slot it.
      if (this.slots.has(scene.entityId)) return

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
        primaryBaseParcel: this.primaryScene?.baseParcel
      })
      await slot.start()
      if (this.disposed) {
        slot.dispose()
        return
      }
      if (this.primaryScene) this.cache.setScene(this.primaryScene)
      this.slots.set(slotId, slot)
      this.emitLiveIds()
      console.info(
        `[multi-scene] secondary live “${req.title}” base=${req.base} ` +
          `sceneDist≈${req.distM.toFixed(0)}m parcels=${req.parcelCount ?? '?'} ` +
          (preferParcelKey ? `priority=${preferParcelKey}` : '')
      )
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
      slot.tickSync(player, camera, interval)
    }
  }

  /**
   * During post-promote settle (new boots paused), still advance **sticky demoted**
   * residents so the world never goes void. Frozen-visual slots no-op cheaply.
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

  /** Sticky-only async (settle window) — colliders / frozen remaps for demoted residents. */
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
