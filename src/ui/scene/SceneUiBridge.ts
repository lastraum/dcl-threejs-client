import type { Entity } from '@dcl/ecs'
import * as THREE from 'three'
import type { PBUiCanvasInformation } from '@dcl/ecs/dist/components/generated/pb/decentraland/sdk/components/ui_canvas_information.gen'
import type { PBUiBackground } from '@dcl/ecs/dist/components/generated/pb/decentraland/sdk/components/ui_background.gen'
import type { PBUiDropdown } from '@dcl/ecs/dist/components/generated/pb/decentraland/sdk/components/ui_dropdown.gen'
import type { PBUiInput } from '@dcl/ecs/dist/components/generated/pb/decentraland/sdk/components/ui_input.gen'
import type { PBUiText } from '@dcl/ecs/dist/components/generated/pb/decentraland/sdk/components/ui_text.gen'
import type { PBUiTransform } from '@dcl/ecs/dist/components/generated/pb/decentraland/sdk/components/ui_transform.gen'
import type { ProjectionChange } from '../../bridge/CrdtProjection'
import type { ProjectionView } from '../../bridge/ProjectionView'
import type { WorkerUiMountSnapshotRow } from '../../shim/types'
import type { MirrorComponents } from '../../bridge/mirrorComponents'
import type { ResolvedScene } from '../../dcl/content/types'
import type { PointerHit } from '../../input/PointerEventsSystem'
import {
  buildUiForest,
  expandDirtyWithDescendants,
  expandLayoutDirtyBranch,
  filterMountedUiRecords,
  type UiEntityRecord
} from './uiTree'
import { YGPositionType, normalizeYGPositionType } from './yogaEnums'
import { SceneUiDomRenderer, ensureSceneUiRoot } from './SceneUiDomRenderer'
import { SceneUiInputController } from './SceneUiInputController'
import {
  alignSceneUiRoot,
  computeUiViewport,
  DEFAULT_VIRTUAL_CANVAS,
  interactableInsetsVirtual,
  readInteractableArea,
  type VirtualCanvasSize
} from './virtualCanvas'
import { clientDebugLog } from '../../client/debug/ClientDebugLog'
import { SceneUiHitMap, type UiScreenRegion } from './uiHitMap'
import {
  disposeSceneUiDebug,
  isSceneUiDebugEnabled,
  reportInputModifierState,
  reportSceneUiDebug
} from './sceneUiDebug'
import {
  collectSceneUiEntitiesFromDom,
  entityFromSceneUiDomTarget,
  isForeignUiRootOnTop,
  setPeUiAuthoritativeEntityCheck,
  setSceneUiAuthoritativeEntityCheck
} from './uiDomPick'
import './uiPointerGate'
import {
  findUiPointerHandlerEntity,
  hasUiPointerDownOrUp,
  hasUiPointerEvent,
  isFullscreenUiPeAllowed,
  isUiEntityPointerCapturing,
  normalizePointerEventsList,
  type UiPointerEventsLookup
} from './uiPointer'
import { InputAction, PointerEventType, type PointerEventTypeValue } from '../../input/pointerConstants'
import {
  computeUiLayoutKey,
  computeUiVisualPaintKey,
  layoutTransformFingerprint,
  missingVisibleLayoutEntities,
  UiLayoutCache,
  visibleLayoutBoxes
} from './uiLayoutCache'
import { layoutUiTree, type LayoutBox } from './yogaLayout'
import {
  countCollapsedLayoutBoxes,
  repairCollapsedLayoutBoxes,
  tryRefineAbsoluteLayoutBoxes
} from './fastLayoutPatch'
import { onSceneUiImageLoaded } from './uiImageLoad'

const _camPos = new THREE.Vector3()
const POINTER_EVENTS_COMPONENT_ID = 1062

export type SceneUiWriteback = {
  writeInputResult: (entity: Entity, value: string, isSubmit?: boolean) => void
  writeDropdownResult: (entity: Entity, index: number) => void
  flushLww?: () => void
}

/** In-scene ECS UI — Yoga layout + DOM paint; DOM is the sole hit-test surface. */
export class SceneUiBridge {
  private readonly root: HTMLElement
  private readonly dom: SceneUiDomRenderer
  private readonly input!: SceneUiInputController
  private readonly hitMap = new SceneUiHitMap()
  private readonly layoutCache = new UiLayoutCache()
  private scene: ResolvedScene | null = null
  private virtual: VirtualCanvasSize = { ...DEFAULT_VIRTUAL_CANVAS }
  private lastCanvasKey = ''
  private writeback: SceneUiWriteback | null = null
  private mirrorEcs: MirrorComponents | null = null
  private lastView: ProjectionView | null = null
  private readonly getCanvas: () => HTMLElement | null
  /** Worker engine mount set — projection UiTransform can lag PUT/DELETE by a frame. */
  private workerUiEntities: ReadonlySet<Entity> | null = null
  /** False until the first post-onStart crdt-outbound — projection-only UI is not painted. */
  private workerUiEntitiesKnown = false
  private lastWorkerUiKey = ''
  private lastMountedUiEntities = new Set<Entity>()
  private firstPaintLogged = false
  private paintCount = 0
  private lastLoggedPaintMount = 0
  /** Skip full paint when layout + visual fingerprints match previous frame. */
  private lastPaintLayoutKey = ''
  private lastPaintVisualKey = ''
  private lastEntityVisualKeys = new Map<Entity, string>()
  /** Previous frame Yoga-relevant transform fingerprints (position/size — not opacity). */
  private lastEntityLayoutKeys = new Map<Entity, string>()
  /**
   * Previous frame *visible* layout boxes (paint geometry).
   * Do not seed refine/reuse from this alone — shop open can leave children missing.
   */
  private lastLayoutBoxMap: Map<Entity, LayoutBox> | null = null
  /**
   * Full Yoga output from the last layoutUiTree (includes display:none / opacity-0 nodes).
   * Seed for absolute refine + reuse so newly-visible shop subtrees keep their boxes.
   */
  private lastFullLayoutBoxes: LayoutBox[] | null = null
  /** Last paint forest — fullscreen PE allow-list needs descendant paint (CBD splash). */
  private lastUiForest: Map<Entity, Entity[]> | null = null
  /** Consecutive paints with stable visible count — enables patch-heavy path (COD no thrash). */
  private stableVisibleStreak = 0
  private lastStableVisibleCount = 0
  /**
   * Phase C dirty set — contentEpoch bumps when mount/CRDT/image/size changes.
   * paint() skips record walk when epoch already painted (redundant flushUiFrame).
   */
  private contentEpoch = 0
  private paintedEpoch = -1
  /** False until AppController reveals 3D play chrome — avoids UI on 2D landing during hydration. */
  private domVisible = false
  private readonly unbindImageLoaded: () => void
  private imageRepaintQueued = false
  /** Latest pointer phase-4 rows — fill-in when projection PE lags (menu open). */
  private mountSnapshotPointerEvents = new Map<Entity, unknown>()
  /**
   * Entities that already had PE on the live projection. Once seen, a missing live PE means
   * deleted — never resurrect from a stale phase-4 snapshot (welcome splash ghost catcher).
   */
  private livePointerEventsSeen = new Set<Entity>()
  /** Last pointer position — re-evaluate cursor after Sync/modal DOM swaps. */
  private lastPointerClientX = 0
  private lastPointerClientY = 0
  constructor(
    scene: ResolvedScene | null = null,
    getCanvas: () => HTMLElement | null = () => null,
    opts?: {
      rootId?: string
      /**
       * Off-DOM UI host for non-focus workers (secondary live). Never paints into
       * `#scene-ui-root` and does not register global authoritative pick checks.
       */
      detached?: boolean
    }
  ) {
    this.scene = scene
    this.getCanvas = getCanvas
    if (opts?.detached) {
      // Isolated host — never share primary/PE document roots.
      this.root = document.createElement('div')
      this.root.id = opts.rootId ?? `secondary-ui-detached-${Math.random().toString(36).slice(2, 10)}`
      this.root.hidden = true
      this.root.style.display = 'none'
    } else {
      this.root = ensureSceneUiRoot(opts?.rootId ?? 'scene-ui-root')
    }
    this.setVisible(false)
    this.dom = new SceneUiDomRenderer(this.root, {
      onInputChange: (entity, value) => {
        this.input.onDomInput(entity, value)
        this.onInputChange(entity, value, false)
      },
      onInputSubmit: (entity, value) => {
        this.input.onDomInput(entity, value)
        this.onInputChange(entity, value, true)
      },
      onDropdownChange: (entity, index) => this.onDropdownChange(entity, index),
      onFieldFocus: (entity) => this.input.onFieldFocus(entity),
      onFieldBlur: (entity) => this.input.onFieldBlur(entity),
      isEditingEntity: (entity) => this.input.isEditingEntity(entity),
      shouldPinEntity: (entity, el, alive) => this.input.shouldPinEntity(entity, el, alive),
      onEntityReleased: (entity) => this.input.releaseEntity(entity)
    })
    this.input = new SceneUiInputController({
      getEcs: () => this.mirrorEcs,
      getFieldDom: (entity) => this.dom.getFieldDom(entity),
      isAuthoritativeUiEntity: (entity) => this.isAuthoritativeUiEntity(entity)
    })
    this.input.bind()
    // Detached secondary UI must not steal primary/PE hit-map registration.
    if (!opts?.detached) {
      const isPeRoot = (opts?.rootId ?? 'scene-ui-root') === 'pe-ui-root'
      if (isPeRoot) {
        setPeUiAuthoritativeEntityCheck((entity) => this.isAuthoritativeUiEntity(entity))
      } else {
        setSceneUiAuthoritativeEntityCheck((entity) => this.isAuthoritativeUiEntity(entity))
      }
    }
    this.unbindImageLoaded = onSceneUiImageLoaded(() => this.scheduleImageRepaint())
  }

