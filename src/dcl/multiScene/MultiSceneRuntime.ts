import type { EntityPose } from '../../bridge/ReservedEntitiesSync'
import type { AssetCache } from '../../rendering/AssetCache'
import type { SceneHost } from '../../rendering/SceneHost'
import type { PhysicsColliderDesc } from '../../physics/PhysXWorld'
import type { PerformanceTier } from '../../shim/types'
import type { ResolvedScene } from '../content/types'
import { PrivilegedIntentArbiter } from './PrivilegedIntentArbiter'
import { PortableExperienceManager } from './PortableExperienceManager'
import {
  resolvePortableExperiencesPolicy,
  type PortableExperiencesPolicy
} from './resolvePortableExperiences'
import {
  SecondaryLiveManager,
  type PromoteHandoffPayload
} from './SecondaryLiveManager'
import type { SecondaryLiveRequest } from './types'

export type MultiSceneRuntimeOptions = {
  peManager: PortableExperienceManager
  onLiveSecondaryIds?: (ids: ReadonlySet<string>) => void
  onLiveGraphReady?: (entityId: string) => void
}

/**
 * World-attached multi-scene runtime: secondary live workers + PE tick hooks.
 * Primary remains World.sceneScript (not managed here) until promote handoff.
 *
 * Priority: occupancy world scene (World) > PE (always occupied) > secondary > tertiary.
 */
export class MultiSceneRuntime {
  readonly arbiter = new PrivilegedIntentArbiter()
  readonly pe: PortableExperienceManager

  private secondary: SecondaryLiveManager | null = null
  private primaryScene: ResolvedScene | null = null
  private cache: AssetCache | null = null
  private disposed = false
  private onLiveSecondaryIds: ((ids: ReadonlySet<string>) => void) | null
  private onLiveGraphReady: ((entityId: string) => void) | null
  /** Last multi-scene phys descs — for tracking invalidation. */
  private lastMultiPhysIds = new Set<number>()
  /** Live secondary tick/reconcile gated until primary play-ready. */
  private secondaryActivityEnabled = false

  constructor(opts: MultiSceneRuntimeOptions) {
    this.pe = opts.peManager
    this.onLiveSecondaryIds = opts.onLiveSecondaryIds ?? null
    this.onLiveGraphReady = opts.onLiveGraphReady ?? null
  }

  setOnLiveSecondaryIds(fn: ((ids: ReadonlySet<string>) => void) | null): void {
    this.onLiveSecondaryIds = fn
  }

  setOnLiveGraphReady(fn: ((entityId: string) => void) | null): void {
    this.onLiveGraphReady = fn
  }

  /** Push current live/sticky entity ids to AOI (hide duplicate composites). */
  syncLiveSecondaryVisibility(): void {
    const ids = this.secondary?.liveEntityIds() ?? new Set<string>()
    this.onLiveSecondaryIds?.(ids)
  }

  /**
   * Absolute parcel keys for all resident secondary/tertiary graphs.
   * AOI empty-land must skip these (sticky demoted plaza continuity).
   */
  residentParcelKeys(): string[] {
    return this.secondary?.residentParcelKeys() ?? []
  }

  /** Promote settle: scripts off on all residents (primary alone). */
  forceAllResidentsTertiary(reason: string): void {
    this.secondary?.forceAllResidentsTertiary(reason)
  }

  restoreStickySecondaries(): void {
    this.secondary?.restoreStickySecondaries()
  }

  ensureResidentsVisible(): void {
    this.secondary?.ensureResidentsVisible()
  }

  /** Sticky/live secondary-offset colliders for immediate PhysX keep-alive after demote. */
  collectResidentColliders(): import('../../physics/PhysXWorld').PhysicsColliderDesc[] {
    return this.secondary?.collectAllCachedColliders() ?? []
  }

  collectResidentCollidersFor(
    entityId: string
  ): import('../../physics/PhysXWorld').PhysicsColliderDesc[] {
    return this.secondary?.collectCachedCollidersFor(entityId) ?? []
  }

  recaptureResidentColliders(
    entityId: string
  ): import('../../physics/PhysXWorld').PhysicsColliderDesc[] {
    return this.secondary?.recaptureColliders(entityId) ?? []
  }

  markResidentCollidersSynced(): void {
    this.secondary?.markAllCollidersSynced()
    // Seed tracking immediately so the next tickAsync does not treat sticky ids as gone
    // before it rebuilds from allRegisteredPhysIds (race with promote handoff).
    for (const id of this.secondary?.allRegisteredPhysIds() ?? []) {
      this.lastMultiPhysIds.add(id)
    }
  }

