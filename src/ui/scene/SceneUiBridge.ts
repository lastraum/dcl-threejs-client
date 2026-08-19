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
import { buildUiForest, filterMountedUiRecords, type UiEntityRecord } from './uiTree'
import { SceneUiDomRenderer, ensureSceneUiRoot } from './SceneUiDomRenderer'
import { SceneUiInputController } from './SceneUiInputController'
import {
  alignSceneUiRoot,
  computeUiViewport,
  interactableInsetsVirtual,
  liveVirtualCanvas,
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
import { isUiEntityVisible } from './uiVisibility'

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
  private virtual: VirtualCanvasSize = { width: 1, height: 1 }
  /** Scene `setUiRenderer` / `addUiRenderer` virtualWidth×virtualHeight (plaza 1920×1080). */
  private authoredVirtual: VirtualCanvasSize | null = null
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
    // Keep short — fishing rod/bait dock icons were blank for seconds while 80ms+
    // batches waited behind plaza disco/collider thrash.
    window.setTimeout(() => {
      this.imageRepaintQueued = false
      // Visual fingerprint does not include bake completion — without this, paint early-outs
      // and color×texture upgrades never replace solid placeholders (empty detail icons).
      this.lastPaintVisualKey = ''
      this.lastEntityVisualKeys.clear()
      this.markContentDirty()
      if (this.lastView) this.paint(this.lastView)
    }, 16)
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

  /** Pointer phase-4 structured mount — feed DOM paint + hit tests before projection fold. */
  ingestMountSnapshot(rows: readonly WorkerUiMountSnapshotRow[]): void {
    this.mountSnapshotPointerEvents.clear()
    for (const row of rows) {
      if (row.componentId !== POINTER_EVENTS_COMPONENT_ID) continue
      const entity = row.entity as Entity
      this.mountSnapshotPointerEvents.set(entity, row.value)
      // New snapshot may re-open PE on an entity that previously lost it — allow snapshot lead.
      this.livePointerEventsSeen.delete(entity)
    }
  }

  private pointerEventsLookup: UiPointerEventsLookup = (entity) => {
    const ecs = this.mirrorEcs
    const live = ecs?.PointerEvents.getOrNull(entity) as { pointerEvents?: unknown[] } | null
    if (normalizePointerEventsList(live).length > 0) {
      // Live PE wins — drop snapshot so deletes cannot be resurrected later.
      this.livePointerEventsSeen.add(entity)
      this.mountSnapshotPointerEvents.delete(entity)
      return live as ReturnType<UiPointerEventsLookup>
    }
    // Projection already owned PE for this entity and now has none → deleted, not lagging.
    if (this.livePointerEventsSeen.has(entity)) {
      this.mountSnapshotPointerEvents.delete(entity)
      return null
    }
    // Phase-4 ahead of fold (menu open) — snapshot only when live has never carried PE.
    if (this.isAuthoritativeUiEntity(entity)) {
      const fromSnapshot = this.mountSnapshotPointerEvents.get(entity) as
        | { pointerEvents?: unknown[] }
        | undefined
      if (normalizePointerEventsList(fromSnapshot).length > 0) {
        return fromSnapshot as ReturnType<UiPointerEventsLookup>
      }
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
    if (changed) this.markContentDirty()

    if (this.workerUiEntitiesKnown && this.workerUiEntities) {
      const prevSize = this.workerUiEntities.size
      const removed = new Set<Entity>()
      const survivors = new Set<Entity>()
      for (const entity of this.workerUiEntities) {
        if (!next.has(entity)) removed.add(entity)
        else survivors.add(entity)
      }
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
   * Large trees may race a couple of shell rows — allow a small absolute miss
   * (not a ratio heuristic) so open menus paint when nearly complete.
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
    // Absolute miss budget scales gently with tree size (platform race, not scene-tuned %).
    const missBudget = target.size >= 64 ? 3 : target.size >= 8 ? 1 : 0
    const ready = missing === 0 || (withTransform > 0 && missing <= missBudget)
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

  /**
   * Scene `setUiRenderer` / `addUiRenderer` virtual design size.
   * Pre-7.26 omit → live interactable px. Plaza opts in at 1920×1080 — Yoga +
   * fontSize (NICE CATCH name is `40 * nameScale`) must share that space.
   */
  setVirtualSize(width: number, height: number): void {
    if (!(width > 0) || !(height > 0)) return
    const next = { width: Math.round(width), height: Math.round(height) }
    const prev = this.authoredVirtual
    if (prev && prev.width === next.width && prev.height === next.height) return
    this.authoredVirtual = next
    this.virtual = next
    this.layoutCache.clear()
    this.markContentDirty()
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

  private applyVirtual(interactable: ReturnType<typeof readInteractableArea>): void {
    const next = this.authoredVirtual ?? liveVirtualCanvas(interactable)
    if (next.width !== this.virtual.width || next.height !== this.virtual.height) {
      this.virtual = next
      this.layoutCache.clear()
      this.markContentDirty()
    }
  }

  /** Yoga layout → DOM paint for the committed worker mount set. */
  paint(view: ProjectionView): void {
    this.mirrorEcs = view.components
    this.lastView = view
    const ecs = view.components
    const interactable = readInteractableArea(this.getCanvas())
    this.applyVirtual(interactable)
    alignSceneUiRoot(this.root, interactable)
    const viewport = computeUiViewport(this.virtual, interactable)
    this.injectCanvasInfo(view, ecs, interactable, viewport)
    if (!this.domVisible) {
      // Mount still commits while hidden; revealPlayChrome → setVisible(true) repaints.
      // Never log per-frame (was flooding console + main-thread during 60s attach).
      return
    }
    // Phase C: skip full mount/record walk when nothing marked dirty since last paint.
    if (this.paintCount > 0 && this.paintedEpoch === this.contentEpoch) {
      return
    }

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

    // P2 text-only fast path: layout transforms unchanged, only UiText visual keys dirty.
    // Skip full Yoga + hit-map rebuild — patch label text on existing DOM nodes.
    // Never take this path when any previously-visible entity is gone/hidden — leave-seat
    // and modal close need a full forest walk (or patchEntities hide sweep).
    if (
      this.paintCount > 0 &&
      layoutKey === this.lastPaintLayoutKey &&
      this.lastLayoutBoxMap &&
      this.lastEntityLayoutKeys.size > 0
    ) {
      let hideInProgress = false
      if (this.lastLayoutBoxMap.size > 0) {
        for (const entity of this.lastLayoutBoxMap.keys()) {
          if (!mounted.has(entity) || !isUiEntityVisible(entity, transformOf)) {
            hideInProgress = true
            break
          }
        }
      }
      if (!hideInProgress) {
        const textOnlyDirty: Entity[] = []
        let layoutStable = true
        for (const { entity, transform } of records) {
          const lk = layoutTransformFingerprint(transform)
          if (this.lastEntityLayoutKeys.get(entity) !== lk) {
            layoutStable = false
            break
          }
        }
        if (layoutStable) {
          for (const [entity, key] of entityVisualKeys) {
            if (this.lastEntityVisualKeys.get(entity) !== key) textOnlyDirty.push(entity)
          }
          if (textOnlyDirty.length > 0 && textOnlyDirty.length <= 16 && this.lastUiForest) {
            const drawInput = {
              forest: this.lastUiForest,
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
              layoutBoxes: this.lastLayoutBoxMap,
              onRegions: (regions: UiScreenRegion[]) => this.hitMap.replace(regions)
            }
            if (this.dom.patchEntities(textOnlyDirty, drawInput)) {
              this.lastPaintVisualKey = visualKey
              this.lastEntityVisualKeys = entityVisualKeys
              this.paintedEpoch = this.contentEpoch
              return
            }
          }
        }
      }
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

    // Visual dirties (UV/color/text) + layout dirties (position/height). Fishing reeling
    // moves the lure marker via position.bottom only — visual key stays flat while the
    // zone UV changes; refine/patch must include pure layout movers or the lure freezes.
    const dirtyEntities: Entity[] = []
    const dirtySet = new Set<Entity>()
    const markDirty = (entity: Entity): void => {
      if (dirtySet.has(entity)) return
      dirtySet.add(entity)
      dirtyEntities.push(entity)
    }
    if (this.lastEntityVisualKeys.size > 0) {
      for (const [entity, key] of entityVisualKeys) {
        if (this.lastEntityVisualKeys.get(entity) !== key) markDirty(entity)
      }
      for (const entity of this.lastEntityVisualKeys.keys()) {
        if (!entityVisualKeys.has(entity)) markDirty(entity)
      }
    }
    const entityLayoutKeys = new Map<Entity, string>()
    for (const { entity, transform } of records) {
      const lk = layoutTransformFingerprint(transform)
      entityLayoutKeys.set(entity, lk)
      if (this.lastEntityLayoutKeys.size > 0 && this.lastEntityLayoutKeys.get(entity) !== lk) {
        markDirty(entity)
      }
    }
    if (this.lastEntityLayoutKeys.size > 0) {
      for (const entity of this.lastEntityLayoutKeys.keys()) {
        if (!entityLayoutKeys.has(entity)) markDirty(entity)
      }
    }

    // Layout-only dirties (position/size) — UV/text-only frames must not re-run Yoga.
    const layoutDirtyEntities: Entity[] = []
    if (this.lastEntityLayoutKeys.size > 0) {
      for (const [entity, lk] of entityLayoutKeys) {
        if (this.lastEntityLayoutKeys.get(entity) !== lk) layoutDirtyEntities.push(entity)
      }
      for (const entity of this.lastEntityLayoutKeys.keys()) {
        if (!entityLayoutKeys.has(entity)) layoutDirtyEntities.push(entity)
      }
    } else if (dirtyEntities.length > 0 && this.lastLayoutBoxMap) {
      // First dirty after mount — treat all dirties as layout until baseline is set.
      layoutDirtyEntities.push(...dirtyEntities)
    }

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

    // COD: large modal mounts (inventory ~700+) still refine absolute dirties aggressively
    // so reeling / slot tweaks never re-Yoga the whole tree every tick.
    const refineBudget = mounted.size >= 200 ? 96 : 48
    const patchBudget = mounted.size >= 200 ? 96 : 48

    let layoutBoxes = this.layoutCache.get(layoutKey)
    let layoutCacheHit = true
    let usedFullYoga = false
    if (!layoutBoxes) {
      layoutCacheHit = false
      // UV/color/text only — reuse last *full* Yoga boxes (COD: no thrash on reeling UV ticks).
      if (layoutDirtyEntities.length === 0 && this.lastFullLayoutBoxes?.length) {
        layoutBoxes = this.lastFullLayoutBoxes
        layoutCacheHit = true
      } else if (layoutDirtyEntities.length > 0 && this.lastFullLayoutBoxes?.length) {
        // Prefer absolute refine whenever we have a seed (GP reeling bar every tick).
        // Cap only as soft budget: still refine first N absolute movers rather than full Yoga.
        const seed = fullSeedMap()
        if (seed?.size) {
          const refineList =
            layoutDirtyEntities.length <= refineBudget
              ? layoutDirtyEntities
              : layoutDirtyEntities.slice(0, refineBudget)
          const refined = tryRefineAbsoluteLayoutBoxes(
            seed,
            refineList,
            transformOf,
            this.virtual
          )
          if (refined) {
            layoutBoxes = [...refined.values()]
            this.lastFullLayoutBoxes = layoutBoxes
            layoutCacheHit = true
            // Don't cache under transient reeling layoutKey — keep refining next frame.
          }
        }
      }
      if (!layoutBoxes) {
        layoutBoxes = runFullYoga()
        usedFullYoga = true
      }
    } else {
      this.lastFullLayoutBoxes = layoutBoxes
    }

    // Repair 0×0 icon wrappers (vending/inventory) before visibility filter + paint.
    // Must run on the full box list so parent→child multi-pass can unlock stacks.
    // Cache repaired geometry under layoutKey so we do not thrash fullYoga every frame
    // (logs showed repaired=53 every click → brutal animation stutter).
    let repairedCollapsed = repairCollapsedLayoutBoxes(layoutBoxes, transformOf, this.virtual)
    if (repairedCollapsed > 0) {
      this.lastFullLayoutBoxes = layoutBoxes
      this.layoutCache.set(layoutKey, layoutBoxes)
      // Prefer patch after repair when possible — geometry is now known.
      layoutCacheHit = true
    }

    // Poker seat rows / card slots stick at 0×0 under cached Yoga (collapsed=8, fullYoga=0).
    // Force one full forest layout when many collapsed remain after repair.
    if (!usedFullYoga && countCollapsedLayoutBoxes(layoutBoxes) > 4) {
      layoutBoxes = runFullYoga()
      usedFullYoga = true
      layoutCacheHit = false
      repairedCollapsed = repairCollapsedLayoutBoxes(layoutBoxes, transformOf, this.virtual)
      if (repairedCollapsed > 0) {
        this.lastFullLayoutBoxes = layoutBoxes
        this.layoutCache.set(layoutKey, layoutBoxes)
      }
    }

    let layoutBoxMap = new Map<Entity, LayoutBox>(
      visibleLayoutBoxes(layoutBoxes, transformOf).map((box) => [box.entity, box])
    )

    // Scale-tween mid-frames (how-to-play page flip, modal pulse) can collapse a full
    // panel to 6×6 and drop close/pagination children from the visible set. Restore last
    // good geometry so chrome stays painted while the tween recovers.
    if (this.lastLayoutBoxMap?.size) {
      for (const [entity, prev] of this.lastLayoutBoxMap) {
        if (!mounted.has(entity)) continue
        if (!isUiEntityVisible(entity, transformOf)) continue
        if (prev.width < 32 || prev.height < 32) continue
        const prevArea = prev.width * prev.height
        if (prevArea < 1500) continue

        const cur = layoutBoxMap.get(entity)
        if (!cur) {
          // Was visible last frame; still mounted+visible but missing a box — restore.
          layoutBoxMap.set(entity, {
            entity,
            left: prev.left,
            top: prev.top,
            relLeft: prev.relLeft,
            relTop: prev.relTop,
            width: prev.width,
            height: prev.height
          })
          continue
        }
        const curArea = cur.width * cur.height
        // Catastrophic shrink (e.g. 564×546 → 6×6) while parent content is tweening scale.
        if (curArea < 400 && curArea < prevArea * 0.12) {
          layoutBoxMap.set(entity, {
            entity,
            left: prev.left,
            top: prev.top,
            relLeft: prev.relLeft,
            relTop: prev.relTop,
            width: prev.width,
            height: prev.height
          })
        }
      }
    }

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
      layoutCacheHit = false
      repairCollapsedLayoutBoxes(layoutBoxes, transformOf, this.virtual)
      this.lastFullLayoutBoxes = layoutBoxes
      layoutBoxMap = new Map<Entity, LayoutBox>(
        visibleLayoutBoxes(layoutBoxes, transformOf).map((box) => [box.entity, box])
      )
    }

    const collapsedVisible = countCollapsedLayoutBoxes(layoutBoxMap.values())
    const prevVisibleCount = this.lastLayoutBoxMap?.size ?? 0
    // Visible set growth forces full forest walk (new modal children). Full Yoga alone does NOT —
    // same visible count after flex reflow can still patch dirty entities (COD: inventory fill).
    const visibleSetGrew =
      layoutBoxMap.size > prevVisibleCount + 2 || missingVisible.length > 0
    const visibleSetShrank = layoutBoxMap.size + 2 < prevVisibleCount
    // Any previously-visible entity now hidden (display:none / opacity / unmounted) —
    // force full forest walk so leave-seat / modal close cannot leave stacked DOM.
    let previouslyVisibleNowHidden = false
    if (this.lastLayoutBoxMap && this.lastLayoutBoxMap.size > 0) {
      for (const entity of this.lastLayoutBoxMap.keys()) {
        if (!mounted.has(entity) || !isUiEntityVisible(entity, transformOf)) {
          previouslyVisibleNowHidden = true
          break
        }
      }
    }
    const visibleDelta = Math.abs(layoutBoxMap.size - this.lastStableVisibleCount)
    if (visibleDelta <= 2 && layoutBoxMap.size > 0 && collapsedVisible <= 4) {
      this.stableVisibleStreak++
    } else {
      this.stableVisibleStreak = 0
      this.lastStableVisibleCount = layoutBoxMap.size
    }
    // Do not declare modal stable while any 0×0 icon cells remain (empty vendor / rod-bait dock).
    const modalStable =
      this.stableVisibleStreak >= 2 && layoutBoxMap.size >= 32 && collapsedVisible === 0

    // Prefer patch when: layout reused/refined, OR full Yoga but modal already open and few dirties.
    // Never patch while any collapsed icon cells remain — fishing rod/bait dock is only 2
    // cells; `collapsedVisible <= 4` used to leave them 0×0 forever until vendor open forced
    // a full forest walk.
    // Never patch when visibility shrinks (poker stand-up, shop close) — patch missed hide.
    const preferPatch =
      this.paintCount > 1 &&
      !visibleSetGrew &&
      !visibleSetShrank &&
      !previouslyVisibleNowHidden &&
      collapsedVisible === 0 &&
      repairedCollapsed === 0 &&
      dirtyEntities.length > 0 &&
      dirtyEntities.length <= patchBudget &&
      dirtyEntities.length < mounted.size * 0.4 &&
      (layoutCacheHit || (usedFullYoga && modalStable))

    if (
      (visibleSetGrew ||
        missingVisible.length > 0 ||
        repairedCollapsed > 0 ||
        collapsedVisible > 4 ||
        (usedFullYoga && !preferPatch)) &&
      typeof location !== 'undefined' &&
      location.search.includes('sceneuidebug')
    ) {
      console.log(
        `[scene-ui] layout paint — visibleYoga=${layoutBoxMap.size} prevVisible=${prevVisibleCount} ` +
          `fullYoga=${usedFullYoga ? 1 : 0} missingWas=${missingVisible.length} ` +
          `repaired=${repairedCollapsed} collapsed=${collapsedVisible} ` +
          `patchEligible=${preferPatch ? 1 : 0} stable=${this.stableVisibleStreak}`
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

    // Layout stable (or refined) + few dirties → patch DOM only (skip full tree walk).
    // Never patch when a menu just became visible — children need a full forest walk.
    let usedPatch = false
    if (preferPatch) {
      usedPatch = this.dom.patchEntities(dirtyEntities, drawInput)
    }

    if (!usedPatch) {
      this.dom.render(drawInput)
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
   * Deepest / smallest UI entity under the cursor with PET_HOVER_ENTER.
   * Click capture ignores hover-only nodes (supply pill, action-slot tooltips);
   * react-ecs onMouseEnter still needs that leaf so getInputCommand fires.
   */
  pickUiHoverHit(
    clientX: number,
    clientY: number,
    camera: THREE.Camera
  ): PointerHit | null {
    this.lastPointerClientX = clientX
    this.lastPointerClientY = clientY
    if (!this.domVisible) return null
    if (isForeignUiRootOnTop(this.root.id, clientX, clientY)) return null
    const ecs = this.mirrorEcs
    const view = this.lastView
    if (!ecs || !view) return null
    const handler = this.resolveUiHoverHandlerAtPoint(clientX, clientY)
    if (handler === null || this.input.isFieldEntity(handler)) return null
    return this.buildDomPointerHit(handler, camera)
  }

  private resolveUiHoverHandlerAtPoint(clientX: number, clientY: number): Entity | null {
    const ecs = this.mirrorEcs
    const view = this.lastView
    if (!ecs || !view) return null
    const transformOf = (e: Entity) => ecs.UiTransform.getOrNull(e)
    const candidates = this.collectTopClusterPickCandidates(clientX, clientY)
    let best: Entity | null = null
    let bestArea = Number.POSITIVE_INFINITY
    for (const entity of candidates) {
      if (this.input.isFieldEntity(entity)) continue
      const handler = findUiPointerHandlerEntity(
        ecs,
        view,
        entity,
        InputAction.IA_POINTER,
        PointerEventType.PET_HOVER_ENTER,
        this.pointerEventsLookup
      )
      if (handler === null) continue
      if (!isUiEntityVisible(handler, transformOf)) continue
      let area = this.candidatePickArea(handler)
      if (!Number.isFinite(area)) area = this.candidatePickArea(entity)
      if (
        this.isNearFullscreenPickArea(area) &&
        !isFullscreenUiPeAllowed(ecs, handler, { forest: this.lastUiForest })
      ) {
        continue
      }
      if (area < bestArea) {
        best = handler
        bestArea = area
      }
    }
    return best
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
    if (canvas && document.pointerLockElement === canvas) {
      canvas.style.cursor = 'none'
      this.root.style.cursor = 'none'
      return
    }
    // Hand cursor only when a real scene-UI node is under the point.
    // Invisible BLOCK hit-maps (welcome fade leftovers) used to pin canvas to pointer.
    if (next === 'pointer' && typeof document !== 'undefined') {
      const under = document.elementFromPoint(this.lastPointerClientX, this.lastPointerClientY)
      const onUi =
        under instanceof Element &&
        !!under.closest('.scene-ui-node, .scene-ui-root, [class*="scene-ui"]')
      if (!onUi) next = 'default'
    }
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