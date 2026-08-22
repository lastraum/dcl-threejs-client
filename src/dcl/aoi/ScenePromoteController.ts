import type { RouteTarget } from '../content/route'
import type { ResolvedScene } from '../content/types'
import { parseParcelKey } from '../content/parseParcel'
import { PARCEL_SIZE } from '../content/types'
import { fetchSceneEntityByPointer } from '../../network/catalyst/CatalystClient'
import { renderQuality } from '../../rendering/RenderQualitySettings'
import { distanceToParcelCenterM } from './parcelAoi'
import {
  fetchActiveEntitiesForPointers,
  isOpenRoadEntity,
  type ActiveSceneEntity
} from './fetchActiveEntities'
import { aoiStandOnPromote } from '../multiScene/caps'

/**
 * Dense Genesis (CBD) can have 30–50+ SDK7 scenes inside Scene Distance.
 * Queueing all of them in one scan (resolve + IDB GLB prefetch) starves the
 * primary worker → 2–5 fps thrash. Nearest-first trickle; later scans continue.
 */
const MAX_SCRIPT_WARM_PER_SCAN = 3

export type PromoteCoordsTarget = Extract<RouteTarget, { kind: 'coords' }>

export type ScenePromoteControllerOptions = {
  /** Full primary swap (seamless jump) — only for real promotable SDK7 scenes. */
  onPromote: (target: PromoteCoordsTarget, reason: string) => void
  /**
   * Soft URL / HUD only (replaceState) — empty land, roads, and every parcel under feet.
   * Never reloads the world.
   */
  onSoftRoute?: (x: number, y: number) => void
  /**
   * Warm script/manifest assets for real scenes in Scene Distance warm band.
   */
  onPrefetch?: (x: number, y: number) => void
  dwellMs?: number
  cooldownMs?: number
  /**
   * Override warm radius (meters). Default: live Scene Distance setting.
   * Pass a getter via constructor when testing.
   */
  scriptWarmRadiusM?: number | (() => number)
}

/**
 * Multi-scene Phase B — Scene Distance warm band + stand-on-parcel primary promotion.
 *
 * - **Warm band** (Scene Distance → AoiVisualLayer + this controller): visuals +
 *   batch catalyst lookup → prefetch real SDK7 manifests (Angzaar etc.).
 * - Soft-updates the SPA URL as you walk (no reload).
 * - Full promote only when dwelling on a **real SDK7 scene** that is not primary.
 * - Empty land and roads never trigger a scene reload (that was thrashing promote).
 * - After handoff the under-feet deployment is FocusOwner (origin + LiveKit + UI).
 */
type PendingWarmEntry = {
  entityId: string
  title: string
  baseX: number
  baseY: number
  /**
   * Footprint size for ranking. Covers any multi-parcel scene deployment
   * (scene.json parcels[]) and formal estates — both are one catalyst entity.
   */
  parcelCount: number
  /** Last known min distance to player (m). */
  distM: number
}

export class ScenePromoteController {
  private primary: ResolvedScene | null = null
  private readonly primaryParcels = new Set<string>()
  /** Parcels we already classified as empty/road — no re-fetch spam / no promote thrash. */
  private readonly skipPromoteKeys = new Set<string>()
  /**
   * Catalyst scene entity ids already queued for script warm.
   * One id per deployment — multi-parcel scene.json and estates alike (not per parcel).
   */
  private readonly warmedEntityIds = new Set<string>()
  /**
   * Parcels covered by a known catalyst entity (primary, warmed, deferred, road, etc.).
   * After first discovery, cover the entity's full pointer/parcel footprint so we never
   * re-query or warm parcel-by-parcel for the same multi-parcel deployment.
   */
  private readonly coveredEntityParcels = new Set<string>()
  /** Discovered warmable entities not yet prefetched (budget deferred). */
  private readonly pendingWarm = new Map<string, PendingWarmEntry>()
  private dwellKey = ''
  private dwellSince = 0
  private lastPromoteAt = 0
  private lastSoftKey = ''
  private lastWarmScanAt = 0
  private warmScanInFlight = false
  private inFlight = false
  private evalGen = 0
  /** When false, skip warm scan + promote evaluate (primary still booting). */
  private neighborActivityEnabled = false
  private readonly onPromote: ScenePromoteControllerOptions['onPromote']
  private readonly onSoftRoute: ScenePromoteControllerOptions['onSoftRoute']
  private readonly onPrefetch: ScenePromoteControllerOptions['onPrefetch']
  private readonly dwellMs: number
  private readonly cooldownMs: number
  private readonly scriptWarmRadiusOpt: number | (() => number) | undefined