  private scheduleImageRepaint(): void {
    if (!this.lastView) return
    // Many UiBackground textures finish in a burst (menus / character UI) — one paint, not N full Yoga passes.
    if (this.imageRepaintQueued) return
    this.imageRepaintQueued = true
    window.setTimeout(() => {
      this.imageRepaintQueued = false
      // Visual fingerprint does not include bake completion — without this, paint early-outs
      // and color×texture upgrades never replace solid placeholders (empty detail icons).
      this.lastPaintVisualKey = ''
      this.lastEntityVisualKeys.clear()
      this.markContentDirty()
      if (this.lastView) this.paint(this.lastView)
    }, 80)
  }

  /** Phase C — mark UI content dirty (CRDT put, mount, image, size). */
  markContentDirty(): void {
    this.contentEpoch++
  }

  /** True when a paint is needed (content changed since last successful paint). */
  isContentDirty(): boolean {
    return this.paintedEpoch !== this.contentEpoch
  }

  /** Show/hide scene ECS UI overlay — primary `#scene-ui-root` or PE `#pe-ui-root`. */
  setVisible(visible: boolean): void {
    const wasVisible = this.domVisible
    this.domVisible = visible
    this.root.hidden = !visible
    if (!visible) return
    // Invalidate on false→true only — re-calling setVisible(true) while shown must not
    // thrash full Yoga rebuilds (that caused PE HUD flicker: first paint spam).
    if (!wasVisible) {
      this.invalidatePaintCache()
      this.markContentDirty()
      if (this.lastView) this.paint(this.lastView)
    }
    // Already visible: leave paint to mount snapshots / dirty frames — do not re-paint
    // on every setUiVisible(true) from PE policy ticks.
  }

  /** Force Yoga+DOM rebuild + interactive hit regions (rare: late mount / debug). */
  forceRepaint(): void {
    if (!this.domVisible) return
    this.invalidatePaintCache()
    this.markContentDirty()
    if (this.lastView) this.paint(this.lastView)
  }

  /**
   * @deprecated No-op. Scene owns splash visuals; client must not invent dismiss hacks.
   * Pointer freedom: PE delete / display:none from scene + real eng.update after inject.
   */
  forceDismissAfterSceneUiClick(_entity: Entity): void {
    /* intentionally empty */
  }

  private invalidatePaintCache(): void {
    this.lastPaintLayoutKey = ''
    this.lastPaintVisualKey = ''
    this.lastEntityVisualKeys.clear()
    this.lastEntityLayoutKeys.clear()
    this.lastLayoutBoxMap = null
    this.lastFullLayoutBoxes = null
    this.stableVisibleStreak = 0
    this.lastStableVisibleCount = 0
    this.paintCount = 0
    this.firstPaintLogged = false
    this.paintedEpoch = -1
    this.markContentDirty()
  }

  isVisible(): boolean {
    return this.domVisible
  }

  bindWriteback(writeback: SceneUiWriteback): void {
    this.writeback = writeback
  }

  /**
   * Structured mount snapshot — PE lag-fill + optional full paint invalidate.
   * COD: clear liveSeen on any ingest. Full Forest only for pointer phase-4 / empty unmount
   * (`forceFullPaint`). Cooperative dirty must NOT wipe layout/visual keys (steady Patch).
   */
  ingestMountSnapshot(
    rows: readonly WorkerUiMountSnapshotRow[],
    opts?: { forceFullPaint?: boolean }
  ): void {
    const forceFull = opts?.forceFullPaint === true
    if (forceFull || rows.length === 0) {
      this.mountSnapshotPointerEvents.clear()
    }
    this.livePointerEventsSeen.clear()
    for (const row of rows) {
      if (row.componentId !== POINTER_EVENTS_COMPONENT_ID) continue
      const entity = row.entity as Entity
      this.mountSnapshotPointerEvents.set(entity, row.value)
    }
    if (forceFull) {
      // Phase-4 open/reshow — same mount entity set must still Forest (no key early-out).
      this.lastPaintLayoutKey = ''
      this.lastPaintVisualKey = ''
      this.lastEntityVisualKeys.clear()
      this.lastEntityLayoutKeys.clear()
      this.lastLayoutBoxMap = null
      this.lastFullLayoutBoxes = null
      this.layoutCache.clear()
      this.paintCount = 0
      this.firstPaintLogged = false
      this.paintedEpoch = -1
      this.stableVisibleStreak = 0
      this.lastStableVisibleCount = 0
    }
    this.markContentDirty()
  }

  /**
   * SCENE_UI_COD PE lead law (single authority):
   *  1. Live non-empty → live wins; mark seen; drop snapshot for that entity
   *  2. Live empty + authoritative + snapshot non-empty → snapshot (fold lag)
   *  3. Live empty + seen + no snapshot → deleted (splash PE drop)
   *  4. Else → none
   * PE delete for still-mounted entities without PE row: applyWorkerUiMountSnapshot only.
   */
  private pointerEventsLookup: UiPointerEventsLookup = (entity) => {
    const ecs = this.mirrorEcs
    const live = ecs?.PointerEvents.getOrNull(entity) as { pointerEvents?: unknown[] } | null
    if (normalizePointerEventsList(live).length > 0) {
      this.livePointerEventsSeen.add(entity)
      this.mountSnapshotPointerEvents.delete(entity)
      return live as ReturnType<UiPointerEventsLookup>
    }
    if (this.isAuthoritativeUiEntity(entity)) {
      const fromSnapshot = this.mountSnapshotPointerEvents.get(entity) as
        | { pointerEvents?: unknown[] }
        | undefined
      if (normalizePointerEventsList(fromSnapshot).length > 0) {
        return fromSnapshot as ReturnType<UiPointerEventsLookup>
      }
    }
    if (this.livePointerEventsSeen.has(entity)) {
      return null
    }
    return null
  }

