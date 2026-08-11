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
import * as THREE from 'three'

/**
 * Resident LOD for a loaded multi-scene graph (never unload GLBs on demote):
 * - secondary: scripts every frame, FocusOwner mute (no video/UI/pointers)
 * - tertiary: scripts OFF, meshes stay with cheap visual LOD; promote back = scripts only
 */
export type ResidentMode = 'secondary' | 'tertiary'

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
  /** Initial resident mode (default secondary). Sticky demote always starts secondary. */
  initialMode?: ResidentMode
}

/**
 * One isolated SceneScriptSystem with kind/priority metadata.
 * Secondary/tertiary share the same loaded graph; mode only changes scripts + LOD.
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
  private mode: ResidentMode
  /** Phys ids we registered (with offset) — invalidate on dispose / promote. */
  private readonly registeredPhysIds = new Set<number>()
  /**
   * Last remapped collider snapshot (secondary-offset entity ids).
   * Tertiary keeps these in PhysX; we only re-push when {@link collidersDirty}.
   */
  private lastRemappedColliders: PhysicsColliderDesc[] = []
  /** True when World should re-sync lastRemappedColliders (once, not every frame). */
  private collidersDirty = false
  private primaryBaseParcel: string
  private readonly host: SceneHost

  constructor(private readonly opts: SceneWorkerSlotOptions) {
    this.id = opts.id
    this.kind = opts.kind
    this.priority = SCENE_WORKER_PRIORITY[opts.kind]
    this.scene = opts.scene
    this.physOffset = opts.physOffset
    this.adopted = !!opts.existingSystem
    this.mode = opts.initialMode ?? 'secondary'
    this.system = opts.existingSystem ?? new SceneScriptSystem()
    this.primaryBaseParcel = (opts.primaryBaseParcel ?? '').trim()
    this.host = opts.host
  }

  get residentMode(): ResidentMode {
    return this.mode
  }

  get isTertiary(): boolean {
    return this.mode === 'tertiary'
  }

  /**
   * After primary promote — re-place this secondary relative to the new primary SW.
   * Without this, demoted scenes stay at host origin and overrun the new primary.
   */
  retargetPrimaryBase(primaryBaseParcel: string): void {
    this.primaryBaseParcel = primaryBaseParcel.trim()
    if (this.kind !== 'secondary' || this.disposed || this.detached) return
    this.applySceneOriginOffset()
    // Ensure demoted tertiary shells stay on host after offset bake.
    const root = this.system.getEntityStore()?.root
    if (root) {
      root.visible = true
      if (this.host.scene && root.parent !== this.host.scene) {
        this.host.scene.add(root)
      }
    }
    // Pose-only: update remapped desc matrices for World pose-slide — never force recook.
    if (this.lastRemappedColliders.length > 0) {
      this.captureRemappedColliders()
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

  /**
   * Mode switch without GLB reload:
   * - tertiary: pause scene onUpdate, freeze animators, no cast shadows
   * - secondary: resume onUpdate, unfreeze animators, FocusOwner mute stays
   */
  setResidentMode(mode: ResidentMode): void {
    if (this.disposed || this.detached || this.kind === 'pe') return
    if (this.mode === mode) {
      this.applyModeVisuals()
      return
    }
    const prev = this.mode
    this.mode = mode
    if (mode === 'tertiary') {
      try {
        // Full worker idle — no engine.update / onUpdate (FPS). Meshes stay on host.
        this.system.setSceneWorkerOnUpdatePaused(true)
        this.system.setSceneWorkerTicksPaused(true)
      } catch {
        /* ignore */
      }
      this.freezeAnimators(true)
      this.applyModeVisuals()
      console.info(
        `[multi-scene] resident “${this.scene.title}” ${prev}→tertiary (scripts off, meshes stay, LOD)`
      )
    } else {
      try {
        this.system.setSceneWorkerTicksPaused(false)
        this.system.setSceneWorkerOnUpdatePaused(false)
      } catch {
        /* ignore */
      }
      this.freezeAnimators(false)
      this.applyModeVisuals()
      // Scripts already compiled — just resume ticks (no prepare/start, no GLB reload).
      console.info(
        `[multi-scene] resident “${this.scene.title}” ${prev}→secondary (scripts on, no GLB reload)`
      )
    }
  }

  private applyModeVisuals(): void {
    const root = this.system.getEntityStore()?.root
    if (!root) return
    // Continuity: demoted primary must stay visible and parented on the host.
    root.visible = true
    root.name =
      this.mode === 'tertiary'
        ? `secondary-tertiary:${this.id.slice(0, 16)}`
        : `secondary-entities:${this.id.slice(0, 16)}`
    // Never freeze matrices on tertiary — demote retarget must re-place the graph without
    // leaving GLBs in the sky (matrixAutoUpdate false after parent move = wrong world pose).
    root.matrixAutoUpdate = true
    const tertiary = this.mode === 'tertiary'
    // Tertiary LOD: no cast shadows + hide local lights (GPU). Scripts already paused.
    // Never force castShadow=true for secondary. Never force matrixAutoUpdate=true on every
    // leaf — that undid MeshRenderer freeze for 10k-tile boards. Only ensure root can move.
    root.matrixAutoUpdate = true
    root.traverse((o) => {
      if (o === root) return
      const m = o as THREE.Mesh
      if (m.isMesh) {
        if (tertiary) m.castShadow = false
        m.receiveShadow = true
        m.frustumCulled = true
      }
      if ((o as THREE.Light).isLight) {
        const ud = o.userData as { _tertiaryLightWasVisible?: boolean }
        if (tertiary) {
          if (ud._tertiaryLightWasVisible === undefined) {
            ud._tertiaryLightWasVisible = o.visible
          }
          o.visible = false
        } else if (ud._tertiaryLightWasVisible !== undefined) {
          o.visible = ud._tertiaryLightWasVisible
          delete ud._tertiaryLightWasVisible
        }
      }
    })
    root.updateMatrixWorld(true)
    if (this.host.scene && root.parent !== this.host.scene) {
      this.host.scene.add(root)
    }
  }

  private freezeAnimators(freeze: boolean): void {
    try {
      this.system.setAnimatorsAllSleeping(freeze)
    } catch {
      /* optional during teardown */
    }
  }

  async start(): Promise<void> {
    if (this.disposed || this.detached) return
    const { scene, cache, host, performanceTier, poseProvider } = this.opts

    // Demoted primary — already booted; strip privilege and keep mesh graph resident.
    if (this.adopted) {
      this.system.setPerformanceTier(performanceTier)
      this.system.setClientPoseProvider(poseProvider)
      this.wireSecondaryHandlers()
      this.system.setFocusPolicy('secondary')
      this.system.setCollidersCookCallback(null)
      this.system.setCollidersPoseCallback(null)
      this.system.setCollidersRemoveCallback(null)
      // Offset FIRST (while matrices still free), then LOD mode may freeze descendants.
      this.applySceneOriginOffset()
      const root = this.system.getEntityStore()?.root
      if (root) {
        root.visible = true
        if (this.host.scene && root.parent !== this.host.scene) {
          this.host.scene.add(root)
        }
      }
      this.running = true
      this.lastTickAt = performance.now()
      // Primary→secondary: keep existing PhysX (World rekeys native→offset + pose-slides).
      // Do NOT syncCollisionForce — that re-extracts and multi-shape expands (CBD thrash).
      this.captureRemappedColliders()
      // Apply initial mode (sticky demote = secondary; tertiary only via ring/cap later).
      this.setResidentMode(this.mode)
      // Re-bake origin after mode visuals, then refresh desc matrices for pose-slide.
      this.applySceneOriginOffset()
      if (this.mode !== 'tertiary') {
        this.captureRemappedColliders()
      }
      console.info(
        `[multi-scene] demoted primary → resident “${scene.title}” mode=${this.mode} ` +
          `base=${scene.baseParcel} vs primary=${this.primaryBaseParcel || '?'} ` +
          `rootPos=(${root?.position.x.toFixed(1) ?? '?'},${root?.position.z.toFixed(1) ?? '?'}) ` +
          `colliders=${this.lastRemappedColliders.length} (rekey+pose, no recook)`
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

    // Secondary/PE boots share AssetCache with primary. configureSceneContent is global —
    // SecondaryLiveManager restores primary content map in finally after start.
    cache.setScene(scene)
    this.system.prepare(scene, cache, host, {
      rootName,
      uiRootId: this.kind === 'pe' ? 'pe-ui-root' : `secondary-ui:${this.id.slice(0, 16)}`,
      uiDetached: this.kind === 'secondary',
      focusPolicy: this.kind === 'pe' ? 'pe' : 'secondary'
    })

    if (this.kind === 'pe') {
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
    this.system.syncCollisionForce()
    this.applySceneOriginOffset()
    // Snapshot remapped colliders once at boot so dirty-once PhysX stream has content.
    // (Without this, secondary never sets collidersDirty after dirty-once FPS guard.)
    try {
      this.captureRemappedColliders()
    } catch {
      /* optional during partial hydrate */
    }
    this.running = true
    this.lastTickAt = performance.now()
    if (this.kind === 'secondary') {
      this.setResidentMode(this.mode)
    }
    console.info(
      `[multi-scene] started ${this.kind} “${scene.title}” id=${this.id.slice(0, 20)}… ` +
        `mode=${this.mode} physOffset=${this.physOffset}` +
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

    this.system.setChangeRealmHandler(() => {
      console.info('[pe] changeRealm ignored (deprecated)')
      return false
    })

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
    // Tertiary: meshes only — no script onUpdate (worker paused + skip local pump).
    if (this.mode === 'tertiary') {
      this.lastTickAt = performance.now()
      return false
    }
    const now = performance.now()
    if (now - this.lastTickAt < minIntervalMs) return false
    this.lastTickAt = now
    this.system.syncClientEntities(player, camera)
    if (this.kind === 'pe') {
      this.system.updateTriggerAreas()
    }
    this.system.tickPlayFrame()
    return true
  }

  /**
   * Dirty collider push only — no renderer/bridges.
   * Used when this slot is not selected for a full async tick this frame.
   */
  takeDirtyCollidersOnly(): PhysicsColliderDesc[] {
    if (!this.running || this.disposed || this.detached) return []
    if (!this.collidersDirty || this.lastRemappedColliders.length === 0) return []
    this.collidersDirty = false
    return this.lastRemappedColliders
  }

  async tickAsync(
    primaryScene: ResolvedScene | null,
    cache: AssetCache,
    options?: { fullWork?: boolean; deadlineMs?: number }
  ): Promise<PhysicsColliderDesc[]> {
    if (!this.running || this.disposed || this.detached) return []
    // Tertiary: scripts off — only re-push colliders when dirty (demote/retarget once).
    // Returning hundreds of descs every frame was 2–3fps death with freezeRemoval still cooking.
    if (this.mode === 'tertiary') {
      return this.takeDirtyCollidersOnly()
    }

    // Secondary scripts run on tickSync every frame; full renderer/bridges can stagger.
    // When not selected this frame, still push dirty colliders (boot/demote/structure).
    if (options?.fullWork === false) {
      return this.takeDirtyCollidersOnly()
    }

    cache.setScene(this.scene)
    try {
      // COD F2 — residual wall budget; structure leftover stays in pendingDiff.
      await this.system.syncRenderer(
        options?.deadlineMs !== undefined ? { deadlineMs: options.deadlineMs } : undefined
      )
      let structureOrPoseChanged = false
      if (this.system.hasColliderWorkPending()) {
        this.system.syncCollision()
        structureOrPoseChanged = true
      }
      await this.system.syncAsyncBridges()

      // Dirty-once PhysX stream — re-capturing + syncStaticColliders every frame for
      // every secondary was multi-second "bridges=" death (hundreds of actors × N neighbors).
      if (structureOrPoseChanged) {
        this.captureRemappedColliders()
      }
      if (!this.collidersDirty || this.lastRemappedColliders.length === 0) return []
      this.collidersDirty = false
      return this.lastRemappedColliders
    } finally {
      if (primaryScene) cache.setScene(primaryScene)
    }
  }

  /**
   * Build/refresh remapped collider descs under this slot's phys offset.
   * Marks dirty so the next multi-scene tick pushes once into PhysX.
   */
  captureRemappedColliders(): PhysicsColliderDesc[] {
    if (this.disposed || this.detached) return this.lastRemappedColliders
    const raw = this.system.getAllPhysicsColliderDescs()
    // Transient empty extract (hydrate race / secondary tick mid-graph) must NOT wipe
    // registeredPhysIds — MultiSceneRuntime treats missing ids as PhysX invalidations
    // (immediate removeStatic) → soft world until recook.
    if (raw.length === 0 && this.lastRemappedColliders.length > 0) {
      return this.lastRemappedColliders
    }
    const out: PhysicsColliderDesc[] = []
    this.registeredPhysIds.clear()
    for (const d of raw) {
      const entity = d.entity + this.physOffset
      this.registeredPhysIds.add(entity)
      // Keep the original geometry fingerprint — PhysX geometryCache keys off it.
      // Prefixing `ms:…` forced full plaza recooks on every demote/promote (3fps).
      out.push({
        ...d,
        entity
      })
    }
    this.lastRemappedColliders = out
    this.collidersDirty = out.length > 0
    return out
  }

  /** @deprecated prefer captureRemappedColliders / lastRemapped snapshot */
  collectRemappedColliders(): PhysicsColliderDesc[] {
    if (this.mode === 'tertiary') return this.lastRemappedColliders
    return this.captureRemappedColliders()
  }

  /** Cached colliders for immediate World PhysX sync after demote (before next tick). */
  getCachedRemappedColliders(): readonly PhysicsColliderDesc[] {
    return this.lastRemappedColliders
  }

  /** After World consumes the dirty push — don't re-stream every frame. */
  markCollidersSynced(): void {
    this.collidersDirty = false
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
    // Ensure scripts unpaused for primary life (was tertiary or secondary).
    try {
      this.system.setSceneWorkerTicksPaused(false)
      this.system.setSceneWorkerOnUpdatePaused(false)
    } catch {
      /* ignore */
    }
    this.freezeAnimators(false)
    this.system.setMovePlayerHandler(null)
    this.system.setTeleportToHandler(null)
    this.system.setChangeRealmHandler(null)
    this.system.setOpenExternalUrlHandler(null)
    this.system.setTriggerEmoteHandler(null)
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