  constructor(opts: ScenePromoteControllerOptions) {
    this.onPromote = opts.onPromote
    this.onSoftRoute = opts.onSoftRoute
    this.onPrefetch = opts.onPrefetch
    this.dwellMs = opts.dwellMs ?? 320
    this.cooldownMs = opts.cooldownMs ?? 2_000
    this.scriptWarmRadiusOpt = opts.scriptWarmRadiusM
  }

  /** Live warm radius — tracks Preferences Scene Distance unless overridden. */
  private getScriptWarmRadiusM(): number {
    if (typeof this.scriptWarmRadiusOpt === 'function') return this.scriptWarmRadiusOpt()
    if (typeof this.scriptWarmRadiusOpt === 'number') return this.scriptWarmRadiusOpt
    return renderQuality.getSceneLoadRadiusM()
  }

  /**
   * Remember full deployment footprint (entity.pointers ∪ scene.parcels) so parcel-ring
   * scans never re-load the same multi-parcel scene or estate.
   */
  private coverEntityParcels(keys: readonly string[]): void {
    for (const p of keys) {
      const k = p.trim()
      if (k) this.coveredEntityParcels.add(k)
    }
  }

  /**
   * Catalyst active entity footprint: prefer content-server pointers (authoritative for
   * multi-parcel deployments), else metadata scene.parcels.
   */
  private entityKeys(ent: ActiveSceneEntity): string[] {
    const raw = ent.pointers.length ? ent.pointers : ent.parcels
    return raw.map((p) => p.trim()).filter(Boolean)
  }

  bind(scene: ResolvedScene): void {
    this.primary = scene
    this.primaryParcels.clear()
    this.skipPromoteKeys.clear()
    this.warmedEntityIds.clear()
    this.coveredEntityParcels.clear()
    this.pendingWarm.clear()
    for (const p of scene.parcels) this.primaryParcels.add(p.trim())
    this.primaryParcels.add(scene.baseParcel.trim())
    // Whole multi-parcel primary deployment is already loaded — never AOI-warm it again.
    this.coverEntityParcels([...this.primaryParcels])
    if (scene.entityId) this.warmedEntityIds.add(scene.entityId)
    this.dwellKey = ''
    this.dwellSince = 0
    this.inFlight = false
    this.warmScanInFlight = false
    this.neighborActivityEnabled = false
    this.lastSoftKey = ''
    this.lastWarmScanAt = 0
    // Restart dwell cooldown so origin-rebase feet on the next cell of this
    // same deployment cannot evaluate+force-boot before occupancy is folded.
    this.lastPromoteAt = performance.now()
    this.evalGen++
    console.info(
      `[promote] bound primary “${scene.title}” base=${scene.baseParcel} parcels=${this.primaryParcels.size} entity=${scene.entityId?.slice(0, 12) ?? 'none'} scriptWarm=${this.getScriptWarmRadiusM()}m (warm deferred until play-ready)`
    )
  }

