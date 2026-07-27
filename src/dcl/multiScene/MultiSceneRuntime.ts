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
}

/**
 * World-attached multi-scene runtime: secondary live workers + PE tick hooks.
 * Primary remains World.sceneScript (not managed here) until promote handoff.
 *
 * Priority: primary (World) > PE > secondary > tertiary (AOI, no workers).
 */
export class MultiSceneRuntime {
  readonly arbiter = new PrivilegedIntentArbiter()
  readonly pe: PortableExperienceManager

  private secondary: SecondaryLiveManager | null = null
  private primaryScene: ResolvedScene | null = null
  private cache: AssetCache | null = null
  private disposed = false
  private onLiveSecondaryIds: ((ids: ReadonlySet<string>) => void) | null
  /** Last multi-scene phys descs — for tracking invalidation. */
  private lastMultiPhysIds = new Set<number>()
  /** Live secondary tick/reconcile gated until primary play-ready. */
  private secondaryActivityEnabled = false

  constructor(opts: MultiSceneRuntimeOptions) {
    this.pe = opts.peManager
    this.onLiveSecondaryIds = opts.onLiveSecondaryIds ?? null
  }

  setOnLiveSecondaryIds(fn: ((ids: ReadonlySet<string>) => void) | null): void {
    this.onLiveSecondaryIds = fn
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

  get secondaryManager(): SecondaryLiveManager | null {
    return this.secondary
  }

  bindWorld(opts: {
    primaryScene: ResolvedScene
    cache: AssetCache
    host: SceneHost
    tier: PerformanceTier
    poseProvider: () => { player: EntityPose; camera: EntityPose }
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
      onLiveIdsChange: (ids) => this.onLiveSecondaryIds?.(ids)
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
    return this.secondary?.ensureSecondaryForParcel(x, y, timeoutMs) ?? false
  }

  hasSecondaryForParcel(x: number, y: number): boolean {
    return this.secondary?.hasSecondaryForParcel(x, y) ?? false
  }

  setSecondaryActivityEnabled(enabled: boolean): void {
    this.secondaryActivityEnabled = enabled
  }

  /** When false, soft-route must not force-boot neighbors (promote settle). */
  isSecondaryActivityEnabled(): boolean {
    return this.secondaryActivityEnabled
  }

  reconcileSecondaries(candidates: SecondaryLiveRequest[]): void {
    if (!this.secondaryActivityEnabled) return
    this.secondary?.reconcile(candidates)
  }

  /** Prefer live-secondary boot for the parcel under feet (promote without /goto). */
  setSecondaryPriorityParcel(x: number, y: number | null): void {
    this.secondary?.setPriorityParcel(x, y)
  }

  hasLiveSecondaryForParcel(x: number, y: number): boolean {
    return this.secondary?.hasSecondaryForParcel(x, y) ?? false
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
   * Async projection + collider descs for PE/secondary.
   * World cooks these into PhysX with namespaced entity ids.
   */
  async tickAsync(): Promise<{
    colliders: PhysicsColliderDesc[]
    invalidatePhysIds: number[]
  }> {
    const colliders: PhysicsColliderDesc[] = []
    colliders.push(...(await this.pe.tickAsync()))
    if (this.secondaryActivityEnabled) {
      colliders.push(...((await this.secondary?.tickAsync()) ?? []))
    } else {
      colliders.push(...((await this.secondary?.tickStickyAsync()) ?? []))
    }

    if (this.primaryScene && this.cache) {
      this.cache.setScene(this.primaryScene)
    }

    const invalidatePhysIds = this.pe.takePhysInvalidations()
    // Track live multi phys ids.
    const next = new Set(colliders.map((d) => d.entity))
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