  /** Projection + phase-4 snapshot — used by pointer flush and DOM interactivity. */
  pointerEventsOf: UiPointerEventsLookup = (entity) => this.pointerEventsLookup(entity)

  hasCommittedMountSet(): boolean {
    return this.workerUiEntitiesKnown && (this.workerUiEntities?.size ?? 0) > 0
  }

  /**
   * Atomic mount-set commit — only call from applyUiFrame after projection is ready.
   * UITransformReleaseSystem parity: release pool slots for every id that left the worker set.
   */
  commitMountSet(next: ReadonlySet<Entity>): boolean {
    const uiKey = [...next].sort((a, b) => (a as number) - (b as number)).join(',')
    const changed = !this.workerUiEntitiesKnown || uiKey !== this.lastWorkerUiKey
    const prevSize = this.workerUiEntitiesKnown ? (this.workerUiEntities?.size ?? 0) : 0
    // Remount growth (how-to-play 52→121, shop reopen): full dirty — PE + layout + pool.
    // Prior threshold (next >= prev+80) missed 52→121 and left stale visual/patch keys so
    // pagination/close painted as PE-only on second open.
    const remountGrowth =
      changed && next.size >= 40 && (prevSize === 0 || next.size >= prevSize + 24)
    const remountShrink =
      changed && prevSize >= 40 && next.size + 24 <= prevSize
    if (changed) this.markContentDirty()

    let removedCount = 0
    if (this.workerUiEntitiesKnown && this.workerUiEntities) {
      const removed = new Set<Entity>()
      const survivors = new Set<Entity>()
      for (const entity of this.workerUiEntities) {
        if (!next.has(entity)) removed.add(entity)
        else survivors.add(entity)
      }
      removedCount = removed.size
      if (removed.size > 0) {
        if (typeof location !== 'undefined' && location.search.includes('sceneuidebug')) {
          console.log(
            `[scene-ui] UITransformRelease — ${removed.size} recycled/off mount (${prevSize} → ${next.size})`
          )
          if (survivors.size > 0) {
            console.log(
              `[scene-ui] mount intersection (${survivors.size}):`,
              [...survivors].map((e) => `e${e}`).join(', ')
            )
          }
        }
        this.releaseUiEntities(removed)
      }
    }

    if (next.size === 0) {
      this.dom.releaseAll()
      this.hitMap.clear()
      this.lastMountedUiEntities.clear()
      this.lastPaintLayoutKey = ''
      this.lastPaintVisualKey = ''
      this.lastEntityVisualKeys.clear()
      this.lastEntityLayoutKeys.clear()
      this.lastLayoutBoxMap = null
      this.lastFullLayoutBoxes = null
      this.stableVisibleStreak = 0
      this.lastStableVisibleCount = 0
      this.livePointerEventsSeen.clear()
      this.mountSnapshotPointerEvents.clear()
      this.input.pruneStaleEntities(new Set())
    } else if (changed) {
      this.lastMountedUiEntities.clear()
      this.layoutCache.clear()
      this.lastPaintLayoutKey = ''
      this.lastPaintVisualKey = ''
      this.lastEntityVisualKeys.clear()
      this.lastEntityLayoutKeys.clear()
      // Mount set change — full Yoga next paint (do not refine from prior tree).
      this.lastLayoutBoxMap = null
      this.lastFullLayoutBoxes = null
      this.stableVisibleStreak = 0
      this.lastStableVisibleCount = 0
      // Any mount set change recycles entity ids — PE tombstones must not stick (SCENE_UI_COD).
      this.livePointerEventsSeen.clear()
      // Force full forest path (preferPatch needs paintCount > 1). Any meaningful remount.
      if (remountGrowth || remountShrink || next.size >= 80 || removedCount >= 24) {
        this.paintCount = 0
        this.firstPaintLogged = false
      }
    }

    this.workerUiEntitiesKnown = true
    this.lastWorkerUiKey = uiKey
    this.workerUiEntities = next
    return changed
  }

  /** Worker mount set — stale/recycled DOM nodes must not receive pointer hits. */
  isAuthoritativeUiEntity(entity: Entity): boolean {
    return this.workerUiEntitiesKnown && (this.workerUiEntities?.has(entity) ?? false)
  }

  getWorkerUiEntities(): ReadonlySet<Entity> | null {
    return this.workerUiEntities
  }

  /**
   * Worker mount ids should have UiTransform before commit+paint.
   * Allow one missing id on large trees (race on last PUT) so Flagtag timer/HUD is not
   * deferred forever when a single shell entity lacks transform.
   */
  isMountSetReady(view: ProjectionView, mountSet?: ReadonlySet<Entity>): boolean {
    const target = mountSet ?? this.workerUiEntities
    if (!target?.size) return true
    const ecs = view.components
    let withTransform = 0
    for (const entity of target) {
      if (ecs.UiTransform.has(entity)) withTransform++
    }
    const missing = target.size - withTransform
    const ready =
      missing === 0 || (target.size >= 8 && withTransform > 0 && missing <= 1)
    if (
      !ready &&
      typeof location !== 'undefined' &&
      location.search.includes('sceneuidebug')
    ) {
      console.log(
        `[scene-ui] applyUiFrame deferred — mount=${target.size} projectionUiTransform=${withTransform}/${target.size}`
      )
    }
    return ready
  }

  /**
   * Apply the projection diff batch before layout — purge DOM for deleted UiTransform
   * entities so recycled ids never inherit stale nodes.
   */
  applyProjectionChanges(changes: readonly ProjectionChange[]): void {
    const ecs = this.mirrorEcs
    if (!ecs || !changes.length) return

    const uiTransformId = ecs.UiTransform.componentId
    const uiBackgroundId = ecs.UiBackground.componentId
    const removed = new Set<Entity>()
    for (const change of changes) {
      if (change.kind !== 'delete') continue
      if (change.componentId === uiTransformId || change.componentId === uiBackgroundId) {
        removed.add(change.entity)
      }
    }
    if (!removed.size) return
    this.markContentDirty()
    this.releaseUiEntities(removed)
  }

  /** PointerEventsSystem — single gate for UiInput / UiDropdown clicks (DOM target + coords). */
  consumeFieldPointerDown(clientX: number, clientY: number, target: EventTarget | null): boolean {
    return this.input.consumePointerDown(clientX, clientY, target)
  }

  isFieldEntity(entity: Entity): boolean {
    return this.input.isFieldEntity(entity)
  }

  isTypingActive(): boolean {
    return this.input.isTypingActive()
  }

  /** Override virtual screen size (e.g. from scene `setUiRenderer` options). */
  setVirtualSize(width: number, height: number): void {
    if (!Number.isFinite(width) || !Number.isFinite(height)) return
    if (width > 0 && height > 0) {
      const next = { width: Math.floor(width), height: Math.floor(height) }
      if (next.width !== this.virtual.width || next.height !== this.virtual.height) {
        this.layoutCache.clear()
        this.markContentDirty()
      }
      this.virtual = next
    }
  }

  dispose(): void {
    setSceneUiAuthoritativeEntityCheck(null)
    this.input.dispose()
    this.dom.dispose()
    this.hitMap.clear()
    this.workerUiEntities = null
    this.workerUiEntitiesKnown = false
    this.lastWorkerUiKey = ''
    this.lastMountedUiEntities.clear()
    this.livePointerEventsSeen.clear()
    this.mountSnapshotPointerEvents.clear()
    this.firstPaintLogged = false
    this.lastLoggedPaintMount = 0
    this.mirrorEcs = null
    this.lastView = null
    disposeSceneUiDebug()
    this.unbindImageLoaded()
    this.root.remove()
  }