  unbind(): void {
    this.primary = null
    this.primaryParcels.clear()
    this.skipPromoteKeys.clear()
    this.warmedEntityIds.clear()
    this.coveredEntityParcels.clear()
    this.pendingWarm.clear()
    this.dwellKey = ''
    this.inFlight = false
    this.warmScanInFlight = false
    this.neighborActivityEnabled = false
    this.evalGen++
  }

  setNeighborActivityEnabled(enabled: boolean): void {
    this.neighborActivityEnabled = enabled
  }

  /**
   * Fold a cell into the bound primary footprint (origin-rebase feet, handoff
   * target). `ResolvedScene.parcels` can miss non-base cells.
   */
  coverPrimaryParcel(key: string): void {
    const k = key.trim()
    if (!k) return
    this.primaryParcels.add(k)
    this.coveredEntityParcels.add(k)
  }

  /**
   * Per-frame — scene-local DCL feet.
   * Soft-routes URL every parcel; warms scripts in the inner radius;
   * full promote only for foreign SDK7 scenes under feet.
   */
  tick(dclX: number, dclZ: number): void {
    const scene = this.primary
    if (!scene || scene.source.kind !== 'coords') return

    const base = parseParcelKey(scene.baseParcel)
    const px = base.x + Math.floor(dclX / PARCEL_SIZE)
    const py = base.y + Math.floor(dclZ / PARCEL_SIZE)
    if (!Number.isFinite(px) || !Number.isFinite(py)) return
    const key = `${px},${py}`

    // Always keep the address bar + HUD on the parcel under your feet (SPA only).
    if (key !== this.lastSoftKey && !this.inFlight) {
      this.lastSoftKey = key
      this.onSoftRoute?.(px, py)
      console.info(`[promote] soft-route ${key}`)
    }

    if (!this.neighborActivityEnabled) return

    // Warm band: batch-warm nearby real SDK7 scenes (not per-parcel road spam).
    this.scheduleScriptWarmScan(dclX, dclZ, scene.baseParcel)

    if (this.inFlight) return

    const now = performance.now()
    if (now - this.lastPromoteAt < this.cooldownMs) return

    // Still on primary footprint — no promote (warm still ran above).
    if (this.primaryParcels.has(key)) {
      this.dwellKey = ''
      return
    }

    // Empty / road already classified — soft URL only.
    if (this.skipPromoteKeys.has(key)) {
      this.dwellKey = ''
      return
    }

    // Stand-on promote is a separate flag (implies live guests). Soft URL still runs.
    if (!aoiStandOnPromote()) {
      this.dwellKey = ''
      return
    }

    if (key !== this.dwellKey) {
      this.dwellKey = key
      this.dwellSince = now
      return
    }

    if (now - this.dwellSince < this.dwellMs) return

    void this.evaluate(px, py, key)
  }

  /**
   * Throttled kick — actual work is async batch catalyst /entities/active.
   * Roads/empty are classified and skipped; only real SDK7 scenes get onPrefetch.
   */
  private scheduleScriptWarmScan(dclX: number, dclZ: number, baseParcel: string): void {
    // Live guests boot from AoiVisualLayer + SceneLoop. This scan is leftover
    // promote prefetch (extra catalyst POST + IDB) and is not the guest clock.
    if (!aoiStandOnPromote()) return
    if (!this.onPrefetch || this.getScriptWarmRadiusM() <= 0) return
    if (this.warmScanInFlight) return
    const now = performance.now()
    if (now - this.lastWarmScanAt < 1_200) return
    this.lastWarmScanAt = now
    void this.runScriptWarmScan(dclX, dclZ, baseParcel)
  }

