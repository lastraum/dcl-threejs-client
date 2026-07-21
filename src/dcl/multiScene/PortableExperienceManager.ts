import type { EntityPose } from '../../bridge/ReservedEntitiesSync'
import type { AssetCache } from '../../rendering/AssetCache'
import type { SceneHost } from '../../rendering/SceneHost'
import type { PerformanceTier } from '../../shim/types'
import type { ResolvedScene } from '../content/types'
import { showPeConsentModal } from './peConsentModal'
import type { PhysicsColliderDesc } from '../../physics/PhysXWorld'
import { peLiveCap, peTickIntervalMs } from './caps'
import type { PrivilegedIntentArbiter } from './PrivilegedIntentArbiter'
import { pePhysOffset } from './physOffsets'
import { discoverEquippedPortableExperiences } from './resolveSmartWearablePe'
import type { PortableExperiencesPolicy } from './resolvePortableExperiences'
import { SceneWorkerSlot } from './SceneWorkerSlot'
import type { PeCandidate, PeSlotState } from './types'

export type PeManagerListener = (slots: PeSlotState[]) => void

/**
 * Session-scoped PE / smart-wearable manager.
 * - Does not auto-start; consent popup + HUD enable only.
 * - wantEnabled survives World rebuild (/goto); workers rebind to new host.
 * - Disable = full unload of worker + meshes.
 * - Per-PE UI toggle independent of enable.
 */
export class PortableExperienceManager {
  private readonly slots = new Map<string, PeSlotState>()
  private readonly scenes = new Map<string, ResolvedScene>()
  private readonly workers = new Map<string, SceneWorkerSlot>()
  private readonly booting = new Set<string>()
  private listeners = new Set<PeManagerListener>()
  private disposed = false
  private worldBound = false
  private tier: PerformanceTier = 'high'
  private primaryScene: ResolvedScene | null = null
  private pePolicy: PortableExperiencesPolicy = {
    allowed: true,
    uiAllowed: true,
    raw: 'default'
  }
  private cache: AssetCache | null = null
  private host: SceneHost | null = null
  private arbiter: PrivilegedIntentArbiter | null = null
  private poseProvider: (() => { player: EntityPose; camera: EntityPose }) | null = null
  private consentShownThisSession = false
  private discoveryInFlight = false
  private nextPeIndex = 0
  /** Phys ids to invalidate when a PE is fully unloaded. */
  private readonly pendingPhysInvalidation: number[] = []
  /** World wires player identity + pointer after PE boot (UI clicks / getPlayer). physOffset for collider remove. */
  private onPeWorkerReady:
    | ((
        system: import('../../core/systems/SceneScriptSystem').SceneScriptSystem,
        physOffset: number
      ) => void)
    | null = null

  subscribe(fn: PeManagerListener): () => void {
    this.listeners.add(fn)
    fn(this.listSlots())
    return () => this.listeners.delete(fn)
  }

  private emit(): void {
    const list = this.listSlots()
    for (const fn of this.listeners) fn(list)
  }

  listSlots(): PeSlotState[] {
    return [...this.slots.values()].map((s) => ({
      ...s,
      candidate: { ...s.candidate }
    }))
  }

  runningCount(): number {
    return this.workers.size
  }

  /**
   * Bind to a live World host. Restores wantEnabled PEs without re-prompt.
   * Call after primary loadScene + start.
   */
  setOnPeWorkerReady(
    fn:
      | ((
          system: import('../../core/systems/SceneScriptSystem').SceneScriptSystem,
          physOffset: number
        ) => void)
      | null
  ): void {
    this.onPeWorkerReady = fn
  }

