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
  DEFAULT_VIRTUAL_CANVAS,
  interactableInsetsVirtual,
  readInteractableArea,
  type VirtualCanvasSize
} from './virtualCanvas'
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
  setSceneUiAuthoritativeEntityCheck
} from './uiDomPick'
import {
  findUiPointerHandlerEntity,
  hasUiPointerEvent,
  isUiEntityBlocking,
  type UiPointerEventsLookup
} from './uiPointer'
import { InputAction, PointerEventType, type PointerEventTypeValue } from '../../input/pointerConstants'
import {
  computeUiLayoutKey,
  computeUiVisualPaintKey,
  UiLayoutCache,
  visibleLayoutBoxes
} from './uiLayoutCache'
import { layoutUiTree, type LayoutBox } from './yogaLayout'
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
  /** False until AppController reveals 3D play chrome — avoids UI on 2D landing during hydration. */
  private domVisible = false
  private readonly unbindImageLoaded: () => void
  private imageRepaintQueued = false
  /** Latest pointer phase-4 rows — authoritative for DOM hits when projection lags. */
  private mountSnapshotPointerEvents = new Map<Entity, unknown>()
  /** Last pointer position — re-evaluate cursor after Sync/modal DOM swaps. */
  private lastPointerClientX = 0
  private lastPointerClientY = 0

  constructor(scene: ResolvedScene | null = null, getCanvas: () => HTMLElement | null = () => null) {
    this.scene = scene
    this.getCanvas = getCanvas
    this.root = ensureSceneUiRoot()
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
    setSceneUiAuthoritativeEntityCheck((entity) => this.isAuthoritativeUiEntity(entity))
    this.unbindImageLoaded = onSceneUiImageLoaded(() => this.scheduleImageRepaint())
  }

  private scheduleImageRepaint(): void {
    if (!this.lastView) return
    // Many UiBackground textures finish in a burst (menus / character UI) — one paint, not N full Yoga passes.
    if (this.imageRepaintQueued) return
    this.imageRepaintQueued = true
    window.setTimeout(() => {
      this.imageRepaintQueued = false
      if (this.lastView) this.paint(this.lastView)
    }, 80)
  }

  /** Show/hide `#scene-ui-root` — only enable in 3D play mode, not 2D landing/explorer. */
  setVisible(visible: boolean): void {
    const wasVisible = this.domVisible
    this.domVisible = visible
    this.root.hidden = !visible
    if (!visible) return
    // Mount/commit often ran while hidden — drop paint skip keys so first reveal always paints.
    if (!wasVisible) {
      this.lastPaintLayoutKey = ''
      this.lastPaintVisualKey = ''
      this.lastEntityVisualKeys.clear()
      this.paintCount = 0
      this.firstPaintLogged = false
    }
    if (this.lastView) this.paint(this.lastView)
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
      this.mountSnapshotPointerEvents.set(row.entity as Entity, row.value)
    }
  }

  private pointerEventsLookup: UiPointerEventsLookup = (entity) => {
    const ecs = this.mirrorEcs
    if (this.isAuthoritativeUiEntity(entity)) {
      const fromSnapshot = this.mountSnapshotPointerEvents.get(entity)
      if (fromSnapshot) return fromSnapshot as ReturnType<UiPointerEventsLookup>
    }
    return ecs?.PointerEvents.getOrNull(entity) ?? null
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
      this.input.pruneStaleEntities(new Set())
    } else if (changed) {
      this.lastMountedUiEntities.clear()
      this.layoutCache.clear()
      this.lastPaintLayoutKey = ''
      this.lastPaintVisualKey = ''
      this.lastEntityVisualKeys.clear()
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
   * Every worker mount id must have UiTransform in projection before commit+paint.
   * applyUiFrame defers the whole frame when this fails — mount set and DOM stay in sync.
   */
  isMountSetReady(view: ProjectionView, mountSet?: ReadonlySet<Entity>): boolean {
    const target = mountSet ?? this.workerUiEntities
    if (!target?.size) return true
    const ecs = view.components
    let withTransform = 0
    for (const entity of target) {
      if (ecs.UiTransform.has(entity)) withTransform++
    }
    const ready = withTransform >= target.size
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
      if (
        this.workerUiEntitiesKnown &&
        (this.workerUiEntities?.size ?? 0) > 0 &&
        typeof location !== 'undefined' &&
        location.search.includes('sceneuidebug')
      ) {
        console.log(
          `[scene-ui] paint deferred — play chrome not revealed yet (mount=${this.workerUiEntities!.size})`
        )
      }
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
      return
    }

    this.paintCount++
    const mountSize = this.workerUiEntities?.size ?? 0
    if (!this.firstPaintLogged) {
      this.firstPaintLogged = true
      console.info(
        `[scene-ui] first paint — mount=${mountSize} canvas=${records.length} virtual=${this.virtual.width}×${this.virtual.height}`
      )
    } else if (this.paintCount <= 12) {
      console.info(`[scene-ui] repaint #${this.paintCount} — mount=${mountSize} canvas=${records.length}`)
    } else if (mountSize !== this.lastLoggedPaintMount) {
      this.lastLoggedPaintMount = mountSize
      console.info(`[scene-ui] repaint mount change — mount=${mountSize} canvas=${records.length}`)
      if (isSceneUiDebugEnabled() && mountSize >= 10) {
        const peIds = [...this.mountSnapshotPointerEvents.keys()]
          .sort((a, b) => (a as number) - (b as number))
          .map((e) => `e${e}`)
        console.log(
          `[scene-ui] mount snapshot PointerEvents (${peIds.length}): ${peIds.join(', ') || '(none)'}`
        )
      }
    }

    let layoutBoxes = this.layoutCache.get(layoutKey)
    let layoutCacheHit = true
    if (!layoutBoxes) {
      layoutCacheHit = false
      const { boxes, dispose } = layoutUiTree(
        records,
        forest,
        this.virtual.width,
        this.virtual.height,
        textOf,
        inputOf
      )
      layoutBoxes = boxes
      dispose()
      this.layoutCache.set(layoutKey, layoutBoxes)
    }
    const layoutBoxMap = new Map<Entity, LayoutBox>(
      visibleLayoutBoxes(layoutBoxes, transformOf).map((box) => [box.entity, box])
    )

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

    // Layout stable + few visual-only dirties → patch DOM only (skip full tree walk).
    let usedPatch = false
    if (layoutCacheHit && this.lastEntityVisualKeys.size > 0 && this.paintCount > 1) {
      const dirty: Entity[] = []
      for (const [entity, key] of entityVisualKeys) {
        if (this.lastEntityVisualKeys.get(entity) !== key) dirty.push(entity)
      }
      for (const entity of this.lastEntityVisualKeys.keys()) {
        if (!entityVisualKeys.has(entity)) dirty.push(entity)
      }
      if (dirty.length > 0 && dirty.length <= 32 && dirty.length < mounted.size * 0.25) {
        usedPatch = this.dom.patchEntities(dirty, drawInput)
        if (usedPatch && this.paintCount <= 20) {
          console.info(`[scene-ui] incremental paint — dirty=${dirty.length} mount=${mounted.size}`)
        }
      }
    }

    if (!usedPatch) {
      this.dom.render(drawInput)
    }

    this.lastPaintLayoutKey = layoutKey
    this.lastPaintVisualKey = visualKey
    this.lastEntityVisualKeys = entityVisualKeys

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
    const canvas = this.getCanvas()
    if (!canvas || typeof document === 'undefined') return
    const x = this.lastPointerClientX
    const y = this.lastPointerClientY
    if (!x && !y) {
      canvas.style.cursor = 'default'
      this.root.style.cursor = 'default'
      return
    }
    const under = document.elementFromPoint(x, y)
    const interactive =
      under instanceof Element &&
      !!under.closest('.scene-ui-node--interactive, .scene-ui-node__input, .scene-ui-node__select')
    const next = interactive ? 'pointer' : 'default'
    canvas.style.cursor = next
    this.root.style.cursor = next
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
    if (!this.domVisible) return null
    const ecs = this.mirrorEcs
    const view = this.lastView
    if (!ecs || !view) return null

    const topmost = this.pickTopmostUiLayer(clientX, clientY)
    if (topmost === null) return null
    if (this.input.isFieldEntity(topmost.entity)) {
      return this.buildDomPointerHit(topmost.entity, camera)
    }
    if (!topmost.blocking) return null

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

  private candidatePickArea(entity: Entity): number {
    const region = this.hitMap.regionFor(entity)
    return region ? region.width * region.height : Number.POSITIVE_INFINITY
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

    const candidates = this.collectTopClusterPickCandidates(clientX, clientY, eventTarget)
    let best: { entity: Entity; blocking: boolean } | null = null
    let bestArea = Number.POSITIVE_INFINITY

    for (const entity of candidates) {
      if (this.input.isFieldEntity(entity)) return { entity, blocking: true }
      if (!isUiEntityBlocking(ecs, entity, this.pointerEventsLookup)) continue
      const area = this.candidatePickArea(entity)
      if (area < bestArea) {
        bestArea = area
        best = { entity, blocking: true }
      }
    }
    return best
  }

  /**
   * Resolve the react-ecs onMouseDown handler for a click.
   * Smallest leaf region wins — label → card beats fullscreen modal scrim.
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
    const debugPick = isSceneUiDebugEnabled() && state === PointerEventType.PET_DOWN
    if (debugPick) {
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
        console.log(
          `[scene-ui]   region e${region.entity} depth=${region.depth} z=${region.zIndex} ${Math.round(region.width)}×${Math.round(region.height)} area=${Math.round(area)} handler=${handler ?? '—'}`
        )
      }
    }

    let bestHandler: Entity | null = null
    let bestHandlerArea = Number.POSITIVE_INFINITY
    let blockingEntity: Entity | null = null
    let blockingArea = Number.POSITIVE_INFINITY

    for (const entity of candidates) {
      // Skip field rows — SceneUiInputController owns them; do not abort the whole pick (search
      // input is an ancestor candidate when clicking LOAD/DEL pills in the presets table).
      if (this.input.isFieldEntity(entity)) continue

      const area = this.candidatePickArea(entity)
      const handler = findUiPointerHandlerEntity(
        ecs,
        view,
        entity,
        InputAction.IA_POINTER,
        state,
        this.pointerEventsLookup
      )
      if (handler !== null) {
        if (area < bestHandlerArea) {
          bestHandlerArea = area
          bestHandler = handler
        }
        continue
      }

      if (isUiEntityBlocking(ecs, entity, this.pointerEventsLookup) && area < blockingArea) {
        blockingArea = area
        blockingEntity = entity
      }
    }

    if (bestHandler !== null) {
      if (debugPick) {
        const fromSnapshot = this.mountSnapshotPointerEvents.has(bestHandler)
        const parent = ecs.UiTransform.getOrNull(bestHandler)?.parent ?? 0
        console.log(
          `[scene-ui] pick → handler e${bestHandler} parent=e${parent} leafArea=${Math.round(bestHandlerArea)} snapshotPe=${fromSnapshot} (${clientX},${clientY})`
        )
      }
      return bestHandler
    }

    if (blockingEntity !== null) {
      if (debugPick) {
        console.log(
          `[scene-ui] pick → blocked e${blockingEntity} area=${Math.round(blockingArea)} (${clientX},${clientY})`
        )
      }
      return null
    }
    if (debugPick) {
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
    const info: PBUiCanvasInformation = {
      devicePixelRatio: window.devicePixelRatio || 1,
      width: this.virtual.width,
      height: this.virtual.height,
      interactableArea: insets,
      screenInsetArea: insets
    }
    const key = JSON.stringify(info)
    if (key === this.lastCanvasKey) return
    this.lastCanvasKey = key
    ecs.UiCanvasInformation.createOrReplace(view.RootEntity, info)
  }
}