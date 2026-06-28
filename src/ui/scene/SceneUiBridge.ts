import type { Entity } from '@dcl/ecs'
import * as THREE from 'three'
import type { PBUiCanvasInformation } from '@dcl/ecs/dist/components/generated/pb/decentraland/sdk/components/ui_canvas_information.gen'
import type { PBUiBackground } from '@dcl/ecs/dist/components/generated/pb/decentraland/sdk/components/ui_background.gen'
import type { PBUiDropdown } from '@dcl/ecs/dist/components/generated/pb/decentraland/sdk/components/ui_dropdown.gen'
import type { PBUiInput } from '@dcl/ecs/dist/components/generated/pb/decentraland/sdk/components/ui_input.gen'
import type { PBUiText } from '@dcl/ecs/dist/components/generated/pb/decentraland/sdk/components/ui_text.gen'
import type { PBUiTransform } from '@dcl/ecs/dist/components/generated/pb/decentraland/sdk/components/ui_transform.gen'
import type { ProjectionView } from '../../bridge/ProjectionView'
import type { MirrorComponents } from '../../bridge/mirrorComponents'
import type { ResolvedScene } from '../../dcl/content/types'
import type { PointerHit } from '../../input/PointerEventsSystem'
import { buildUiForest, type UiEntityRecord } from './uiTree'
import { layoutUiTree } from './yogaLayout'
import {
  UiLayoutCache,
  computeUiLayoutKey,
  visibleLayoutBoxes
} from './uiLayoutCache'
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
import { SceneUiHitMap } from './uiHitMap'
import { disposeSceneUiDebug, reportSceneUiDebug } from './sceneUiDebug'
import { hasUiPointerEvent, resolveUiPointerResultEntity } from './uiPointer'
import { InputAction, PointerEventType, type PointerEventTypeValue } from '../../input/pointerConstants'

const _camPos = new THREE.Vector3()

export type SceneUiWriteback = {
  writeInputResult: (entity: Entity, value: string, isSubmit?: boolean) => void
  writeDropdownResult: (entity: Entity, index: number) => void
  flushLww?: () => void
}