  async attachWorld(opts: {
    primaryScene: ResolvedScene
    cache: AssetCache
    host: SceneHost
    tier: PerformanceTier
    arbiter: PrivilegedIntentArbiter
    poseProvider: () => { player: EntityPose; camera: EntityPose }
    pePolicy: PortableExperiencesPolicy
  }): Promise<void> {
    this.primaryScene = opts.primaryScene
    this.cache = opts.cache
    this.host = opts.host
    this.tier = opts.tier
    this.arbiter = opts.arbiter
    this.poseProvider = opts.poseProvider
    this.pePolicy = opts.pePolicy
    this.worldBound = true

    if (!opts.pePolicy.allowed) {
      await this.blockAllForScene()
      return
    }

    // Unblock slots that were scene_blocked.
    for (const slot of this.slots.values()) {
      if (slot.status === 'scene_blocked') {
        slot.status = slot.wantEnabled ? 'available' : 'user_disabled'
      }
    }

    // Restore previously enabled PEs (no popup — session continuity across /goto).
    for (const slot of this.slots.values()) {
      if (slot.wantEnabled && slot.status !== 'running') {
        await this.enablePe(slot.candidate.id, { fromRestore: true })
      }
    }
    this.emit()
  }

  /**
   * World is going away. Dispose workers but keep wantEnabled + slot prefs
   * so /goto does not forget the PE or re-prompt.
   */
  detachWorld(): void {
    for (const [id, worker] of this.workers) {
      this.pendingPhysInvalidation.push(...worker.registeredPhysicsEntities())
      worker.dispose()
      this.workers.delete(id)
      const slot = this.slots.get(id)
      if (slot && slot.wantEnabled) {
        slot.status = 'available' // will restore on next attach
      } else if (slot) {
        slot.status = 'user_disabled'
      }
    }
    this.worldBound = false
    this.cache = null
    this.host = null
    this.poseProvider = null
    this.primaryScene = null
    this.emit()
  }

  async discoverFromWearables(
    wearables: string[],
    peerUrl: string,
    opts?: { bodyShape?: 'male' | 'female' }
  ): Promise<void> {
    if (this.disposed || this.discoveryInFlight) return
    this.discoveryInFlight = true
    try {
      console.info(`[pe] discoverFromWearables count=${wearables.length} peer=${peerUrl}`)
      const { candidates, scenes } = await discoverEquippedPortableExperiences(
        wearables,
        peerUrl,
        { bodyShape: opts?.bodyShape }
      )
      for (const [id, scene] of scenes) this.scenes.set(id, scene)

      const seen = new Set(candidates.map((c) => c.id))
      // Drop unequipped (not running restore targets that vanished).
      for (const [id, slot] of this.slots) {
        if (!seen.has(id)) {
          if (slot.status === 'running') await this.disablePe(id)
          this.slots.delete(id)
        }
      }
      for (const c of candidates) {
        if (!this.slots.has(c.id)) {
          this.slots.set(c.id, {
            candidate: c,
            status: 'available',
            uiEnabled: true,
            wantEnabled: false
          })
        } else {
          const s = this.slots.get(c.id)!
          s.candidate = c
          // Don't re-prompt if user already decided this session.
          if (s.status === 'user_disabled' || s.status === 'running' || s.wantEnabled) {
            /* keep status */
          } else if (s.status === 'prompted') {
            /* keep */
          } else {
            s.status = 'available'
          }
        }
      }
      this.emit()
    } finally {
      this.discoveryInFlight = false
    }
  }

  /**
   * After play-ready: Explorer-style activate-PEX modal (thumbnail + permissions).
   * NO / YES — never auto-starts. Remaining PEs stay available in HUD.
   */
  async maybeShowConsentPrompt(): Promise<void> {
    if (this.disposed || !this.worldBound || !this.pePolicy.allowed) return
    if (this.consentShownThisSession) return

    const pending = [...this.slots.values()].filter(
      (s) => !s.wantEnabled && s.status === 'available'
    )
    if (!pending.length) return

    this.consentShownThisSession = true
    for (const slot of pending) {
      slot.status = 'prompted'
    }
    this.emit()

    const first = pending[0]!
    // Ensure permissions array exists (older candidates).
    if (!first.candidate.permissions) first.candidate.permissions = []

    const ok = await showPeConsentModal({
      candidate: first.candidate,
      moreCount: Math.max(0, pending.length - 1)
    })

    if (ok) {
      await this.enablePe(first.candidate.id)
      for (const s of pending.slice(1)) {
        s.status = 'user_disabled'
        s.wantEnabled = false
      }
    } else {
      for (const s of pending) {
        s.status = 'user_disabled'
        s.wantEnabled = false
      }
    }
    this.emit()
  }