  private async runScriptWarmScan(
    dclX: number,
    dclZ: number,
    baseParcel: string
  ): Promise<void> {
    const scene = this.primary
    if (!scene || !this.onPrefetch) return
    this.warmScanInFlight = true
    const gen = this.evalGen
    const scriptWarmRadiusM = this.getScriptWarmRadiusM()

    try {
      // 1) Drain deferred multi-parcel deployments first (already discovered by entity id).
      let warmed = this.drainPendingWarm(dclX, dclZ, baseParcel, MAX_SCRIPT_WARM_PER_SCAN)
      let budgetLeft = MAX_SCRIPT_WARM_PER_SCAN - warmed

      const ring = Math.max(1, Math.ceil(scriptWarmRadiusM / PARCEL_SIZE) + 1)
      const center = {
        x: parseParcelKey(baseParcel).x + Math.floor(dclX / PARCEL_SIZE),
        y: parseParcelKey(baseParcel).y + Math.floor(dclZ / PARCEL_SIZE)
      }

      // 2) Only query parcels not already owned by a known deployment / primary / empty/road.
      const pointers: string[] = []
      let skippedCovered = 0
      for (let dx = -ring; dx <= ring; dx++) {
        for (let dy = -ring; dy <= ring; dy++) {
          const parcel = { x: center.x + dx, y: center.y + dy }
          const key = `${parcel.x},${parcel.y}`
          if (this.primaryParcels.has(key)) continue
          if (this.skipPromoteKeys.has(key)) continue
          if (this.coveredEntityParcels.has(key)) {
            skippedCovered++
            continue
          }
          const dist = distanceToParcelCenterM(dclX, dclZ, parcel, baseParcel)
          if (dist > scriptWarmRadiusM) continue
          pointers.push(key)
        }
      }

      let skippedRoad = 0
      let skippedOther = 0
      let entitiesLen = 0
      let deferredWarm = this.pendingWarm.size

      if (pointers.length && budgetLeft > 0) {
        const entities = await fetchActiveEntitiesForPointers(
          scene.realm.contentUrl,
          pointers
        )
        if (gen !== this.evalGen || this.primary !== scene) return
        entitiesLen = entities.length

        const owned = new Set<string>()

        // Prefer nearest / smaller footprints first so huge multi-parcel deploys don't starve neighbors.
        const ranked = [...entities].sort((a, b) => {
          const da = minEntityDistanceM(a, dclX, dclZ, baseParcel)
          const db = minEntityDistanceM(b, dclX, dclZ, baseParcel)
          if (da !== db) return da - db
          const pa = (a.parcels.length || a.pointers.length) || 999
          const pb = (b.parcels.length || b.pointers.length) || 999
          return pa - pb
        })

        for (const ent of ranked) {
          const keys = this.entityKeys(ent)
          for (const p of keys) owned.add(p)
          // Always cover full footprint once — multi-parcel deployment loads once, not per parcel.
          this.coverEntityParcels(keys)

          if (this.warmedEntityIds.has(ent.id)) {
            this.pendingWarm.delete(ent.id)
            continue
          }
          if (scene.entityId && ent.id === scene.entityId) {
            this.warmedEntityIds.add(ent.id)
            this.pendingWarm.delete(ent.id)
            continue
          }

          if (isOpenRoadEntity(ent) || !isScriptWarmCandidate(ent)) {
            for (const p of keys) this.skipPromoteKeys.add(p)
            this.pendingWarm.delete(ent.id)
            if (isOpenRoadEntity(ent)) skippedRoad++
            else skippedOther++
            continue
          }

          // Only warm if at least one footprint parcel is inside the ring we queried.
          const inRing = keys.some((p) => pointers.includes(p))
          if (!inRing) continue

          const base = parseParcelKey(ent.base)
          if (!Number.isFinite(base.x) || !Number.isFinite(base.y)) continue

          const distM = minEntityDistanceM(ent, dclX, dclZ, baseParcel)
          const entry: PendingWarmEntry = {
            entityId: ent.id,
            title: ent.title || ent.base,
            baseX: base.x,
            baseY: base.y,
            parcelCount: keys.length,
            distM
          }

          if (budgetLeft <= 0) {
            this.pendingWarm.set(ent.id, entry)
            continue
          }

          this.queueWarm(entry)
          warmed++
          budgetLeft--
        }

        // Pointers with no catalyst entity → empty land (don't re-query every scan).
        for (const p of pointers) {
          if (!owned.has(p)) this.skipPromoteKeys.add(p)
        }
      }

      deferredWarm = this.pendingWarm.size

      if (warmed > 0 || skippedRoad > 0 || deferredWarm > 0 || skippedCovered > 0) {
        console.info(
          `[promote] script-warm scan feet=${center.x},${center.y} ring=${pointers.length}` +
            ` coveredSkip=${skippedCovered} entities=${entitiesLen} warmed=${warmed}/${MAX_SCRIPT_WARM_PER_SCAN}` +
            (deferredWarm > 0 ? ` deferred=${deferredWarm}` : '') +
            ` roads=${skippedRoad} otherSkip=${skippedOther}`
        )
      }
    } catch (err) {
      console.warn('[promote] script-warm scan failed', err)
    } finally {
      this.warmScanInFlight = false
    }
  }

