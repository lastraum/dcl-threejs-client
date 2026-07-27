import type { EntityPose } from '../../bridge/ReservedEntitiesSync'
import { SceneScriptSystem } from '../../core/systems/SceneScriptSystem'
import type { SceneHost } from '../../rendering/SceneHost'
import type { AssetCache } from '../../rendering/AssetCache'
import type { PhysicsColliderDesc } from '../../physics/PhysXWorld'
import type { ResolvedScene } from '../content/types'
import type { PerformanceTier } from '../../shim/types'
import { openExternalUrl } from '../../player/openExternalUrl'
import type { PrivilegedIntentArbiter } from './PrivilegedIntentArbiter'
import {
  applySecondarySceneRootOrigin,
  clearSecondarySceneRootOrigin
} from './secondarySceneOrigin'
import { SCENE_WORKER_PRIORITY, type SceneWorkerKind } from './types'

export type SceneWorkerSlotOptions = {
  id: string
  kind: SceneWorkerKind
  scene: ResolvedScene
  cache: AssetCache
  host: SceneHost
  performanceTier: PerformanceTier
  arbiter: PrivilegedIntentArbiter
  poseProvider: () => { player: EntityPose; camera: EntityPose }
  /** PhysX entity id offset so multi-scene colliders don't clash with primary. */
  physOffset: number
  /**
   * Primary scene base parcel — secondaries must offset their entity root by
   * (neighborBase − primaryBase) so meshes sit in the correct Genesis footprint.
   * PE ignores this (avatar-local / host origin).
   */
  primaryBaseParcel?: string
  /**
   * Already-running system (demoted primary). Skips prepare/boot — only rewires
   * to secondary privilege + renames entity root.
   */
  existingSystem?: SceneScriptSystem
  /**
   * Large multi-parcel demoted primary: keep **meshes** resident, pause worker scripts
   * so dual full plazas don't thrash — continuity over dispose-to-void.
   */
  frozenVisual?: boolean
}

/**
 * One isolated SceneScriptSystem with kind/priority metadata.
 * Full capability surface for PE; secondary is scripts+colliders without nav privilege.
 */
export class SceneWorkerSlot {
  readonly id: string
  readonly kind: SceneWorkerKind
  readonly priority: number
  readonly scene: ResolvedScene
  readonly physOffset: number
  system: SceneScriptSystem
  private disposed = false
  private detached = false
  private lastTickAt = 0
  private running = false
  private readonly adopted: boolean
  /**
   * Demoted large estate: entity graph stays in the host scene (no unload void);
   * worker onUpdate / heavy async projection is paused.
   */
  readonly frozenVisual: boolean
  /** Phys ids we registered (with offset) — invalidate on dispose. */
  private readonly registeredPhysIds = new Set<number>()
  private primaryBaseParcel: string

  constructor(private readonly opts: SceneWorkerSlotOptions) {
    this.id = opts.id
    this.kind = opts.kind
    this.priority = SCENE_WORKER_PRIORITY[opts.kind]
    this.scene = opts.scene
    this.physOffset = opts.physOffset
    this.adopted = !!opts.existingSystem
    this.frozenVisual = !!opts.frozenVisual
    this.system = opts.existingSystem ?? new SceneScriptSystem()
    this.primaryBaseParcel = (opts.primaryBaseParcel ?? '').trim()
  }

  /**
   * After primary promote — re-place this secondary relative to the new primary SW.
   * Without this, demoted scenes stay at host origin and overrun the new primary.
   */
  retargetPrimaryBase(primaryBaseParcel: string): void {
    this.primaryBaseParcel = primaryBaseParcel.trim()
    if (this.kind !== 'secondary' || this.disposed || this.detached) return
    this.applySceneOriginOffset()
    // World matrices moved — force collider extract so PhysX matches new footprint.
    try {
      this.system.syncCollisionForce()
    } catch {
      /* ignore during teardown */
    }
  }

  private applySceneOriginOffset(): void {
    if (this.kind !== 'secondary') return
    const root = this.system.getEntityStore()?.root
    applySecondarySceneRootOrigin(root, this.scene.baseParcel, this.primaryBaseParcel)
  }

  get isRunning(): boolean {
    return this.running && !this.disposed && !this.detached
  }