  /** Yoga layout → DOM paint for the committed worker mount set. */
  paint(view: ProjectionView): void {
    this.mirrorEcs = view.components
    this.lastView = view
    if (!this.domVisible) {
      // Mount still commits while hidden; revealPlayChrome → setVisible(true) repaints.
      // Never log per-frame (was flooding console + main-thread during 60s attach).
      return
    }
    // Phase C: skip full mount/record walk when nothing marked dirty since last paint.
    if (this.paintCount > 0 && this.paintedEpoch === this.contentEpoch) {
      return
    }
    const ecs = view.components

    const interactable = readInteractableArea(this.getCanvas())
    alignSceneUiRoot(this.root, interactable)
    const viewport = computeUiViewport(this.virtual, interactable)
    this.injectCanvasInfo(view, ecs, interactable, viewport)

    if (!this.workerUiEntitiesKnown || !this.workerUiEntities?.size) {
      this.scrubUnauthoritativeDom()
      disposeSceneUiDebug()
      this.lastPaintLayoutKey = ''
      this.lastPaintVisualKey = ''
      this.lastEntityVisualKeys.clear()
      this.lastEntityLayoutKeys.clear()
      this.lastLayoutBoxMap = null
      this.lastFullLayoutBoxes = null
      this.paintedEpoch = this.contentEpoch
      return
    }

    this.scrubUnauthoritativeDom()
    this.purgeProjectionStaleDom(view)

    const records = filterMountedUiRecords(this.collectUiRecords(view))
    const mounted = new Set<Entity>(records.map((r) => r.entity))
    this.reconcileMountedUiLifecycle(mounted)

    if (records.length === 0) {
      this.scrubUnauthoritativeDom()
      disposeSceneUiDebug()
      this.lastPaintLayoutKey = ''
      this.lastPaintVisualKey = ''
      this.lastEntityVisualKeys.clear()
      this.lastEntityLayoutKeys.clear()
      this.lastLayoutBoxMap = null
      this.lastFullLayoutBoxes = null
      this.paintedEpoch = this.contentEpoch
      return
    }

    const forest = buildUiForest(records)
    const transformOf = (e: Entity) => ecs.UiTransform.getOrNull(e) as PBUiTransform | null
    const textOf = (e: Entity) => ecs.UiText.getOrNull(e) as PBUiText | null
    const inputOf = (e: Entity) => ecs.UiInput.getOrNull(e) as PBUiInput | null
    const backgroundOf = (e: Entity) => ecs.UiBackground.getOrNull(e) as PBUiBackground | null
    const dropdownOf = (e: Entity) => ecs.UiDropdown.getOrNull(e) as PBUiDropdown | null
    const pointerKeyOf = (e: Entity) => {
      const pe = this.pointerEventsLookup(e) as { pointerEvents?: unknown[] } | null
      return pe?.pointerEvents?.length ? String(pe.pointerEvents.length) : ''
    }

    const layoutKey = computeUiLayoutKey(records, this.virtual, textOf, inputOf)
    const { full: visualKey, byEntity: entityVisualKeys } = computeUiVisualPaintKey(
      records,
      textOf,
      backgroundOf,
      pointerKeyOf
    )

    // No layout or visual change — skip Yoga + DOM entirely.
    if (
      this.paintCount > 0 &&
      layoutKey === this.lastPaintLayoutKey &&
      visualKey === this.lastPaintVisualKey
    ) {
      this.paintedEpoch = this.contentEpoch
      return
    }

    this.paintCount++
    const mountSize = this.workerUiEntities?.size ?? 0
    if (this.paintCount <= 12 || mountSize !== this.lastLoggedPaintMount) {
      let withText = 0
      let withBg = 0
      const textSamples: string[] = []
      for (const r of records) {
        const t = textOf(r.entity)
        if (t?.value?.trim()) {
          withText++
          if (textSamples.length < 8) {
            textSamples.push(`e${r.entity as number}:"${t.value.trim().slice(0, 28)}"`)
          }
        }
        if (backgroundOf(r.entity)) withBg++
      }
      const sampleStr = textSamples.length ? ` samples=[${textSamples.join(', ')}]` : ''
      // PE targets available for pick (snapshot ∪ projection) — diagnose CREATOR vs scrim.
      const peIds: number[] = []
      for (const r of records) {
        const id = r.entity as number
        if (hasUiPointerDownOrUp(this.pointerEventsLookup(r.entity))) peIds.push(id)
      }
      peIds.sort((a, b) => a - b)
      const peStr = peIds.length ? ` pe=[${peIds.map((e) => `e${e}`).join(',')}]` : ' pe=[]'
      // visibleYoga filled after layout; log mount vs canvas here, layout completeness later in debug.
      if (!this.firstPaintLogged) {
        this.firstPaintLogged = true
        clientDebugLog.log(
          'scene-ui',
          `first paint — mount=${mountSize} canvas=${records.length} text=${withText} bg=${withBg}` +
            ` virtual=${this.virtual.width}×${this.virtual.height}${sampleStr}${peStr}`
        )
      } else if (this.paintCount <= 12) {
        clientDebugLog.log(
          'scene-ui',
          `repaint #${this.paintCount} — mount=${mountSize} canvas=${records.length}` +
            ` text=${withText} bg=${withBg}${sampleStr}${peStr}`
        )
      } else {
        clientDebugLog.log(
          'scene-ui',
          `repaint mount change — mount=${mountSize} canvas=${records.length} text=${withText} bg=${withBg}${peStr}`,
          { throttleMs: 2000, throttleKey: 'scene-ui-repaint-mount' }
        )
      }
      this.lastLoggedPaintMount = mountSize
    }

    // COD dirty law: ANY Ui* change on E → paint dirty E ∪ descendants(E).
    // Cousins (sibling panel trees under canvas 0) never enter unless they themselves changed.
    // Seeds = entities whose visual or layout fingerprint changed (or left the mount).
    const dirtySeeds: Entity[] = []
    const seedSet = new Set<Entity>()
    const markSeed = (entity: Entity): void => {
      if (seedSet.has(entity)) return
      seedSet.add(entity)
      dirtySeeds.push(entity)
    }
    if (this.lastEntityVisualKeys.size > 0) {
      for (const [entity, key] of entityVisualKeys) {
        if (this.lastEntityVisualKeys.get(entity) !== key) markSeed(entity)
      }
      for (const entity of this.lastEntityVisualKeys.keys()) {
        if (!entityVisualKeys.has(entity)) markSeed(entity)
      }
    }
    const entityLayoutKeys = new Map<Entity, string>()
    for (const { entity, transform } of records) {
      const lk = layoutTransformFingerprint(transform)
      entityLayoutKeys.set(entity, lk)
      if (this.lastEntityLayoutKeys.size > 0 && this.lastEntityLayoutKeys.get(entity) !== lk) {
        markSeed(entity)
      }
    }
    if (this.lastEntityLayoutKeys.size > 0) {
      for (const entity of this.lastEntityLayoutKeys.keys()) {
        if (!entityLayoutKeys.has(entity)) markSeed(entity)
      }
    }

    // Paint set: seeds + descendants only (not cousins).
    const dirtyEntities =
      this.lastEntityVisualKeys.size > 0 || this.lastEntityLayoutKeys.size > 0
        ? expandDirtyWithDescendants(dirtySeeds, forest)
        : []

    // Layout seeds: transform fingerprint only (UV/text must not re-Yoga).
    const layoutSeeds: Entity[] = []
    if (this.lastEntityLayoutKeys.size > 0) {
      for (const [entity, lk] of entityLayoutKeys) {
        if (this.lastEntityLayoutKeys.get(entity) !== lk) layoutSeeds.push(entity)
      }
      for (const entity of this.lastEntityLayoutKeys.keys()) {
        if (!entityLayoutKeys.has(entity)) layoutSeeds.push(entity)
      }
    } else if (dirtySeeds.length > 0 && this.lastLayoutBoxMap) {
      // First dirty after mount baseline — layout until we have a layout key baseline.
      layoutSeeds.push(...dirtySeeds)
    }
    const layoutDirtyEntities = expandLayoutDirtyBranch(
      layoutSeeds,
      forest,
      transformOf,
      (t) => normalizeYGPositionType(t.positionType) === YGPositionType.ABSOLUTE
    )

    const runFullYoga = (): LayoutBox[] => {
      const { boxes, dispose } = layoutUiTree(
        records,
        forest,
        this.virtual.width,
        this.virtual.height,
        textOf,
        inputOf,
        backgroundOf
      )
      dispose()
      this.layoutCache.set(layoutKey, boxes)
      this.lastFullLayoutBoxes = boxes
      return boxes
    }

    const fullSeedMap = (): Map<Entity, LayoutBox> | null => {
      if (this.lastFullLayoutBoxes?.length) {
        return new Map(this.lastFullLayoutBoxes.map((b) => [b.entity, b]))
      }
      // Legacy fallback — visible-only seed is incomplete for shop open.
      if (this.lastLayoutBoxMap?.size) return new Map(this.lastLayoutBoxMap)
      return null
    }

    // SCENE_UI_COD LayoutMode: Full | RefineAbsolute | Reuse
    // Large modals still refine absolute dirties so reeling never fullYoga every tick.
    const refineBudget = mounted.size >= 200 ? 64 : 32
    const patchBudget = mounted.size >= 200 ? 96 : 48
    type LayoutMode = 'Full' | 'RefineAbsolute' | 'Reuse'
    let layoutMode: LayoutMode = 'Full'
    let layoutBoxes = this.layoutCache.get(layoutKey)
    let layoutCacheHit = !!layoutBoxes
    let usedFullYoga = false
    // Never reuse a layout that left many 0×0 cells (empty vending icons on first open).
    if (layoutBoxes && countCollapsedLayoutBoxes(layoutBoxes) > 8) {
      layoutBoxes = null
      layoutCacheHit = false
    }
    if (layoutBoxes) {
      layoutMode = 'Reuse'
      this.lastFullLayoutBoxes = layoutBoxes
    } else {
      layoutCacheHit = false
      const seedCollapsed = this.lastFullLayoutBoxes
        ? countCollapsedLayoutBoxes(this.lastFullLayoutBoxes)
        : 0
      // Reuse: UV/color/text only with healthy last full boxes (COD: no thrash on reeling).
      if (
        layoutDirtyEntities.length === 0 &&
        this.lastFullLayoutBoxes?.length &&
        seedCollapsed <= 8
      ) {
        layoutBoxes = this.lastFullLayoutBoxes
        layoutCacheHit = true
        layoutMode = 'Reuse'
      } else if (
        layoutDirtyEntities.length > 0 &&
        layoutDirtyEntities.length <= refineBudget &&
        layoutDirtyEntities.length < mounted.size * 0.4 &&
        seedCollapsed <= 8
      ) {
        // RefineAbsolute: fishing reeling + inventory slot absolute tweaks.
        const seed = fullSeedMap()
        if (seed?.size) {
          const refined = tryRefineAbsoluteLayoutBoxes(
            seed,
            layoutDirtyEntities,
            transformOf,
            this.virtual
          )
          if (refined) {
            layoutBoxes = [...refined.values()]
            this.lastFullLayoutBoxes = layoutBoxes
            layoutCacheHit = true
            layoutMode = 'RefineAbsolute'
          }
        }
      }
      if (!layoutBoxes) {
        layoutBoxes = runFullYoga()
        usedFullYoga = true
        layoutMode = 'Full'
      }
    }

    // Authored-only collapse repair (POINT/%/edges). AUTO icons measured in Yoga.
    // COD: no twinAlign / client pose invent — paint ECS Yoga boxes only.
    const repairedCollapsed = repairCollapsedLayoutBoxes(layoutBoxes, transformOf, this.virtual)
    if (repairedCollapsed > 0) {
      this.lastFullLayoutBoxes = layoutBoxes
      this.layoutCache.set(layoutKey, layoutBoxes)
      layoutCacheHit = true
    }

    let layoutBoxMap = new Map<Entity, LayoutBox>(
      visibleLayoutBoxes(layoutBoxes, transformOf).map((box) => [box.entity, box])
    )

    // Shop/modal open: display:none → flex brings many nodes into the visible set. Cache/refine
    // from a HUD-only seed leaves them box-less → "yoga box unusable (none)" + hidden inventory.
    const missingVisible = missingVisibleLayoutEntities(mounted, transformOf, layoutBoxMap)
    if (missingVisible.length > 0 && !usedFullYoga) {
      if (typeof location !== 'undefined' && location.search.includes('sceneuidebug')) {
        console.warn(
          `[scene-ui] layout incomplete — ${missingVisible.length} visible entities missing Yoga boxes; full layout ` +
            `(e.g. ${missingVisible
              .slice(0, 6)
              .map((e) => `e${e as number}`)
              .join(', ')})`
        )
      }
      layoutBoxes = runFullYoga()
      usedFullYoga = true
      layoutMode = 'Full'
      layoutCacheHit = false
      repairCollapsedLayoutBoxes(layoutBoxes, transformOf, this.virtual)
      this.lastFullLayoutBoxes = layoutBoxes
      layoutBoxMap = new Map<Entity, LayoutBox>(
        visibleLayoutBoxes(layoutBoxes, transformOf).map((box) => [box.entity, box])
      )
    }

    const collapsedVisible = countCollapsedLayoutBoxes(layoutBoxMap.values())
    const prevVisibleCount = this.lastLayoutBoxMap?.size ?? 0
    const visibleDelta = Math.abs(layoutBoxMap.size - this.lastStableVisibleCount)
    if (visibleDelta <= 2 && layoutBoxMap.size > 0 && collapsedVisible <= 4) {
      this.stableVisibleStreak++
    } else {
      this.stableVisibleStreak = 0
      this.lastStableVisibleCount = layoutBoxMap.size
    }

    // SCENE_UI_COD PaintMode: Patch local dirties (entity∪descendants). Cousins untouched.
    // Forest when: first paint / remount, no seeds, dirty dominates mount, missing boxes,
    // or a dirty seed's box grew from micro (~scale open) so kids must leave display:none.
    let scaleExpand = false
    if (this.lastLayoutBoxMap?.size && dirtySeeds.length > 0) {
      for (const e of dirtySeeds) {
        const prev = this.lastLayoutBoxMap.get(e)
        const next = layoutBoxMap.get(e)
        if (!prev || !next) continue
        const prevMicro = prev.width <= 48 && prev.height <= 48
        const nextFull = next.width >= 120 && next.height >= 120
        if (prevMicro && nextFull) {
          scaleExpand = true
          break
        }
      }
    }
    // Sticky hide recovery: PE chrome still has ECS PE + good Yoga box but DOM left
    // display:none/uiUnusable after scale-open or cousin Patch skip → force Forest.
    let peChromeStickyHidden = false
    for (const e of mounted) {
      if (!hasUiPointerDownOrUp(this.pointerEventsLookup(e))) continue
      const box = layoutBoxMap.get(e)
      if (!box || box.width < 8 || box.height < 8) continue
      const node = this.dom.getNode(e)
      if (
        node &&
        (node.dataset.uiUnusable === '1' || node.style.display === 'none')
      ) {
        peChromeStickyHidden = true
        break
      }
    }
    const localDirty =
      dirtyEntities.length > 0 && dirtyEntities.length < mounted.size * 0.45
    const preferPatch =
      this.paintCount > 1 &&
      localDirty &&
      !scaleExpand &&
      !peChromeStickyHidden &&
      dirtyEntities.length <= patchBudget &&
      collapsedVisible <= 8 &&
      missingVisible.length === 0 &&
      (layoutMode === 'Reuse' ||
        layoutMode === 'RefineAbsolute' ||
        (layoutMode === 'Full' &&
          layoutDirtyEntities.length > 0 &&
          layoutDirtyEntities.length < mounted.size * 0.45))
    const paintMode: 'Patch' | 'Forest' = preferPatch ? 'Patch' : 'Forest'

    if (
      typeof location !== 'undefined' &&
      location.search.includes('sceneuidebug') &&
      (paintMode === 'Forest' || dirtySeeds.length > 0 || usedFullYoga)
    ) {
      console.log(
        `[scene-ui] layout paint — visibleYoga=${layoutBoxMap.size} prevVisible=${prevVisibleCount} ` +
          `layoutMode=${layoutMode} paintMode=${paintMode} seeds=${dirtySeeds.length} ` +
          `dirty=${dirtyEntities.length} layoutDirty=${layoutDirtyEntities.length} ` +
          `missingWas=${missingVisible.length} repaired=${repairedCollapsed} collapsed=${collapsedVisible}`
      )
    }

    this.lastUiForest = forest
    const drawInput = {
      forest,
      virtual: this.virtual,
      interactable,
      viewport,
      scene: this.scene,
      ecs,
      pointerEventsOf: this.pointerEventsLookup,
      transformOf,
      textOf,
      inputOf,
      dropdownOf,
      backgroundOf,
      mountedEntities: mounted,
      authoritativeEntities: this.workerUiEntities!,
      layoutBoxes: layoutBoxMap,
      onRegions: (regions: UiScreenRegion[]) => this.hitMap.replace(regions)
    }

    // Patch only dirty *seeds* — renderEntityTree walks each seed's descendants.
    // Expanded dirtyEntities is for budgets / logging; cousins never in either set.
    let usedPatch = false
    if (preferPatch) {
      usedPatch = this.dom.patchEntities(dirtySeeds, drawInput)
    }

    if (!usedPatch) {
      this.dom.render(drawInput)
    } else if (
      // Safety: patch left far fewer nodes than visible Yoga boxes (reopen under-paint).
      this.dom.getPooledNodeCount() < layoutBoxMap.size * 0.45 &&
      layoutBoxMap.size >= 32
    ) {
      this.dom.render(drawInput)
      usedPatch = false
    }

    // Oracle: open UI with PE but nothing usable on-canvas.
    if (this.paintCount <= 4) {
      let peOn = 0
      let peOff = 0
      let peTiny = 0
      let peOnModal = 0
      let peOnScrim = 0
      const samples: string[] = []
      const vw = this.virtual.width
      const vh = this.virtual.height
      const canvasArea = vw * vh
      for (const e of mounted) {
        if (!hasUiPointerDownOrUp(this.pointerEventsLookup(e))) continue
        const b = layoutBoxMap.get(e)
        if (!b) {
          peOff++
          if (samples.length < 4) samples.push(`e${e as number}:none`)
          continue
        }
        if (b.width < 8 || b.height < 8) {
          peTiny++
          continue
        }
        const on =
          b.left < vw - 1 &&
          b.top < vh - 1 &&
          b.left + b.width > 1 &&
          b.top + b.height > 1
        if (on) {
          peOn++
          const area = b.width * b.height
          if (area >= canvasArea * 0.4) peOnScrim++
          else if (b.width >= 120 && b.height >= 80) peOnModal++
        } else {
          peOff++
          if (samples.length < 4) {
            samples.push(
              `e${e as number}:${Math.round(b.left)},${Math.round(b.top)} ${Math.round(b.width)}×${Math.round(b.height)}`
            )
          }
        }
      }
      if (peOn + peOff + peTiny > 2) {
        clientDebugLog.log(
          'scene-ui',
          `pe-layout peOn=${peOn} peOnModal=${peOnModal} peOnScrim=${peOnScrim} ` +
            `peOff=${peOff} peTiny=${peTiny} paintMode=${paintMode}` +
            (samples.length ? ` off=[${samples.join('; ')}]` : '')
        )
      }
    }

    this.lastPaintLayoutKey = layoutKey
    this.lastPaintVisualKey = visualKey
    this.lastEntityVisualKeys = entityVisualKeys
    this.lastEntityLayoutKeys = entityLayoutKeys
    this.lastLayoutBoxMap = layoutBoxMap
    this.paintedEpoch = this.contentEpoch

    this.input.pruneStaleEntities(mounted)
    this.input.releaseAllIfNothingMounted(mounted)

    const fieldEntities: Entity[] = []
    let uiInputCount = 0
    for (const [entity] of view.getEntitiesWith(ecs.UiInput)) {
      uiInputCount++
      fieldEntities.push(entity)
    }
    for (const [entity] of view.getEntitiesWith(ecs.UiDropdown)) {
      fieldEntities.push(entity)
    }
    reportSceneUiDebug({
      hitMap: this.hitMap,
      dom: this.dom,
      fieldEntities,
      uiInputCount,
      domInputCount: this.root.querySelectorAll('.scene-ui-node__input, .scene-ui-node__select').length,
      layoutCacheHit,
      workerUiEntityCount: this.workerUiEntities?.size ?? 0,
      layoutBoxes: layoutBoxMap,
      transformOf,
      virtual: this.virtual
    })
    reportInputModifierState(ecs, view.PlayerEntity)
    // Sync / modal unmount often leaves browser cursor stuck on pointer (node removed mid-hover).
    this.refreshHoverCursor()
  }