  /** Fire prefetch for one catalyst scene entity — never per-parcel. */
  private queueWarm(entry: PendingWarmEntry): void {
    if (this.warmedEntityIds.has(entry.entityId)) {
      this.pendingWarm.delete(entry.entityId)
      return
    }
    this.warmedEntityIds.add(entry.entityId)
    this.pendingWarm.delete(entry.entityId)
    console.info(
      `[promote] script-warm queue “${entry.title}” base=${entry.baseX},${entry.baseY}` +
        ` parcels=${entry.parcelCount} dist≈${entry.distM.toFixed(0)}m`
    )
    this.onPrefetch?.(entry.baseX, entry.baseY)
  }

  /** Prefetch nearest pending multi-parcel deployments without re-querying their parcels. */
  private drainPendingWarm(
    dclX: number,
    dclZ: number,
    baseParcel: string,
    max: number
  ): number {
    if (!this.onPrefetch || max <= 0 || this.pendingWarm.size === 0) return 0

    // Refresh distances for ranking (player may have moved).
    const ranked = [...this.pendingWarm.values()]
      .map((e) => {
        try {
          const d = distanceToParcelCenterM(
            dclX,
            dclZ,
            { x: e.baseX, y: e.baseY },
            baseParcel
          )
          return { ...e, distM: d }
        } catch {
          return e
        }
      })
      .sort((a, b) => a.distM - b.distM || a.parcelCount - b.parcelCount)

    let n = 0
    for (const entry of ranked) {
      if (n >= max) break
      if (this.warmedEntityIds.has(entry.entityId)) {
        this.pendingWarm.delete(entry.entityId)
        continue
      }
      this.queueWarm(entry)
      n++
    }
    return n
  }

  private async evaluate(px: number, py: number, key: string): Promise<void> {
    const scene = this.primary
    if (!scene || this.inFlight) return
    if (this.dwellKey !== key) return

    const gen = ++this.evalGen
    this.inFlight = true

    try {
      const hit = await fetchSceneEntityByPointer(scene.realm.contentUrl, key)
      if (gen !== this.evalGen || this.primary !== scene) return

      if (!hit) {
        // Empty land — do NOT reload primary (was thrashing seamless jumps).
        this.skipPromoteKeys.add(key)
        this.dwellKey = ''
        this.inFlight = false
        this.onSoftRoute?.(px, py)
        return
      }

      if (isNonPromotableEntity(hit.entity)) {
        // Roads / SDK6 — stay on current primary.
        this.skipPromoteKeys.add(key)
        this.dwellKey = ''
        this.inFlight = false
        this.onSoftRoute?.(px, py)
        return
      }

      if (hit.id && scene.entityId && hit.id === scene.entityId) {
        // Multi-parcel primary: fold this parcel into primary footprint (no re-load).
        this.primaryParcels.add(key)
        this.coveredEntityParcels.add(key)
        this.dwellKey = ''
        this.inFlight = false
        return
      }

      // Real SDK7 (or composite) scene — seamless promote to primary.
      const title =
        typeof (hit.entity.metadata as { display?: { title?: string } } | undefined)?.display
          ?.title === 'string'
          ? (hit.entity.metadata as { display: { title: string } }).display.title
          : hit.id.slice(0, 12)
      this.fire(px, py, `scene:${title}`)
    } catch (err) {
      console.warn('[promote] evaluate failed', key, err)
      this.inFlight = false
    }
  }

