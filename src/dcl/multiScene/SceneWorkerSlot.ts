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
  /** Initial resident mode (default secondary). Large demotes often start tertiary. */
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
  /** Phys ids we registered (with offset) — invalidate on dispose. */
  private readonly registeredPhysIds = new Set<number>()
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
    if (this.mode === 'secondary') {
      try {
        this.system.syncCollisionForce()
      } catch {
        /* ignore during teardown */
      }
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
    root.visible = true
    root.name =
      this.mode === 'tertiary'
        ? `secondary-tertiary:${this.id.slice(0, 16)}`
        : `secondary-entities:${this.id.slice(0, 16)}`
    const tertiary = this.mode === 'tertiary'
    // Tertiary LOD: no shadows, kill local lights, freeze matrices (static shell).
    root.traverse((o) => {
      const m = o as THREE.Mesh
      if (m.isMesh) {
        m.castShadow = !tertiary
        m.receiveShadow = !tertiary
        m.frustumCulled = true
      }
      const light = o as THREE.Light
      if ((light as THREE.Light).isLight) {
        // Stash prior visibility so secondary resume restores correctly.
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
      if (tertiary) {
        o.updateMatrixWorld(true)
        o.matrixAutoUpdate = false
      } else {
        o.matrixAutoUpdate = true
      }
    })
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
      this.applySceneOriginOffset()
      this.running = true
      this.lastTickAt = performance.now()
      // Apply initial mode (large demotes often tertiary for FPS).
      this.setResidentMode(this.mode)
      console.info(
        `[multi-scene] demoted primary → resident “${scene.title}” mode=${this.mode} ` +
          `origin→${this.primaryBaseParcel || 'pending'}`
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

  async tickAsync(
    primaryScene: ResolvedScene | null,
    cache: AssetCache
  ): Promise<PhysicsColliderDesc[]> {
    if (!this.running || this.disposed || this.detached) return []
    // Tertiary: no projection thrash; keep last collider map if any.
    if (this.mode === 'tertiary') {
      return this.collectRemappedColliders()
    }
    cache.setScene(this.scene)
    try {
      await this.system.syncRenderer()
      if (this.system.hasColliderWorkPending()) {
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
    if (this.mode === 'tertiary') {
      // Keep previously registered phys ids; avoid re-cook storm for LOD shells.
      return []
    }
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