  async enablePe(id: string, opts?: { fromRestore?: boolean }): Promise<boolean> {
    if (this.disposed || !this.worldBound) return false
    if (!this.pePolicy.allowed) {
      console.info('[pe] enable blocked — scene disables portable experiences')
      return false
    }
    const slot = this.slots.get(id)
    const scene = this.scenes.get(id)
    if (!slot || !scene) return false
    if (this.workers.has(id) || this.booting.has(id)) return true

    const cap = peLiveCap(this.tier)
    if (this.workers.size >= cap) {
      console.warn(`[pe] cap reached (${cap}) — disable another PE first`)
      return false
    }
    if (!this.cache || !this.host || !this.arbiter || !this.poseProvider) return false

    this.booting.add(id)
    try {
      const peIndex = this.nextPeIndex++
      const worker = new SceneWorkerSlot({
        id,
        kind: 'pe',
        scene,
        cache: this.cache,
        host: this.host,
        performanceTier: this.tier,
        arbiter: this.arbiter,
        poseProvider: this.poseProvider,
        physOffset: pePhysOffset(peIndex)
      })
      await worker.start()
      if (this.disposed || !this.worldBound) {
        worker.dispose()
        return false
      }
      // Wire pointer + player identity so PE UI clicks and getPlayer() work.
      this.onPeWorkerReady?.(worker.system, worker.physOffset)
      // UI: user pref AND scene policy. (PE start already revealed UI for first mount paint.)
      const uiOn = slot.uiEnabled && this.pePolicy.uiAllowed
      worker.setUiVisible(uiOn)
      if (uiOn) {
        // One delayed force after onStart UI settles — avoid multi-timeout thrash (HUD flicker).
        const forcePeUi = (): void => {
          if (this.disposed || !this.workers.has(id)) return
          const w = this.workers.get(id)
          if (!w?.isRunning) return
          w.setUiVisible(true)
          w.system.forceSceneUiRepaint()
        }
        if (typeof window !== 'undefined') {
          window.setTimeout(forcePeUi, 120)
        } else {
          queueMicrotask(forcePeUi)
        }
      }
      this.workers.set(id, worker)
      slot.status = 'running'
      slot.wantEnabled = true
      if (this.primaryScene) this.cache.setScene(this.primaryScene)
      console.info(
        `[pe] enabled “${slot.candidate.title}”${opts?.fromRestore ? ' (restored after travel)' : ''} ui=${uiOn}`
      )
      this.emit()
      return true
    } catch (err) {
      console.warn(`[pe] enable failed “${slot.candidate.title}”`, err)
      if (this.primaryScene && this.cache) this.cache.setScene(this.primaryScene)
      slot.status = 'available'
      slot.wantEnabled = false
      this.emit()
      return false
    } finally {
      this.booting.delete(id)
    }
  }

  /** Full unload — worker, models, UI, colliders, everything. */
  async disablePe(id: string): Promise<void> {
    const worker = this.workers.get(id)
    if (worker) {
      this.pendingPhysInvalidation.push(...worker.registeredPhysicsEntities())
      worker.dispose()
      this.workers.delete(id)
    }
    const slot = this.slots.get(id)
    if (slot) {
      slot.status = 'user_disabled'
      slot.wantEnabled = false
      console.info(`[pe] disabled “${slot.candidate.title}” — full unload`)
    }
    if (this.primaryScene && this.cache) this.cache.setScene(this.primaryScene)
    this.emit()
  }

  /** Drain phys ids that need PhysX removal after PE disable/detach. */
  takePhysInvalidations(): number[] {
    const out = this.pendingPhysInvalidation.splice(0)
    return out
  }

  setPrimaryScene(scene: ResolvedScene): void {
    this.primaryScene = scene
  }

  setPeUiEnabled(id: string, enabled: boolean): void {
    const slot = this.slots.get(id)
    if (!slot) return
    slot.uiEnabled = enabled
    const worker = this.workers.get(id)
    if (worker) {
      const uiOn = enabled && this.pePolicy.uiAllowed && slot.status === 'running'
      worker.setUiVisible(uiOn)
      if (uiOn) worker.system.forceSceneUiRepaint()
    }
    this.emit()
  }