  async start(): Promise<void> {
    if (this.disposed || this.detached) return
    const { scene, cache, host, performanceTier, poseProvider } = this.opts

    // Demoted primary — already booted; strip privilege and keep mesh graph resident.
    if (this.adopted) {
      this.system.setPerformanceTier(performanceTier)
      this.system.setClientPoseProvider(poseProvider)
      this.wireSecondaryHandlers()
      // FocusOwner: hard mute + video stop + UI off (keeps SceneUiBridge for promote resume).
      this.system.setFocusPolicy('secondary')
      // Clear primary-only colliders cook hooks (World owns primary cooks only).
      this.system.setCollidersCookCallback(null)
      this.system.setCollidersPoseCallback(null)
      this.system.setCollidersRemoveCallback(null)
      const store = this.system.getEntityStore()
      if (store?.root) {
        store.root.name = this.frozenVisual
          ? `secondary-frozen:${this.id.slice(0, 16)}`
          : `secondary-entities:${this.id.slice(0, 16)}`
        // Continuity: never leave demoted content invisible after handoff.
        store.root.visible = true
        // Ensure still parented to host scene (never drop demoted graph).
        if (host.scene && store.root.parent !== host.scene) {
          host.scene.add(store.root)
        }
      }
      // Was host origin as primary — shift into new primary's frame (or 0 until retarget).
      this.applySceneOriginOffset()
      this.running = true
      this.lastTickAt = performance.now()
      console.info(
        `[multi-scene] demoted primary → secondary “${scene.title}” id=${this.id.slice(0, 16)}… ` +
          `origin→${this.primaryBaseParcel || 'pending'}` +
          (this.frozenVisual
            ? ' sticky large (scripts every frame, lighter PhysX)'
            : ' sticky warm (scripts every frame)')
      )
      return
    }

    if (!scene.mainEntry || !scene.entityId) {
      throw new Error(`[multi-scene] slot ${this.id} missing mainEntry/entityId`)
    }

    this.system.setPerformanceTier(performanceTier)
    this.system.setClientPoseProvider(poseProvider)

    const rootName =
      this.kind === 'pe'
        ? `pe-entities:${this.id.slice(0, 24)}`
        : `secondary-entities:${this.id.slice(0, 16)}`

    cache.setScene(scene)
    this.system.prepare(scene, cache, host, {
      rootName,
      // PE gets its own DOM overlay so primary setVisible / paint never steals clicks.
      // Secondary: detached off-DOM host — never share #scene-ui-root.
      uiRootId: this.kind === 'pe' ? 'pe-ui-root' : `secondary-ui:${this.id.slice(0, 16)}`,
      uiDetached: this.kind === 'secondary',
      focusPolicy: this.kind === 'pe' ? 'pe' : 'secondary'
    })

    if (this.kind === 'pe') {
      // Paint PE UI on first worker mount (not deferred until after start).
      // Primary waits for play chrome; PE is always "in play" once enabled.
      // Manager may hide after start if user disabled the UI toggle.
      this.system.setFocusPolicy('pe')
      this.system.setSceneUiVisible(true)
      this.wirePeHandlers()
    } else {
      this.system.setFocusPolicy('secondary')
      this.wireSecondaryHandlers()
    }

    const poses = poseProvider()
    this.system.seedRendererEntities(poses.player, poses.camera)
    await this.system.start(scene, cache, host)
    // Force collider extract so PE/secondary geometry can enter PhysX.
    this.system.syncCollisionForce()
    // Place neighbor content at Genesis footprint (not on primary origin).
    this.applySceneOriginOffset()
    this.running = true
    this.lastTickAt = performance.now()
    console.info(
      `[multi-scene] started ${this.kind} “${scene.title}” id=${this.id.slice(0, 20)}… physOffset=${this.physOffset}` +
        (this.kind === 'secondary'
          ? ` origin=${this.scene.baseParcel}→${this.primaryBaseParcel || '?'}`
          : '')
    )
  }