  /** Recompute cursor from element under last pointer — call after DOM mount changes. */
  private refreshHoverCursor(): void {
    if (typeof document === 'undefined') return
    const x = this.lastPointerClientX
    const y = this.lastPointerClientY
    if (!x && !y) {
      this.applyHoverCursor('default')
      return
    }
    // Hit-map + Color4.a / PE (not stale DOM --interactive class after welcome fade).
    const capturing = this.pickTopmostUiLayer(x, y)
    if (!capturing) {
      const under = document.elementFromPoint(x, y)
      const field =
        under instanceof Element &&
        !!under.closest('.scene-ui-node__input, .scene-ui-node__select')
      this.applyHoverCursor(field ? 'text' : 'default')
      return
    }
    this.applyHoverCursor(this.input.isFieldEntity(capturing.entity) ? 'text' : 'pointer')
  }

  /**
   * Blocks 3D raycast when the topmost authoritative UI layer at (x,y) is blocking.
   * UI stacks above scene pointers — BLOCK shells consume the ray without falling through.
   */
  pickUiRegionHit(
    clientX: number,
    clientY: number,
    camera: THREE.Camera
  ): PointerHit | null {
    this.lastPointerClientX = clientX
    this.lastPointerClientY = clientY
    if (!this.domVisible) {
      this.applyHoverCursor('default')
      return null
    }
    // PX dialog above primary (or reverse): do not claim hover / block with our hit-map.
    if (isForeignUiRootOnTop(this.root.id, clientX, clientY)) {
      this.applyHoverCursor('default')
      return null
    }
    const ecs = this.mirrorEcs
    const view = this.lastView
    if (!ecs || !view) {
      this.applyHoverCursor('default')
      return null
    }

    const topmost = this.pickTopmostUiLayer(clientX, clientY)
    if (topmost === null) {
      this.applyHoverCursor('default')
      return null
    }
    if (this.input.isFieldEntity(topmost.entity)) {
      this.applyHoverCursor('text')
      return this.buildDomPointerHit(topmost.entity, camera)
    }
    if (!topmost.blocking) {
      this.applyHoverCursor('default')
      return null
    }

    this.applyHoverCursor('pointer')
    const handler =
      findUiPointerHandlerEntity(
        ecs,
        view,
        topmost.entity,
        InputAction.IA_POINTER,
        PointerEventType.PET_DOWN,
        this.pointerEventsLookup
      ) ?? topmost.entity
    return this.buildDomPointerHit(handler, camera)
  }

