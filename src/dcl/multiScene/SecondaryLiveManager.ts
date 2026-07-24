import type { EntityPose } from '../../bridge/ReservedEntitiesSync'
import type { AssetCache } from '../../rendering/AssetCache'
import type { SceneHost } from '../../rendering/SceneHost'
import type { PhysicsColliderDesc } from '../../physics/PhysXWorld'
import type { PerformanceTier } from '../../shim/types'
import type { SceneScriptSystem } from '../../core/systems/SceneScriptSystem'
import { resolveSceneFromRoute } from '../content/resolveScene'
import type { ResolvedScene } from '../content/types'
import {
  SECONDARY_LIVE_BOOT_CONCURRENCY,
  secondaryLiveCap,
  secondaryLiveRadiusM,
  secondaryTickIntervalMs
} from './caps'
import type { PrivilegedIntentArbiter } from './PrivilegedIntentArbiter'
import { secondaryPhysOffset } from './physOffsets'
import { isModestSceneForSecondary } from './sceneWeight'
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
   * Keep outgoing primary warm as a secondary so walking back can resume without reload.
   * Large multi-parcel scenes are disposed instead (sticky dual-resident kills CBD).
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

    // Already have this entity as secondary — keep existing, drop demoted system.
    if (this.slots.has(id)) {
      console.info(`[multi-scene] demote skip — already secondary “${scene.title}”`)
      try {
        system.dispose()
      } catch {
        /* ignore */
      }
      this.stickyIds.add(id)
      return { entityId: id, primaryPhysIds: [] }
    }

    // CBD plaza / large multi-parcel — never sticky demote (two full systems = tab death).
    if (!isModestSceneForSecondary(scene)) {
      const parcels = scene.parcels?.length ?? 0
      const glbs = scene.content?.filter((f) => /\.glb$/i.test(f.file)).length ?? 0
      console.info(
        `[multi-scene] demote dispose “${scene.title}” — too large for sticky secondary (parcels=${parcels} glbs=${glbs})`
      )
      try {
        system.dispose()
      } catch {
        /* ignore */
      }
      return null
    }

    // Make room — prefer evicting non-sticky warm secondaries.
    this.evictToCapacity(this.maxSlots() - 1)

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
      existingSystem: system
    })
    await slot.start()
    if (this.disposed) {
      slot.dispose()
      return null
    }
    this.slots.set(id, slot)
    this.stickyIds.add(id)
    this.emitLiveIds()
    console.info(
      `[multi-scene] demoted “${scene.title}” → sticky secondary (walk back = resume handoff)`
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

      if (!isModestSceneForSecondary(scene)) {
        const parcels = scene.parcels?.length ?? 0
        const glbs = scene.content?.filter((f) => /\.glb$/i.test(f.file)).length ?? 0
        console.info(
          `[multi-scene] skip force-boot “${scene.title}” @ ${key} — too large (parcels=${parcels} glbs=${glbs})`
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

  reconcile(candidates: SecondaryLiveRequest[]): void {
    if (this.disposed || !this.cache || !this.host || !this.arbiter || !this.poseProvider) return
    const cap = this.maxSlots()
    const now = performance.now()
    if (now - this.lastReconcileAt < 800) return
    this.lastReconcileAt = now

    // Live radius ≤ Scene Distance (default max 64m). Far warm/tertiary stay outside live.
    const liveRadiusM = secondaryLiveRadiusM()
    const inRange = candidates
      .filter((c) => liveRadiusM > 0 && c.distM <= liveRadiusM)
      .sort((a, b) => a.distM - b.distM)
      .slice(0, Math.max(cap, 0))

    const want = new Set(inRange.map((c) => c.entityId))
    // Sticky demoted primaries always wanted (resume path).
    for (const id of this.stickyIds) want.add(id)

    for (const [id, slot] of this.slots) {
      if (!want.has(id)) {
        slot.dispose()
        this.slots.delete(id)
        this.stickyIds.delete(id)
        console.info(`[multi-scene] secondary leave ring ${id.slice(0, 12)}…`)
      }
    }
    this.emitLiveIds()

    // Serial boot — one full secondary worker at a time (parallel boots starve seamless promote).
    if (this.booting.size >= SECONDARY_LIVE_BOOT_CONCURRENCY) return

    for (const req of inRange) {
      if (this.slots.has(req.entityId) || this.booting.has(req.entityId)) continue
      if (this.slots.size + this.booting.size >= cap) break
      void this.bootOne(req)
      break // only start one per reconcile
    }
  }

  private async bootOne(req: SecondaryLiveRequest): Promise<void> {
    if (this.disposed || !this.cache || !this.host || !this.arbiter || !this.poseProvider) return
    this.booting.add(req.entityId)
    try {
      const scene = await resolveSceneFromRoute({
        kind: 'coords',
        x: req.resolveX,
        y: req.resolveY,
        segment: `${req.resolveX},${req.resolveY}`
      })
      if (this.disposed || !scene?.mainEntry || !scene.entityId) return
      if (this.primaryScene?.entityId === scene.entityId) return
      if (this.slots.has(req.entityId)) return

      // Large multi-parcel plazas: visuals/warm only — never dual-resident live worker.
      if (!isModestSceneForSecondary(scene)) {
        console.info(
          `[multi-scene] skip live secondary “${req.title}” — too large (parcels=${scene.parcels?.length ?? 0})`
        )
        return
      }

      const slotIndex = this.nextSlotIndex++
      const slot = new SceneWorkerSlot({
        id: req.entityId,
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
      this.slots.set(req.entityId, slot)
      this.emitLiveIds()
      console.info(
        `[multi-scene] secondary live “${req.title}” base=${req.base} dist≈${req.distM.toFixed(0)}m`
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

  async tickAsync(): Promise<PhysicsColliderDesc[]> {
    if (!this.cache) return []
    const descs: PhysicsColliderDesc[] = []
    for (const slot of this.slots.values()) {
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