  get secondaryManager(): SecondaryLiveManager | null {
    return this.secondary
  }

  bindWorld(opts: {
    primaryScene: ResolvedScene
    cache: AssetCache
    host: SceneHost
    tier: PerformanceTier
    poseProvider: () => { player: EntityPose; camera: EntityPose }
    getUserData?: () => Promise<import('../../shim/types').UserDataResponse>
    getRealm?: () => Promise<import('../../shim/types').RealmResponse>
    pePolicy: PortableExperiencesPolicy
  }): void {
    if (this.disposed) return
    this.primaryScene = opts.primaryScene
    this.cache = opts.cache

    this.secondary?.dispose()
    this.secondary = new SecondaryLiveManager()
    this.secondary.bind({
      primaryScene: opts.primaryScene,
      cache: opts.cache,
      host: opts.host,
      tier: opts.tier,
      arbiter: this.arbiter,
      poseProvider: opts.poseProvider,
      getUserData: opts.getUserData,
      getRealm: opts.getRealm,
      onLiveIdsChange: (ids) => this.onLiveSecondaryIds?.(ids),
      onLiveGraphReady: (id) => this.onLiveGraphReady?.(id)
    })

    void this.pe.attachWorld({
      primaryScene: opts.primaryScene,
      cache: opts.cache,
      host: opts.host,
      tier: opts.tier,
      arbiter: this.arbiter,
      poseProvider: opts.poseProvider,
      pePolicy: opts.pePolicy
    })
  }

  /**
   * After promote handoff — keep secondaries/PE alive, retarget primary scene for content map.
   * Re-applies scene.json portableExperiences policy (disable / hideUi) for the new primary.
   */
  notifyPrimaryChanged(scene: ResolvedScene): void {
    this.primaryScene = scene
    this.secondary?.setPrimaryScene(scene)
    this.pe.setPrimaryScene(scene)
    if (this.cache) this.cache.setScene(scene)
    const pePolicy =
      scene.portableExperiencesPolicy ?? resolvePortableExperiencesPolicy(scene.metadata)
    this.pe.applyScenePolicy(pePolicy)
  }

  /** Before World.dispose / host teardown. */
  unbindWorld(): void {
    this.secondary?.dispose()
    this.secondary = null
    this.pe.detachWorld()
    this.arbiter.clear()
    this.primaryScene = null
    this.cache = null
    this.lastMultiPhysIds.clear()
  }

  /**
   * Drop all live secondaries immediately (keep PE).
   * Call before seamless promote so cold plaza load isn't competing with 6 neighbor workers.
   */
  disposeSecondariesOnly(): void {
    this.secondary?.dispose()
    this.secondary = null
    this.onLiveSecondaryIds?.(new Set())
  }

  /** Stand-on promote: adopt live secondary if present. */
  takeSecondaryForPromote(x: number, y: number): PromoteHandoffPayload | null {
    return this.secondary?.takeForPromote(x, y) ?? null
  }

  /**
   * Keep outgoing primary warm for walk-back resume.
   * @param newPrimaryBaseParcel — incoming primary SW so demoted meshes offset correctly.
   */
  async demotePrimaryToSecondary(
    system: import('../../core/systems/SceneScriptSystem').SceneScriptSystem,
    scene: ResolvedScene,
    newPrimaryBaseParcel?: string
  ): Promise<{ entityId: string; primaryPhysIds: number[] } | null> {
    return this.secondary?.adoptDemotedPrimary(system, scene, newPrimaryBaseParcel) ?? null
  }

  /** Force-boot secondary for parcel then handoff can succeed. */
  async ensureSecondaryForParcel(x: number, y: number, timeoutMs?: number): Promise<boolean> {
    if (!this.secondaryActivityEnabled) return false
    return this.secondary?.ensureSecondaryForParcel(x, y, timeoutMs) ?? false
  }

  hasSecondaryForParcel(x: number, y: number): boolean {
    return this.secondary?.hasSecondaryForParcel(x, y) ?? false
  }

  setSecondaryActivityEnabled(enabled: boolean): void {
    if (this.secondaryActivityEnabled === enabled) return
    this.secondaryActivityEnabled = enabled
    console.info(`[multi-scene] secondary activity ${enabled ? 'ON' : 'OFF'}`)
  }

  /** When false, soft-route must not force-boot neighbors (promote settle). */
  isSecondaryActivityEnabled(): boolean {
    return this.secondaryActivityEnabled
  }

  reconcileSecondaries(candidates: SecondaryLiveRequest[]): void {
    if (!this.secondaryActivityEnabled) return
    this.secondary?.reconcile(candidates)
  }