  private applyHoverCursor(next: 'default' | 'pointer' | 'text'): void {
    const canvas = this.getCanvas()
    if (canvas) canvas.style.cursor = next
    this.root.style.cursor = next
  }

  private candidatePickArea(entity: Entity): number {
    const region = this.hitMap.regionFor(entity)
    return region ? region.width * region.height : Number.POSITIVE_INFINITY
  }

  /**
   * Near-fullscreen hit region in client px (≥45% of the interactable viewport).
   * Used to gate empty transparent PE scrims that otherwise steal world mesh clicks.
   */
  private isNearFullscreenPickArea(area: number): boolean {
    if (!Number.isFinite(area) || area <= 0) return false
    const interactable = readInteractableArea(this.getCanvas())
    const vpArea = Math.max(1, interactable.width * interactable.height)
    return area >= vpArea * 0.45
  }

  /**
   * Hit map + DOM candidates, ranked deepest / smallest-area first.
   * All overlapping hit-map regions are included so label leaves can ancestor-walk to card handlers.
   */
  private collectTopClusterPickCandidates(
    clientX: number,
    clientY: number,
    eventTarget?: EventTarget | null
  ): Entity[] {
    const acceptMounted = (entity: Entity) => this.isAuthoritativeUiEntity(entity)
    const seen = new Set<number>()
    const ranked: {
      entity: Entity
      depth: number
      zIndex: number
      area: number
    }[] = []

    const consider = (entity: Entity | null): void => {
      if (entity === null || !acceptMounted(entity)) return
      const id = entity as number
      if (seen.has(id)) return
      seen.add(id)
      const region = this.hitMap.regionFor(entity)
      ranked.push({
        entity,
        depth: region?.depth ?? 0,
        zIndex: region?.zIndex ?? 0,
        area: region ? region.width * region.height : Number.POSITIVE_INFINITY
      })
    }

    for (const region of this.hitMap.hitTestRegionCandidates(clientX, clientY)) {
      consider(region.entity)
    }
    consider(entityFromSceneUiDomTarget(eventTarget ?? null, acceptMounted))
    for (const entity of collectSceneUiEntitiesFromDom(clientX, clientY, acceptMounted)) {
      consider(entity)
    }

    ranked.sort((a, b) => {
      if (a.depth !== b.depth) return b.depth - a.depth
      if (a.zIndex !== b.zIndex) return b.zIndex - a.zIndex
      if (a.area !== b.area) return a.area - b.area
      return (a.entity as number) - (b.entity as number)
    })

    return ranked.map((row) => row.entity)
  }

