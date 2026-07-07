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
import { disposeSceneUiDebug, reportInputModifierState, reportSceneUiDebug } from './sceneUiDebug'
import {
  collectSceneUiEntitiesFromDom,
  entityFromSceneUiDomTarget,
  pickSceneUiEntityFromDom,
  setSceneUiAuthoritativeEntityCheck
} from './uiDomPick'
import {
  hasDirectUiPointerHandler,
  hasUiPointerDownOrUp,
  hasUiPointerEvent,
  resolveUiPointerResultEntity,
  type UiPointerEventsLookup
} from './uiPointer'
import { normalizePointerFilterMode, PointerFilterMode } from './yogaEnums'
import { InputAction, PointerEventType, type PointerEventTypeValue } from '../../input/pointerConstants'
import { computeUiLayoutKey, UiLayoutCache, visibleLayoutBoxes } from './uiLayoutCache'
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
  private readonly unbindImageLoaded: () => void
  private imageRepaintQueued = false
  /** Latest pointer phase-4 rows — authoritative for DOM hits when projection lags. */
  private mountSnapshotPointerEvents = new Map<Entity, unknown>()

  constructor(scene: ResolvedScene | null = null, getCanvas: () => HTMLElement | null = () => null) {
    this.scene = scene
    this.getCanvas = getCanvas
    this.root = ensureSceneUiRoot()
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
    if (this.imageRepaintQueued || !this.lastView) return
    this.imageRepaintQueued = true
    queueMicrotask(() => {
      this.imageRepaintQueued = false
      if (this.lastView) this.paint(this.lastView)
    })
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
    const fromProjection = ecs?.PointerEvents.getOrNull(entity) ?? null
    if (fromProjection) return fromProjection
    if (!this.isAuthoritativeUiEntity(entity)) return null
    return (
      (this.mountSnapshotPointerEvents.get(entity) as ReturnType<UiPointerEventsLookup>) ?? null
    )
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
      this.input.pruneStaleEntities(new Set())
    } else if (changed) {
      this.lastMountedUiEntities.clear()
      this.layoutCache.clear()
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
    const ecs = view.components

    const interactable = readInteractableArea(this.getCanvas())
    alignSceneUiRoot(this.root, interactable)
    const viewport = computeUiViewport(this.virtual, interactable)
    this.injectCanvasInfo(view, ecs, interactable, viewport)

    if (!this.workerUiEntitiesKnown || !this.workerUiEntities?.size) {
      this.scrubUnauthoritativeDom()
      disposeSceneUiDebug()
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
      return
    }

    this.paintCount++
    if (!this.firstPaintLogged) {
      this.firstPaintLogged = true
      console.info(
        `[scene-ui] first paint — mount=${this.workerUiEntities?.size ?? 0} canvas=${records.length} virtual=${this.virtual.width}×${this.virtual.height}`
      )
    } else if (this.paintCount <= 12) {
      console.info(`[scene-ui] repaint #${this.paintCount} — canvas=${records.length}`)
    }

    const forest = buildUiForest(records)
    const transformOf = (e: Entity) => ecs.UiTransform.getOrNull(e) as PBUiTransform | null
    const textOf = (e: Entity) => ecs.UiText.getOrNull(e) as PBUiText | null
    const inputOf = (e: Entity) => ecs.UiInput.getOrNull(e) as PBUiInput | null

    const layoutKey = computeUiLayoutKey(records, this.virtual, textOf, inputOf)
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

    this.dom.render({
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
      dropdownOf: (e) => ecs.UiDropdown.getOrNull(e) as PBUiDropdown | null,
      backgroundOf: (e) => ecs.UiBackground.getOrNull(e) as PBUiBackground | null,
      mountedEntities: mounted,
      authoritativeEntities: this.workerUiEntities,
      layoutBoxes: layoutBoxMap,
      onRegions: (regions) => this.hitMap.replace(regions)
    })
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
  }

  /** Blocks 3D raycast only over DOM nodes that are themselves blocking. */
  pickUiRegionHit(
    clientX: number,
    clientY: number,
    camera: THREE.Camera
  ): PointerHit | null {
    const ecs = this.mirrorEcs
    const view = this.lastView
    if (!ecs || !view) return null
    const entity = pickSceneUiEntityFromDom(clientX, clientY, (e) =>
      this.acceptPickableUiEntity(ecs, e)
    )
    if (entity === null) return null
    const handler = resolveUiPointerResultEntity(
      ecs,
      view,
      entity,
      InputAction.IA_POINTER,
      PointerEventType.PET_DOWN,
      this.pointerEventsLookup
    )
    return this.buildDomPointerHit(handler, camera)
  }

  /**
   * Pick list membership — explicit pointerFilter BLOCK, onPointerDown/Up (PointerEvents),
   * or UiInput/UiDropdown only. Default is pass-through (pointer-events: none).
   */
  private acceptPickableUiEntity(ecs: MirrorComponents, entity: Entity): boolean {
    if (!this.isAuthoritativeUiEntity(entity)) return false
    if (this.input.isFieldEntity(entity)) return true
    const spec = this.pointerEventsLookup(entity)
    if (hasUiPointerDownOrUp(spec)) return true
    const transform = ecs.UiTransform.getOrNull(entity)
    return (
      transform !== null &&
      transform !== undefined &&
      normalizePointerFilterMode(transform.pointerFilter) === PointerFilterMode.BLOCK
    )
  }

  private filterPickRegions(clientX: number, clientY: number, regions: readonly UiScreenRegion[]): UiScreenRegion[] {
    let filtered = [...regions]
    const vw = typeof window !== 'undefined' ? window.innerWidth : 1920
    const vh = typeof window !== 'undefined' ? window.innerHeight : 1080
    const nestedDialogs = filtered.filter(
      (r) => r.width < vw * 0.75 && r.height < vh * 0.75 && r.width > 48 && r.height > 48
    )
    if (
      nestedDialogs.some(
        (r) =>
          clientX >= r.left &&
          clientX <= r.left + r.width &&
          clientY >= r.top &&
          clientY <= r.top + r.height
      )
    ) {
      filtered = filtered.filter((r) => !(r.width >= vw * 0.85 && r.height >= vh * 0.85))
    }

    const headerBands = filtered.filter(
      (r) => r.height > 0 && r.height <= 80 && clientY >= r.top && clientY <= r.top + r.height
    )
    if (headerBands.length) {
      const bandBottom = Math.max(...headerBands.map((r) => r.top + r.height))
      filtered = filtered.filter((r) => {
        if (r.height <= 80) return true
        if (r.top >= bandBottom - 1 && r.height > 96) return false
        return true
      })
    }
    return filtered
  }

  /**
   * Deepest yoga layout box at (x,y) — parent-walk for onMouseDown happens in resolveUiHandlerAtPoint.
   * Header-band filter keeps tab-row clicks off panel BLOCK regions stacked below.
   */
  private pickDomEntity(
    clientX: number,
    clientY: number,
    ecs: MirrorComponents,
    target?: EventTarget | null
  ): Entity | null {
    const view = this.lastView
    const accept = (e: Entity) => this.acceptPickableUiEntity(ecs, e)

    const domCandidates: Entity[] = []
    const seenDom = new Set<number>()
    const pushDom = (entity: Entity | null): void => {
      if (entity === null || !accept(entity)) return
      const id = entity as number
      if (seenDom.has(id)) return
      seenDom.add(id)
      domCandidates.push(entity)
    }
    pushDom(entityFromSceneUiDomTarget(target ?? null, accept))
    for (const entity of collectSceneUiEntitiesFromDom(clientX, clientY, accept)) {
      pushDom(entity)
    }

    if (view) {
      for (const entity of domCandidates) {
        if (
          hasDirectUiPointerHandler(
            ecs,
            entity,
            InputAction.IA_POINTER,
            PointerEventType.PET_DOWN,
            this.pointerEventsLookup
          )
        ) {
          return entity
        }
      }
    }

    const regions = this.filterPickRegions(
      clientX,
      clientY,
      this.hitMap.hitTestRegionCandidates(clientX, clientY)
    )
    if (view) {
      for (const region of regions) {
        if (!this.isAuthoritativeUiEntity(region.entity)) continue
        if (
          hasDirectUiPointerHandler(
            ecs,
            region.entity,
            InputAction.IA_POINTER,
            PointerEventType.PET_DOWN,
            this.pointerEventsLookup
          )
        ) {
          return region.entity
        }
      }
    }

    return null
  }

  /** Interactive DOM only — must not steal canvas orbit / 3D clicks. */
  private resolveUiHandlerAtPoint(
    clientX: number,
    clientY: number,
    state: PointerEventTypeValue = PointerEventType.PET_DOWN,
    eventTarget?: EventTarget | null
  ): Entity | null {
    const ecs = this.mirrorEcs
    const view = this.lastView
    if (!ecs || !view) return null

    const domEntity = this.pickDomEntity(clientX, clientY, ecs, eventTarget)
    if (domEntity === null) return null
    return resolveUiPointerResultEntity(
      ecs,
      view,
      domEntity,
      InputAction.IA_POINTER,
      state,
      this.pointerEventsLookup
    )
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