  private fire(x: number, y: number, reason: string): void {
    this.lastPromoteAt = performance.now()
    this.dwellKey = ''
    console.info(`[promote] → primary ${x},${y} (${reason})`)
    this.onPromote({ kind: 'coords', x, y, segment: `${x},${y}` }, reason)
    window.setTimeout(() => {
      if (this.inFlight) this.inFlight = false
    }, this.cooldownMs + 800)
  }
}

/** Real SDK7 scene worth warming scripts/manifests for (not roads). */
function isScriptWarmCandidate(ent: ActiveSceneEntity): boolean {
  if (isOpenRoadEntity(ent)) return false
  const rv = ent.runtimeVersion
  if (rv === '7' || rv.startsWith('7.')) return true
  const main = ent.main.toLowerCase()
  if (main.includes('bin/index.js') || main.endsWith('/index.js')) return true
  // Composite-only estates (still have a main entry usually)
  if (main && !main.endsWith('game.js') && !main.includes('/game.js')) return true
  return false
}

function minEntityDistanceM(
  ent: ActiveSceneEntity,
  dclX: number,
  dclZ: number,
  baseParcel: string
): number {
  const keys = ent.pointers.length ? ent.pointers : ent.parcels
  let best = Infinity
  for (const key of keys) {
    try {
      const p = parseParcelKey(key)
      const d = distanceToParcelCenterM(dclX, dclZ, p, baseParcel)
      if (d < best) best = d
    } catch {
      /* bad pointer */
    }
  }
  // Fall back to base parcel if footprint missing from ring query.
  if (!Number.isFinite(best)) {
    try {
      const p = parseParcelKey(ent.base)
      return distanceToParcelCenterM(dclX, dclZ, p, baseParcel)
    } catch {
      return Infinity
    }
  }
  return best
}

/** Classic roads + SDK6 — cannot be primary in this client. */
function isNonPromotableEntity(entity: Record<string, unknown>): boolean {
  const meta =
    entity.metadata && typeof entity.metadata === 'object'
      ? (entity.metadata as Record<string, unknown>)
      : {}
  const display =
    meta.display && typeof meta.display === 'object'
      ? (meta.display as Record<string, unknown>)
      : {}
  const title = typeof display.title === 'string' ? display.title : ''
  const main = typeof meta.main === 'string' ? meta.main.trim().toLowerCase() : ''
  const rv = meta.runtimeVersion
  const rvStr = rv === undefined || rv === null ? '' : String(rv).trim()

  if (rvStr === '6' || rvStr.startsWith('6.')) return true
  if (/^Road at /i.test(title)) return true

  if (main === 'game.js' || main.endsWith('/game.js') || main === 'bin/game.js') {
    const content = Array.isArray(entity.content) ? entity.content : []
    const hasRoadGlb = content.some((row) => {
      if (!row || typeof row !== 'object') return false
      const file =
        typeof (row as { file?: string }).file === 'string' ? (row as { file: string }).file : ''
      const base = file.split('/').pop() ?? file
      return /^(OpenRoad_|OpenFork_|Road_|DeadEnd_|Fork_|Corner_|EmptyFork_)/i.test(base)
    })
    if (hasRoadGlb || /road|openroad|openfork|tram/i.test(title)) return true
    if (!(rvStr === '7' || rvStr.startsWith('7.'))) return true
  }

  return false
}