  private pickTopmostUiLayer(
    clientX: number,
    clientY: number,
    eventTarget?: EventTarget | null
  ): { entity: Entity; blocking: boolean } | null {
    const ecs = this.mirrorEcs
    if (!ecs) return null

    // Stack order (deepest / smallest first) — first blocking layer wins; no scrim fall-through.
    const candidates = this.collectTopClusterPickCandidates(clientX, clientY, eventTarget)
    for (const entity of candidates) {
      if (this.input.isFieldEntity(entity)) return { entity, blocking: true }
      if (!isUiEntityPointerCapturing(ecs, entity, this.pointerEventsLookup)) continue
      const area = this.candidatePickArea(entity)
      if (
        this.isNearFullscreenPickArea(area) &&
        !isFullscreenUiPeAllowed(ecs, entity, { forest: this.lastUiForest })
      ) {
        continue
      }
      return { entity, blocking: true }
    }
    return null
  }

  /**
   * Resolve the react-ecs onMouseDown handler for a click.
   *
   * Prefer the PE handler with the **smallest screen region** under the point
   * (CREATOR card ≪ fullscreen scrim). Ancestor walk from each leaf so labels
   * resolve to the card. Fullscreen scrim only wins when no smaller PE is under the cursor.
   */
  private resolveUiHandlerAtPoint(
    clientX: number,
    clientY: number,
    state: PointerEventTypeValue = PointerEventType.PET_DOWN,
    eventTarget?: EventTarget | null
  ): Entity | null {
    const ecs = this.mirrorEcs
    const view = this.lastView
    if (!ecs || !view) return null

    const candidates = this.collectTopClusterPickCandidates(clientX, clientY, eventTarget)
    const logPick = isSceneUiDebugEnabled() && state === PointerEventType.PET_DOWN
    if (logPick) {
      const regions = this.hitMap.hitTestRegionCandidates(clientX, clientY)
      console.log(
        `[scene-ui] pick @(${clientX},${clientY}) regions=${regions.length} candidates=${candidates.length} mount=${this.workerUiEntities?.size ?? 0}`
      )
      for (const region of regions.slice(0, 12)) {
        const handler = findUiPointerHandlerEntity(
          ecs,
          view,
          region.entity,
          InputAction.IA_POINTER,
          state,
          this.pointerEventsLookup
        )
        const area = region.width * region.height
        const blocking = isUiEntityPointerCapturing(ecs, region.entity, this.pointerEventsLookup)
        console.log(
          `[scene-ui]   region e${region.entity} depth=${region.depth} z=${region.zIndex} ${Math.round(region.width)}×${Math.round(region.height)} area=${Math.round(area)} handler=${handler ?? '—'} block=${blocking ? 1 : 0}`
        )
      }
    }

    let bestHandler: Entity | null = null
    let bestArea = Number.POSITIVE_INFINITY
    let blockingEntity: Entity | null = null
    let blockingArea = Number.POSITIVE_INFINITY

    for (const entity of candidates) {
      // Skip field rows — SceneUiInputController owns them; do not abort the whole pick (search
      // input is an ancestor candidate when clicking LOAD/DEL pills in the presets table).
      if (this.input.isFieldEntity(entity)) continue

      const handler = findUiPointerHandlerEntity(
        ecs,
        view,
        entity,
        InputAction.IA_POINTER,
        state,
        this.pointerEventsLookup
      )
      if (handler !== null) {
        // Handler only if still display-visible + PE (Explorer parity — not Color4.a invent).
        if (!isUiEntityPointerCapturing(ecs, handler, this.pointerEventsLookup)) continue
        // Rank by the HANDLER's region (card), not the leaf (label) — so a leaf that
        // incorrectly walks to the scrim loses to a real card handler under the same point.
        let area = this.candidatePickArea(handler)
        if (!Number.isFinite(area)) area = this.candidatePickArea(entity)
        // Near-fullscreen PE with no real scrim paint must not steal world mesh PE
        // (inventory GLB open). Child-panel paint (CBD splash) still wins.
        if (
          this.isNearFullscreenPickArea(area) &&
          !isFullscreenUiPeAllowed(ecs, handler, { forest: this.lastUiForest })
        ) {
          if (logPick) {
            console.log(
              `[scene-ui]   skip fullscreen empty PE e${handler} area=${Math.round(area)} (world pass-through)`
            )
          }
          continue
        }
        if (area < bestArea) {
          bestArea = area
          bestHandler = handler
        }
        continue
      }

      if (isUiEntityPointerCapturing(ecs, entity, this.pointerEventsLookup)) {
        const area = this.candidatePickArea(entity)
        if (
          this.isNearFullscreenPickArea(area) &&
          !isFullscreenUiPeAllowed(ecs, entity, { forest: this.lastUiForest })
        ) {
          continue
        }
        if (area < blockingArea) {
          blockingArea = area
          blockingEntity = entity
        }
      }
    }

    if (bestHandler !== null) {
      // Always log PE pick for UI clicks — CREATOR vs scrim diagnosis.
      if (state === PointerEventType.PET_DOWN) {
        const fromSnapshot = this.mountSnapshotPointerEvents.has(bestHandler)
        const parent = ecs.UiTransform.getOrNull(bestHandler)?.parent ?? 0
        console.info(
          `[scene-ui] pick → handler e${bestHandler} parent=e${parent} area=${Math.round(bestArea)}` +
            ` snapshotPe=${fromSnapshot} candidates=${candidates.length} (${clientX},${clientY})`
        )
      }
      return bestHandler
    }

    if (blockingEntity !== null) {
      if (logPick) {
        console.log(
          `[scene-ui] pick → blocked e${blockingEntity} area=${Math.round(blockingArea)} (${clientX},${clientY})`
        )
      }
      return null
    }
    if (logPick) {
      console.warn(`[scene-ui] pick → no target (${clientX},${clientY})`)
    }
    return null
  }