/** In-scene ECS UI — Yoga layout + DOM overlay + UiCanvasInformation back to scene. */
export class SceneUiBridge {
  private readonly root: HTMLElement
  private readonly dom: SceneUiDomRenderer
  private readonly input!: SceneUiInputController
  private readonly hitMap = new SceneUiHitMap()
  private scene: ResolvedScene | null = null
  private virtual: VirtualCanvasSize = { ...DEFAULT_VIRTUAL_CANVAS }
  private lastCanvasKey = ''
  private writeback: SceneUiWriteback | null = null
  private mirrorEcs: MirrorComponents | null = null
  private readonly layoutCache = new UiLayoutCache()
  private readonly getCanvas: () => HTMLElement | null

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
      onFormFocus: (entity) => this.input.onFieldFocus(entity),
      onFormBlur: (entity) => this.input.onFieldBlur(entity),
      isEditingEntity: (entity) => this.input.isEditingEntity(entity),
      shouldPinEntity: (entity, el) => this.input.shouldPinEntity(entity, el)
    })
    this.input = new SceneUiInputController({
      hitMap: this.hitMap,
      getEcs: () => this.mirrorEcs,
      getFormField: (entity) => this.dom.getFormField(entity)
    })
    this.input.bind()
  }

  bindWriteback(writeback: SceneUiWriteback): void {
    this.writeback = writeback
  }

  /** PointerEventsSystem — single gate for form clicks (hit map + DOM target). */
  consumeFormPointerDown(clientX: number, clientY: number, target: EventTarget | null): boolean {
    return this.input.consumePointerDown(clientX, clientY, target)
  }

  isFormEntity(entity: Entity): boolean {
    return this.input.isFormEntity(entity)
  }

  isTypingActive(): boolean {
    return this.input.isTypingActive()
  }

  /** Override virtual screen size (e.g. from scene `setUiRenderer` options). */
  setVirtualSize(width: number, height: number): void {
    if (!Number.isFinite(width) || !Number.isFinite(height)) return
    if (width > 0 && height > 0) {
      this.virtual = { width: Math.floor(width), height: Math.floor(height) }
    }
  }

  dispose(): void {
    this.input.dispose()
    this.dom.dispose()
    this.hitMap.clear()
    this.layoutCache.clear()
    this.mirrorEcs = null
    disposeSceneUiDebug()
    this.root.remove()
  }

  sync(view: ProjectionView): void {
    this.mirrorEcs = view.components
    const ecs = view.components
    const records = this.collectUiRecords(view)
    if (records.length === 0) {
      this.dom.dispose()
      this.hitMap.clear()
      this.layoutCache.clear()
      const interactable = readInteractableArea(this.getCanvas())
      alignSceneUiRoot(this.root, interactable)
      this.injectCanvasInfo(view, ecs, interactable, computeUiViewport(this.virtual, interactable))
      return
    }

    const forest = buildUiForest(records)
    const textOf = (e: Entity) => ecs.UiText.getOrNull(e) as PBUiText | null
    const inputOf = (e: Entity) => ecs.UiInput.getOrNull(e) as PBUiInput | null
    const transformOf = (e: Entity) => ecs.UiTransform.getOrNull(e) as PBUiTransform | null

    const layoutKey = computeUiLayoutKey(records, this.virtual, textOf, inputOf)
    const layoutCacheHit = this.layoutCache.get(layoutKey) !== null
    let yogaBoxes = this.layoutCache.get(layoutKey)
    let disposeYoga = () => {}

    if (!yogaBoxes) {
      const laid = layoutUiTree(
        records,
        forest,
        this.virtual.width,
        this.virtual.height,
        textOf,
        inputOf
      )
      yogaBoxes = laid.boxes
      this.layoutCache.set(layoutKey, yogaBoxes)
      disposeYoga = laid.dispose
    }

    const boxes = visibleLayoutBoxes(yogaBoxes, transformOf)

    try {
      const interactable = readInteractableArea(this.getCanvas())
      alignSceneUiRoot(this.root, interactable)
      const viewport = computeUiViewport(this.virtual, interactable)
      this.dom.render({
        boxes,
        virtual: this.virtual,
        interactable,
        viewport,
        scene: this.scene,
        ecs,
        transformOf,
        textOf: (e) => ecs.UiText.getOrNull(e) as PBUiText | null,
        inputOf: (e) => ecs.UiInput.getOrNull(e) as PBUiInput | null,
        dropdownOf: (e) => ecs.UiDropdown.getOrNull(e) as PBUiDropdown | null,
        backgroundOf: (e) => ecs.UiBackground.getOrNull(e) as PBUiBackground | null,
        onRegions: (regions) => this.hitMap.replace(regions)
      })
      this.injectCanvasInfo(view, ecs, interactable, viewport)
    } finally {
      disposeYoga()
    }

    const formEntities: Entity[] = []
    let uiInputCount = 0
    for (const [entity] of view.getEntitiesWith(ecs.UiInput)) {
      uiInputCount++
      formEntities.push(entity)
    }
    for (const [entity] of view.getEntitiesWith(ecs.UiDropdown)) {
      formEntities.push(entity)
    }
    reportSceneUiDebug({
      hitMap: this.hitMap,
      dom: this.dom,
      formEntities,
      uiInputCount,
      domInputCount: this.root.querySelectorAll('.scene-ui-node__input, .scene-ui-node__select').length,
      layoutCacheHit
    })
  }

  /** Any scene UI region at screen coords — blocks 3D raycast when over overlay. */
  pickUiRegionHit(
    clientX: number,
    clientY: number,
    camera: THREE.Camera
  ): PointerHit | null {
    const entity = this.hitMap.hitTest(clientX, clientY)
    if (entity === null) return null
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

  /** Screen-space UI hit for buttons/labels (excludes UiInput / UiDropdown). */
  pickUiPointerHit(
    clientX: number,
    clientY: number,
    ecs: MirrorComponents,
    view: ProjectionView,
    camera: THREE.Camera,
    state: PointerEventTypeValue = PointerEventType.PET_DOWN
  ): PointerHit | null {
    const button = InputAction.IA_POINTER
    const candidates = this.hitMap.hitTestCandidates(clientX, clientY)
    for (const entity of candidates) {
      if (this.input.isFormEntity(entity)) continue

      const target = resolveUiPointerResultEntity(ecs, view, entity, button, state)
      const spec = ecs.PointerEvents.getOrNull(target)
      if (!hasUiPointerEvent(spec, state, button)) {
        if (
          state === PointerEventType.PET_UP &&
          hasUiPointerEvent(spec, PointerEventType.PET_DOWN, button)
        ) {
          /* onClick registers PET_DOWN only */
        } else {
          continue
        }
      }

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
    return null
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

  private collectUiRecords(view: ProjectionView): UiEntityRecord[] {
    const ecs = view.components
    const out: UiEntityRecord[] = []
    for (const [entity] of view.getEntitiesWith(ecs.UiTransform)) {
      const transform = ecs.UiTransform.getOrNull(entity) as PBUiTransform | null
      if (!transform) continue
      out.push({ entity, transform })
    }
    return out
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