  private wirePeHandlers(): void {
    const { arbiter, kind, id } = this.opts

    this.system.setMovePlayerHandler((request) => {
      arbiter.submit({
        channel: 'movePlayer',
        kind,
        slotId: id,
        payload: request,
        at: performance.now()
      })
      return true
    })

    // teleportTo = global parcel coords (not scene-local movePlayerTo).
    this.system.setTeleportToHandler((request) => {
      arbiter.submit({
        channel: 'teleport',
        kind,
        slotId: id,
        payload: request,
        at: performance.now()
      })
      return true
    })

    // changeRealm is deprecated — never navigate.
    this.system.setChangeRealmHandler(() => {
      console.info('[pe] changeRealm ignored (deprecated)')
      return false
    })

    // openExternal: confirm + new tab only — no scene reload.
    this.system.setOpenExternalUrlHandler((request) => openExternalUrl(request))

    this.system.setTriggerEmoteHandler((request) => {
      arbiter.submit({
        channel: 'emote',
        kind,
        slotId: id,
        payload: request,
        at: performance.now()
      })
      return true
    })
  }

  private wireSecondaryHandlers(): void {
    this.system.setMovePlayerHandler(null)
    this.system.setTeleportToHandler(null)
    this.system.setChangeRealmHandler(() => false)
    this.system.setOpenExternalUrlHandler(null)
  }

  setUiVisible(visible: boolean): void {
    this.system.setSceneUiVisible(visible)
  }

  tickSync(player: EntityPose, camera: EntityPose, minIntervalMs: number): boolean {
    if (!this.running || this.disposed || this.detached) return false
    // Secondary scripts always run (minIntervalMs=0). FocusOwner mutes media/UI only.
    const now = performance.now()
    if (now - this.lastTickAt < minIntervalMs) return false
    this.lastTickAt = now
    this.system.syncClientEntities(player, camera)
    if (this.kind === 'pe') {
      this.system.updateTriggerAreas()
    }
    // Full onUpdate for live + demoted secondaries (no video/UI — FocusPolicy secondary).
    this.system.tickPlayFrame()
    return true
  }

  /**
   * Projection + collider extract. Returns remapped PhysX descriptors for World to cook.
   * Large frozen-visual demotes still project meshes but avoid thrashing cook callbacks.
   */
  async tickAsync(
    primaryScene: ResolvedScene | null,
    cache: AssetCache
  ): Promise<PhysicsColliderDesc[]> {
    if (!this.running || this.disposed || this.detached) return []
    cache.setScene(this.scene)
    try {
      await this.system.syncRenderer()
      if (!this.frozenVisual && this.system.hasColliderWorkPending()) {
        this.system.syncCollision()
      }
      await this.system.syncAsyncBridges()
      return this.collectRemappedColliders()
    } finally {
      if (primaryScene) cache.setScene(primaryScene)
    }
  }

  collectRemappedColliders(): PhysicsColliderDesc[] {
    if (this.disposed || this.detached) return []
    const raw = this.system.getAllPhysicsColliderDescs()
    const out: PhysicsColliderDesc[] = []
    for (const d of raw) {
      const entity = d.entity + this.physOffset
      this.registeredPhysIds.add(entity)
      out.push({
        ...d,
        entity,
        fingerprint: `ms:${this.kind}:${this.id.slice(0, 12)}:${d.fingerprint}`
      })
    }
    return out
  }

  registeredPhysicsEntities(): ReadonlySet<number> {
    return this.registeredPhysIds
  }

  /**
   * Promote handoff — yield the live system without disposing it.
   * Slot becomes inert; World adopts the system as primary.
   */
  detachForPromote(): SceneScriptSystem {
    this.detached = true
    this.running = false
    // Clear secondary-style handlers; World will rewire full primary handlers.
    this.system.setMovePlayerHandler(null)
    this.system.setTeleportToHandler(null)
    this.system.setChangeRealmHandler(null)
    this.system.setOpenExternalUrlHandler(null)
    this.system.setTriggerEmoteHandler(null)
    // Becoming primary — host origin is this scene's SW again.
    clearSecondarySceneRootOrigin(this.system.getEntityStore()?.root)
    return this.system
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.running = false
    if (!this.detached) {
      try {
        this.system.dispose()
      } catch (err) {
        console.warn(`[multi-scene] dispose ${this.kind} ${this.id.slice(0, 16)}`, err)
      }
    }
  }
}