  /**
   * Interactive UI click target — DOM is authoritative; ECS parent walk finds onMouseDown handler.
   * UiInput / UiDropdown entities are excluded — handled by SceneUiInputController.
   */
  pickUiPointerHit(
    clientX: number,
    clientY: number,
    ecs: MirrorComponents,
    view: ProjectionView,
    camera: THREE.Camera,
    state: PointerEventTypeValue = PointerEventType.PET_DOWN,
    eventTarget?: EventTarget | null
  ): PointerHit | null {
    this.lastPointerClientX = clientX
    this.lastPointerClientY = clientY
    if (!this.domVisible) return null
    // Primary hit-map still covers the full screen under a PX enable/close popup.
    // Only the topmost interactive root (`#pe-ui-root` vs `#scene-ui-root`) may inject.
    if (isForeignUiRootOnTop(this.root.id, clientX, clientY, eventTarget)) return null
    this.mirrorEcs = ecs
    this.lastView = view
    const handlerEntity = this.resolveUiHandlerAtPoint(clientX, clientY, state, eventTarget)
    if (handlerEntity === null || this.input.isFieldEntity(handlerEntity)) return null

    const button = InputAction.IA_POINTER
    const spec = this.pointerEventsLookup(handlerEntity)
    const hasDown = hasUiPointerEvent(spec, PointerEventType.PET_DOWN, button)
    const hasState = hasUiPointerEvent(spec, state, button)
    if (!hasState && !(state === PointerEventType.PET_UP && hasDown)) {
      if (typeof location !== 'undefined' && location.search.includes('sceneuidebug')) {
        console.warn(
          `[scene-ui] ui hit handler=e${handlerEntity} spec=${spec?.pointerEvents?.length ?? 0}`
        )
      }
      return null
    }

    return this.buildDomPointerHit(handlerEntity, camera)
  }

  private buildDomPointerHit(entity: Entity, camera: THREE.Camera): PointerHit {
    camera.getWorldPosition(_camPos)
    return {
      entity,
      point: _camPos.clone(),
      distance: 0,
      normal: new THREE.Vector3(0, 1, 0),
      priority: 0,
      cameraDistance: 0,
      playerDistance: 0,
      inRange: true,
      isSceneUi: true
    }
  }

  private onInputChange(entity: Entity, value: string, isSubmit: boolean): void {
    this.writeback?.writeInputResult(entity, value, isSubmit)
    this.writeback?.flushLww?.()
    if (typeof location !== 'undefined' && location.search.includes('sceneuidebug')) {
      console.log(`[scene-ui] UiInputResult write entity=${entity} len=${value.length} submit=${isSubmit}`)
    }
  }

  private onDropdownChange(entity: Entity, index: number): void {
    this.writeback?.writeDropdownResult(entity, index)
    this.writeback?.flushLww?.()
  }

  /**
   * Drop projection UiTransform rows the worker no longer mounts — stale scrims after
   * react-ecs conditional unmount are the root cause of ghost overlays.
   */
  private collectUiRecords(view: ProjectionView): UiEntityRecord[] {
    const ecs = view.components
    const out: UiEntityRecord[] = []
    for (const [entity] of view.getEntitiesWith(ecs.UiTransform)) {
      if (this.workerUiEntitiesKnown && this.workerUiEntities && !this.workerUiEntities.has(entity)) {
        continue
      }
      const transform = ecs.UiTransform.getOrNull(entity) as PBUiTransform | null
      if (!transform) continue
      out.push({ entity, transform })
    }
    return out
  }

  /** Drop DOM for projection UiTransform rows the worker no longer mounts. */
  private purgeProjectionStaleDom(view: ProjectionView): void {
    if (!this.workerUiEntitiesKnown || !this.workerUiEntities) return
    const ecs = view.components
    const stale = new Set<Entity>()
    for (const [entity] of view.getEntitiesWith(ecs.UiTransform)) {
      if (!this.workerUiEntities.has(entity)) stale.add(entity)
    }
    if (!stale.size) return
    this.releaseUiEntities(stale)
  }

  /** UITransformReleaseSystem parity — drop pooled nodes for entities that left the mount set. */
  private releaseUiEntities(removed: ReadonlySet<Entity>): void {
    if (!removed.size) return
    this.dom.purgeProjectionRemoved(removed)
    for (const entity of removed) {
      this.input.releaseEntity(entity)
      this.lastMountedUiEntities.delete(entity)
      this.mountSnapshotPointerEvents.delete(entity)
      this.livePointerEventsSeen.delete(entity)
    }
  }

  /** Release DOM for entities no longer canvas-reachable in this projection frame. */
  private reconcileMountedUiLifecycle(mounted: Set<Entity>): void {
    const removed = new Set<Entity>()
    for (const entity of this.lastMountedUiEntities) {
      if (!mounted.has(entity)) removed.add(entity)
    }
    if (removed.size > 0) {
      this.releaseUiEntities(removed)
    }
    this.lastMountedUiEntities = new Set(mounted)
  }

  /** Drop any DOM node whose entity id is not on the worker mount set (ghost scrims). */
  private scrubUnauthoritativeDom(): void {
    if (!this.workerUiEntitiesKnown || !this.workerUiEntities) return
    this.dom.purgeUnauthoritativeDom(this.workerUiEntities)
  }

  private injectCanvasInfo(
    view: ProjectionView,
    ecs: MirrorComponents,
    interactable: ReturnType<typeof readInteractableArea>,
    _viewport: ReturnType<typeof computeUiViewport>
  ): void {
    const insets = interactableInsetsVirtual(this.virtual, interactable)
    // interactableArea is a rect in virtual px (left/top/right/bottom edges), not chrome insets.
    // UiScaleSystem: nextScale = min(width/virtualW, height/virtualH) / devicePixelRatio.
    // We report canvas size in the same virtual design space as setUiRenderer (not CSS px),
    // so devicePixelRatio must stay 1 — using window.devicePixelRatio (e.g. 2 on retina)
    // halves getUiScaleFactor() and shrinks every POINT-unit UiTransform (shop/HUD collapse).
    const sx = this.virtual.width / Math.max(1, window.innerWidth)
    const sy = this.virtual.height / Math.max(1, window.innerHeight)
    const area = {
      left: Math.round(interactable.left * sx),
      top: Math.round(interactable.top * sy),
      right: Math.round((interactable.left + interactable.width) * sx),
      bottom: Math.round((interactable.top + interactable.height) * sy)
    }
    const info: PBUiCanvasInformation = {
      devicePixelRatio: 1,
      width: this.virtual.width,
      height: this.virtual.height,
      interactableArea: area,
      screenInsetArea: insets
    }
    const key = JSON.stringify(info)
    if (key === this.lastCanvasKey) return
    this.lastCanvasKey = key
    ecs.UiCanvasInformation.createOrReplace(view.RootEntity, info)
  }
}