  setLiveGuestLoadBoot(enabled: boolean): void {
    this.secondary?.setLoadBoot(enabled)
  }

  liveGuestLoadStats(): {
    ready: number
    target: number
    booting: number
    titles: string[]
  } {
    return (
      this.secondary?.liveGuestLoadStats() ?? {
        ready: 0,
        target: 0,
        booting: 0,
        titles: []
      }
    )
  }

  /** Prefer live-secondary boot for the parcel under feet (promote without /goto). */
  setSecondaryPriorityParcel(x: number, y: number | null): void {
    this.secondary?.setPriorityParcel(x, y)
  }

  hasLiveSecondaryForParcel(x: number, y: number): boolean {
    return this.secondary?.hasSecondaryForParcel(x, y) ?? false
  }

  liveGuestIdForParcel(x: number, y: number): string | null {
    return this.secondary?.liveGuestIdForParcel(x, y) ?? null
  }

  liveGuestGraphReady(guestId: string): boolean {
    return this.secondary?.liveGuestGraphReady(guestId) ?? false
  }

  tickSync(player: EntityPose, camera: EntityPose, frame = 0): void {
    this.pe.tickSync(player, camera, frame)
    if (this.secondaryActivityEnabled) {
      this.secondary?.tickSync(player, camera)
    } else {
      // Settle window: sticky demoted primaries stay resident (no void).
      this.secondary?.tickStickySync(player, camera)
    }
  }

  /**
   * Live secondary systems whose host Animator/Tween must advance (not tertiary).
   * World pumps these after tickSync — scripts alone do not advance mixers.
   */
  getSecondaryMotionSystems(): import('../../core/systems/SceneScriptSystem').SceneScriptSystem[] {
    return this.secondary?.getSecondaryMotionSystems() ?? []
  }

  /**
   * Async projection + collider descs for PE/secondary.
   * World cooks these into PhysX with namespaced entity ids.
   *
   * Dirty-once tertiary residents return [] after the first PhysX push (FPS guard).
   * They still own remapped entity ids — only invalidate when a slot actually drops
   * its registered set (dispose / promote detach). Treating "not streamed this frame"
   * as removal was the CBD→scene→CBD 3fps death spiral (wipe→Missing actors→recook).
   *
   * COD F1 — `applyBudgetMs` is wall remainder after primary full apply.
   * PE spends first; secondaries get leftover (or dirty-only if exhausted).
   */
  /** True when PE or a live/sticky secondary still needs leftover apply. */
  hasAsyncTickWork(): boolean {
    return this.pe.runningCount() > 0 || (this.secondary?.hasResidentSlots() ?? false)
  }

  async tickAsync(opts?: {
    applyBudgetMs?: number
    physGuestIds?: string[]
  }): Promise<{
    colliders: PhysicsColliderDesc[]
    invalidatePhysIds: number[]
  }> {
    const colliders: PhysicsColliderDesc[] = []
    const budgetMs = opts?.applyBudgetMs
    const t0 = performance.now()
    colliders.push(...(await this.pe.tickAsync({ applyBudgetMs: budgetMs })))
    const peSpent = performance.now() - t0
    const secondaryBudget =
      budgetMs === undefined ? undefined : Math.max(0, budgetMs - peSpent)
    if (this.secondaryActivityEnabled) {
      colliders.push(
        ...((await this.secondary?.tickAsync({
          applyBudgetMs: secondaryBudget,
          physGuestIds: opts?.physGuestIds
        })) ?? [])
      )
    } else {
      colliders.push(...((await this.secondary?.tickStickyAsync()) ?? []))
    }

    if (this.primaryScene && this.cache) {
      this.cache.setScene(this.primaryScene)
    }

    const invalidatePhysIds = this.pe.takePhysInvalidations()
    // Still-resident remapped ids (even when dirty-once returned [] this frame).
    // Must include PE + secondary registered sets — otherwise dirty-once PE/secondary
    // colliders look "gone" next frame → invalidateStaticCollider → soft floor holes.
    const next = new Set<number>()
    for (const d of colliders) next.add(d.entity)
    for (const id of this.secondary?.allRegisteredPhysIds(opts?.physGuestIds) ?? []) {
      next.add(id)
    }
    for (const id of this.pe.allRegisteredPhysIds()) {
      next.add(id)
    }
    for (const id of this.lastMultiPhysIds) {
      if (!next.has(id)) invalidatePhysIds.push(id)
    }
    this.lastMultiPhysIds = next

    return { colliders, invalidatePhysIds }
  }

  dispose(): void {
    this.disposed = true
    this.unbindWorld()
  }
}