  private async blockAllForScene(): Promise<void> {
    for (const id of [...this.workers.keys()]) {
      const worker = this.workers.get(id)
      if (worker) {
        this.pendingPhysInvalidation.push(...worker.registeredPhysicsEntities())
        worker.dispose()
      }
      this.workers.delete(id)
    }
    for (const slot of this.slots.values()) {
      if (slot.wantEnabled || slot.status === 'running' || slot.status === 'available') {
        slot.status = 'scene_blocked'
      }
    }
    console.info('[pe] scene policy disabled portable experiences — unloaded all PE workers')
    this.emit()
  }

  /** Primary scene changed without full detach (rare). */
  applyScenePolicy(policy: PortableExperiencesPolicy): void {
    this.pePolicy = policy
    if (!policy.allowed) {
      void this.blockAllForScene()
      return
    }
    for (const [id, worker] of this.workers) {
      const slot = this.slots.get(id)
      if (!slot) continue
      worker.setUiVisible(slot.uiEnabled && policy.uiAllowed)
    }
    this.emit()
  }

  /** Running PE SceneScriptSystems (for InputModifier merge / identity). */
  getRunningSystems(): import('../../core/systems/SceneScriptSystem').SceneScriptSystem[] {
    return [...this.workers.values()]
      .filter((w) => w.isRunning)
      .map((w) => w.system)
  }

  /**
   * True when any running PE has InputModifier freezing avatar locomotion
   * (e.g. Neurolink drone mode — WASD drives the drone, not the capsule).
   */
  isAvatarLocomotionFrozenByPe(): boolean {
    const mod = this.getPePlayerInputModifier()
    if (!mod || typeof mod !== 'object') return false
    const mode = (mod as { mode?: { $case?: string; standard?: Record<string, boolean> } }).mode
    if (mode?.$case !== 'standard' || !mode.standard) return false
    const s = mode.standard
    if (s.disableAll) return true
    // Walk+jog+run all disabled (sit / vehicle style freeze)
    return !!(s.disableWalk && s.disableJog && s.disableRun)
  }

  /**
   * PE InputModifier on PlayerEntity from a running PE, or null.
   * Prefer any with disableAll so avatar freeze wins for drone/flight modes.
   */
  getPePlayerInputModifier(): unknown | null {
    let best: unknown | null = null
    for (const sys of this.getRunningSystems()) {
      try {
        const { InputModifier } = sys.readComponents
        const player = sys.view.PlayerEntity
        if (!InputModifier.has(player)) continue
        const mod = InputModifier.get(player) as {
          mode?: { $case?: string; standard?: { disableAll?: boolean } }
        }
        const std = mod.mode?.$case === 'standard' ? mod.mode.standard : undefined
        if (std?.disableAll) return mod
        if (!best) best = mod
      } catch {
        /* ignore */
      }
    }
    return best
  }

  tickSync(player: EntityPose, camera: EntityPose, frame = 0): void {
    const interval = peTickIntervalMs(this.tier)
    for (const worker of this.workers.values()) {
      // Keyboard is InputHub → PE subscriber (World.inputHub.sync once per frame).
      worker.tickSync(player, camera, interval)
      // PE UI pointer inject (clicks) — primary loop alone never ticks PE PointerEventsSystem.
      worker.system.updatePointerEvents(frame)
      worker.system.syncPointerInput(frame, {
        processPendingDown: true,
        processPendingUp: true
      })
    }
  }

  async tickAsync(): Promise<PhysicsColliderDesc[]> {
    if (!this.cache) return []
    const descs: PhysicsColliderDesc[] = []
    for (const worker of this.workers.values()) {
      descs.push(...(await worker.tickAsync(this.primaryScene, this.cache)))
    }
    return descs
  }

  dispose(): void {
    this.disposed = true
    for (const w of this.workers.values()) w.dispose()
    this.workers.clear()
    this.slots.clear()
    this.scenes.clear()
    this.listeners.clear()
  }
}

/** Register a candidate manually (tests / future non-wearable PE). */
export function ensurePeCandidate(manager: PortableExperienceManager, c: PeCandidate): void {
  void manager
  void c
}
