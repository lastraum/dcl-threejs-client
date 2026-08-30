import * as THREE from 'three'
import type { Entity } from '@dcl/ecs'
import type { ProjectionView } from '../bridge/ProjectionView'
import type { PBPointerEvents_Entry } from '@dcl/ecs/dist/components/generated/pb/decentraland/sdk/components/pointer_events.gen'
import type { PBPointerEventsResult } from '@dcl/ecs/dist/components/generated/pb/decentraland/sdk/components/pointer_events_result.gen'
import type { RaycastHit } from '@dcl/ecs/dist/components/generated/pb/decentraland/sdk/components/common/raycast_hit.gen'
import { InputAction, InteractionType, PointerEventType, type InputActionValue, type PointerEventTypeValue } from './pointerConstants'
import { inputActionBinding, inputActionInteractLabel, keyCodeToInputActionBinding } from './inputActionBinding'
import type { MirrorComponents } from '../bridge/mirrorComponents'
import { threeToDclVec } from '../bridge/dclTransform'
import {
  resolveEntityWorldPosition,
  type EntityWorldTransformDeps
} from '../transform/entityWorldTransform'
import type { CollisionSystem } from '../collision/CollisionSystem'
import { ColliderLayer } from '../collision/ColliderLayer'
import { isGltfInvisibleColliderMesh } from '../collision/gltfColliderNaming'
import {
  collectGltfLayerTargetMeshes,
  collectGltfPointerTargetMeshes,
  gltfEntityDrawRoot
} from '../collision/gltfPointerMeshes'
import { PointerHighlightFeedback, pointerShowHighlight } from './PointerHighlightFeedback'
import { PointerHoverFeedback } from './PointerHoverFeedback'
import { clientDebugLog } from '../client/debug/ClientDebugLog'
import { findPeerPillAtPointer, tryOpenPeerContextMenu } from '../client/ui/overlayHitTest'
import type { InjectPointerClickBody } from '../player/injectPointerClick'
import {
  collectUiPointerResultTargets,
  hasUiPointerEvent,
  resolveUiPointerResultEntity
} from '../ui/scene/uiPointer'
import { isPointerOverSceneUi, isSceneUiDomTarget } from '../ui/scene/sceneUiOverlay'
import {
  isForeignUiPointerOwner,
  isUiOverlayPointerEvent,
  uiPointerOwnerOf
} from '../ui/scene/uiPointerGate'
import { isTextInputFocused } from '../client/ui/textInputFocus'
import { POINTER_LOCK_AIM_NDC_Y, pointerLockAim } from './pointerLockAim'
import { isSceneUiFieldDom, isSceneUiTypingFocus } from '../ui/scene/sceneUiTyping'
import { nextPointerEventTimestamp } from './pointerEventTimestamp'


export type PointerHit = {
  entity: Entity
  point: THREE.Vector3
  distance: number
  normal: THREE.Vector3
  meshName?: string
  priority: number
  cameraDistance: number
  playerDistance: number
  inRange: boolean
  /** Screen-space ECS UI — skip 3D distance checks. */
  isSceneUi?: boolean
  /**
   * Global IA_POINTER edge on PlayerEntity when no PE mesh is in range.
   * Updates inputSystem.isPressed / isTriggered only — does NOT invent a ground-plane
   * hit.position (scenes aim via PrimaryPointerInfo.worldRayDirection × CameraEntity).
   */
  isLevelState?: boolean
}

type PointerDeps = {
  ecs: MirrorComponents
  view: ProjectionView
  collision: CollisionSystem
  getEntityNodes: () => Map<Entity, THREE.Group>
  getWorldTransformDeps: () => EntityWorldTransformDeps | null
  camera: THREE.Camera
  getPlayerPosition: () => THREE.Vector3 | null
  isPointerBlocked: () => boolean
  /**
   * Pointer-lock look. Unlocked LMB is camera orbit (PlayerInput) — not IA_POINTER.
   * Sending level-state PET_DOWN on orbit drag froze the worker while the player
   * was only looking / running.
   */
  isPointerLocked?: () => boolean
  /**
   * Scene VirtualCamera owns the lens (MainCamera bound). Unlocked LMB is then
   * scene `isPressed(IA_POINTER)` + PPI drag — not freecam orbit.
   */
  isLookBlocked?: () => boolean
  /** Worker mount snapshot fallback when projection PointerEvents lags paint. */
  pointerEventsOf?: (entity: Entity) => { pointerEvents: ReadonlyArray<PBPointerEvents_Entry> } | null | undefined
  flushPointerCrdt?: () => void
  /** World PE hit (not level-state / UI) — client tag VFX etc. */
  onWorldPointerDown?: (entity: Entity) => void
  /** Flush matrixWorld + collider poses immediately before a raycast (click / hover). */
  prepareRaycast?: () => void
  /**
   * Source-capture grow-only appends for the outbound CrdtEncoder.
   * PointerEventsResult is ignored at the SceneScriptSystem gate (inject-only PE law);
   * TriggerArea and other writers still use this.
   */
  recordAppend?: (componentId: number, entity: Entity, value: unknown) => void
  /** Scene UI click — DOM overlay (`#scene-ui-root`) → entity → worker inject. */
  pickUiHit?: (clientX: number, clientY: number, target?: EventTarget | null) => PointerHit | null
  /** SceneUiInputController — UiInput / UiDropdown clicks must not become ECS pointer events. */
  consumeSceneUiFieldPointer?: (clientX: number, clientY: number, target: EventTarget | null) => boolean
  isSceneUiFieldEntity?: (entity: Entity) => boolean
  isSceneUiTypingActive?: () => boolean
  /** Interactive scene UI at coords — blocks 3D raycast when over the DOM overlay. */
  pickUiRegionHit?: (clientX: number, clientY: number) => PointerHit | null
  /** Smallest UI entity with PET_HOVER_ENTER under the cursor (action-slot tooltips). */
  pickUiHoverHit?: (clientX: number, clientY: number) => PointerHit | null
  /**
   * Host root this system paints (`scene-ui-root` | `pe-ui-root`).
   * Required so primary does not inject under a PX dialog (dual window listeners).
   */
  uiRootId?: string
  /** Dense MeshRenderer InstancedMesh → entity (instanceId from raycast). */
  resolveMeshRendererInstanceHit?: (mesh: THREE.Object3D, instanceId: number) => Entity | null
  /** Unique InstancedMeshes that host PointerEvents entities (raycast targets). */
  getMeshRendererInstancePointerMeshes?: () => THREE.Object3D[]
  /** InstancedMeshes for this PE set only — never the full board. */
  getInstancePointerMeshesFor?: (entities: Iterable<Entity>) => THREE.Object3D[]
  /**
   * Promote PE MeshRenderer/GLTF instances to private leaves before target collect.
   * Shared by hover tooltips and click (same raycast path).
   */
  ensurePointerMeshes?: () => void
}

const _ray = new THREE.Ray()
const _ndc = new THREE.Vector2()
const _camPos = new THREE.Vector3()
const _playerPos = new THREE.Vector3()
const _entityPos = new THREE.Vector3()
const _worldNormal = new THREE.Vector3()

/** DrawWorld parents `__mesh_*` under drawRoot — pose children are empty. */
function poseDrawVisual(
  obj: THREE.Object3D | undefined,
  entity?: Entity
): THREE.Object3D | undefined {
  return gltfEntityDrawRoot(obj, entity)
}

/** Unity splits raycast (`PointerEventsController`) from result writer (`ECSPointerInputSystem`); we combine both here. */
export class PointerEventsSystem {
  private deps: PointerDeps | null = null
  private readonly raycaster = new THREE.Raycaster()
  private readonly pointerTargets: THREE.Object3D[] = []
  private readonly pointerEntitySet = new Set<Entity>()
  private readonly childrenByParent = new Map<Entity, Entity[]>()
  private pointerCacheDirty = true
  private readonly hoverFeedback = new PointerHoverFeedback()
  private readonly highlightFeedback = new PointerHighlightFeedback()

  private screenX = 0
  private screenY = 0
  private screenDx = 0
  private screenDy = 0
  private pointerDirty = true
  /** Last hover raycast. Move only refreshes coords; prepare runs on edges + this cadence. */
  private lastHoverPrepareAt = 0
  private hoverScreenX = Number.NaN
  private hoverScreenY = Number.NaN
  private static readonly HOVER_PREPARE_MS = 80
  private primaryKeyDown = false
  private readonly pendingPointerDown = new Map<InputActionValue, PointerHit | null>()
  private readonly pendingPointerUp = new Set<InputActionValue>()
  /**
   * Buttons whose PET_DOWN was level-state on PlayerEntity (no PE mesh).
   * Must pair PET_UP without requiring a PointerEvents component on PlayerEntity.
   */
  private readonly levelStateButtons = new Set<InputActionValue>()
  /**
   * Next press while a prior press is still open (downEntity set / pending DOWN).
   * Click-spam must not overwrite downEntity or getClick never pairs DOWN+UP.
   */
  private readonly stashedPointerDown = new Map<InputActionValue, PointerHit | null>()

  private hoverEntity: Entity | null = null
  private lastHit: PointerHit | null = null
  private readonly downEntityByButton = new Map<InputActionValue, Entity>()
  private tickNumber = 0
  private readonly downTimestampByButton = new Map<InputActionValue, number>()
  private pendingInjectPayload: InjectPointerClickBody | null = null
  private pendingHoverInjects: InjectPointerClickBody[] = []
  /** PET_DOWN bubble targets from the same flush — worker inject uses these for split DOWN/UP. */
  private pendingInjectDownEntities: number[] | null = null
  private readonly uiPointerButtons = new Set<InputActionValue>()

  private lastPrimaryInfoKey = ''
  private lastPpiSnapshot: {
    pointerType: number
    screenCoordinates: { x: number; y: number }
    screenDelta: { x: number; y: number }
    worldRayDirection: { x: number; y: number; z: number }
  } | null = null
  private readonly lastPpiCamElements = new Float32Array(16)
  private lastPpiScreenKey = ''
  /**
   * PPI diagnostic lines — **off by default** (alsoConsole spam tanked FPS at clubhouse).
   * Enable with `?ppidiag=1` for fishing aim debugging only.
   */
  private lastPpiDiagAt = 0
  private static readonly PPI_DIAG_MS = 1000
  private static readonly ppiDiagEnabled =
    typeof window !== 'undefined' &&
    (() => {
      try {
        return new URLSearchParams(window.location.search).has('ppidiag')
      } catch {
        return false
      }
    })()

  /** Capture phase so pointer clicks run before PlayerInput sets camera-orbit state. */
  private static readonly captureMouse = { capture: true } as const

  constructor(private readonly canvas: HTMLElement) {
    this.canvas.addEventListener('mousemove', this.onMouseMove)
    // Capture pointerdown before PlayerInput sets orbiting on bubble-phase pointerdown.
    this.canvas.addEventListener('pointerdown', this.onPointerDown, PointerEventsSystem.captureMouse)
    window.addEventListener('pointerup', this.onPointerUp, PointerEventsSystem.captureMouse)
    window.addEventListener('pointerdown', this.onWindowUiPointerDown, PointerEventsSystem.captureMouse)
    window.addEventListener('pointerup', this.onWindowUiPointerUp, PointerEventsSystem.captureMouse)
    document.addEventListener('pointermove', this.onDocumentPointerMove, PointerEventsSystem.captureMouse)
    window.addEventListener('keydown', this.onKeyDown)
    window.addEventListener('keyup', this.onKeyUp)
    this.screenX = window.innerWidth * 0.5
    this.screenY = window.innerHeight * 0.5
  }

  dispose(): void {
    this.canvas.removeEventListener('mousemove', this.onMouseMove)
    this.canvas.removeEventListener('pointerdown', this.onPointerDown, PointerEventsSystem.captureMouse)
    window.removeEventListener('pointerup', this.onPointerUp, PointerEventsSystem.captureMouse)
    window.removeEventListener('pointerdown', this.onWindowUiPointerDown, PointerEventsSystem.captureMouse)
    window.removeEventListener('pointerup', this.onWindowUiPointerUp, PointerEventsSystem.captureMouse)
    document.removeEventListener('pointermove', this.onDocumentPointerMove, PointerEventsSystem.captureMouse)
    window.removeEventListener('keydown', this.onKeyDown)
    window.removeEventListener('keyup', this.onKeyUp)
    this.hoverFeedback.dispose()
    this.highlightFeedback.dispose()
    this.deps = null
    this.pointerTargets.length = 0
    this.pointerEntitySet.clear()
    this.levelStateButtons.clear()
    this.stashedPointerDown.clear()
    this.pendingPointerDown.clear()
    this.pendingPointerUp.clear()
    this.downEntityByButton.clear()
  }

  bind(deps: PointerDeps): void {
    this.deps = deps
    this.invalidatePointerCache()
  }

  /** Scene graph / pointer ECS layout changed — rebuild entity set + raycast targets. */
  invalidatePointerCache(): void {
    this.pointerCacheDirty = true
  }

  private rebuildPointerCacheIfNeeded(): void {
    if (!this.pointerCacheDirty || !this.deps) return
    // Hover tooltips + click share this cache — ensure PE leaves exist first.
    this.deps.ensurePointerMeshes?.()
    this.rebuildPointerEntitySet()
    this.rebuildChildrenByParent()
    this.collectPointerTargets()
    this.pointerCacheDirty = false
  }

  /** Right-click / F with zero scene PointerEvents is normal — don't spam the console. */
  private shouldLogNoTarget(action: InputActionValue, clientX?: number, clientY?: number): boolean {
    if (action === InputAction.IA_SECONDARY && clientX !== undefined && clientY !== undefined) {
      if (findPeerPillAtPointer(clientX, clientY)) return false
    }
    if (this.pointerEntitySet.size > 0) return true
    return action !== InputAction.IA_SECONDARY
  }

  private pointerClientCoords(clientX = this.screenX, clientY = this.screenY): { x: number; y: number } {
    const locked = document.pointerLockElement === this.canvas
    if (locked) {
      if (pointerLockAim.active) {
        return { x: pointerLockAim.clientX, y: pointerLockAim.clientY }
      }
      const rect = this.canvas.getBoundingClientRect()
      const ndcY = POINTER_LOCK_AIM_NDC_Y
      return {
        x: rect.left + rect.width * 0.5,
        y: rect.top + (-ndcY * 0.5 + 0.5) * rect.height
      }
    }
    return { x: clientX, y: clientY }
  }

  /**
   * Phase C — true when matrix/collider prepare is needed before raycast/hover.
   * Avoids full scene-graph flush every frame while the pointer is idle.
   */
  needsRaycastPrepare(_tickNumber: number): boolean {
    if (!this.deps) return false
    // Left-drag orbit / look — camera owns the pointer. Hover raycast + GLTF
    // occluder walks are not Explorer look; they hitch orbit at 100 FPS present.
    if (this.deps.isPointerBlocked()) return false
    if (this.pointerDirty || this.primaryKeyDown) return true
    if (this.hasPendingInput()) return true
    const locked = document.pointerLockElement === this.canvas
    // Unlocked: only re-hover when the cursor actually moved. Locked look uses the
    // 80 ms cadence because screen coords stay centered while the camera turns.
    if (
      !locked &&
      this.screenX === this.hoverScreenX &&
      this.screenY === this.hoverScreenY
    ) {
      return false
    }
    return performance.now() - this.lastHoverPrepareAt >= PointerEventsSystem.HOVER_PREPARE_MS
  }

  /** Tooltip + mesh highlight only (no CRDT). */
  updateVisuals(tickNumber: number): void {
    if (!this.deps) return

    this.tickNumber = tickNumber
    if (this.deps.isPointerBlocked()) {
      this.hoverFeedback.hide()
      this.highlightFeedback.clear()
      return
    }
    this.rebuildPointerCacheIfNeeded()

    const needsRaycast = this.needsRaycastPrepare(tickNumber)
    if (!needsRaycast && this.lastHit) {
      this.applyHoverFromHit(this.lastHit)
      // Do NOT clear screenDx/Dy here — PrimaryPointerInfo.screenDelta is consumed only
      // in getPrimaryPointerSnapshot / syncPrimaryPointerInfo (worker pan needs live delta).
      return
    }

    const hit = this.computeCurrentHit()
    this.lastHit = hit
    this.lastHoverPrepareAt = performance.now()
    this.hoverScreenX = this.screenX
    this.hoverScreenY = this.screenY

    if (!hit) {
      this.hoverFeedback.hide()
      this.highlightFeedback.clear()
      this.clearHoverIfNeeded(this.deps.ecs)
      this.pointerDirty = false
      return
    }

    this.applyHoverFromHit(hit)
    this.pointerDirty = false
  }

  private applyHoverFromHit(hit: PointerHit): void {
    if (!this.deps) return
    if (hit.isSceneUi) {
      this.hoverFeedback.hide()
      this.highlightFeedback.clear()
      this.syncSceneUiHover(hit)
      return
    }
    const { ecs } = this.deps
    const targetEntity = this.resolvePointerResultEntity(hit.entity, InputAction.IA_POINTER)
    const spec = ecs.PointerEvents.getOrNull(targetEntity)
    if (!spec) {
      this.hoverFeedback.hide()
      this.highlightFeedback.clear()
      return
    }

    const feedbackInRange = pointerFeedbackInRange(spec, hit)
    const highlightInRange = pointerHighlightInRange(spec, hit.cameraDistance, hit.playerDistance)
    const primaryDown = this.primaryKeyDown
    this.hoverFeedback.update(spec.pointerEvents, feedbackInRange, primaryDown, this.screenX, this.screenY)
    if (this.highlightFeedback.shouldShow(spec.pointerEvents)) {
      const meshes = this.collectHighlightMeshes(targetEntity)
      this.highlightFeedback.update(meshes, highlightInRange)
    } else {
      this.highlightFeedback.clear()
    }
  }

  /**
   * Pointer raycast + CRDT writes — run during worker `crdt-send` (hover/PrimaryPointerInfo) and on
   * click/key flush (PET_DOWN + PET_UP). Pending down/up must only run on the dedicated flush so
   * both append together on the nudge round-trip where renderer inbound is applied.
   */
  syncInput(
    tickNumber: number,
    options?: { processPendingDown?: boolean; processPendingUp?: boolean }
  ): void {
    if (!this.deps) return
    const { ecs, camera } = this.deps
    const processPendingDown = options?.processPendingDown !== false
    const processPendingUp = options?.processPendingUp === true

    this.tickNumber = tickNumber
    this.rebuildPointerCacheIfNeeded()

    // Always refresh `_ray` before hit tests / PrimaryPointerInfo. Scene systems (plaza
    // fishing bobber aim) read worldRayDirection every tick — early UI/no-target returns
    // in computeCurrentHit must not leave a stale direction.
    this.refreshPointerRay(camera)

    const hit = this.computeCurrentHit()
    this.lastHit = hit

    if (processPendingDown) {
      for (const [button, preferredHit] of this.pendingPointerDown) {
        this.tryWritePointerDown(button, preferredHit)
      }
      this.pendingPointerDown.clear()
    }

    if (processPendingUp) {
      for (const button of this.pendingPointerUp) {
        this.tryPointerUp(button, hit)
      }
      this.pendingPointerUp.clear()
    }

    this.syncPrimaryPointerInfo(camera, hit)

    if (!hit) {
      this.clearHoverIfNeeded(ecs)
      return
    }

    const nextHover = this.resolveHoverEntity(hit)
    if (nextHover !== this.hoverEntity) {
      if (this.hoverEntity !== null) {
        this.emitHover(ecs, this.hoverEntity, PointerEventType.PET_HOVER_LEAVE, hit)
      }
      if (nextHover !== null) {
        this.emitHover(ecs, nextHover, PointerEventType.PET_HOVER_ENTER, hit)
      }
      this.hoverEntity = nextHover
    }
  }

  /** Update module `_ray` from current screen / pointer-lock aim. */
  private refreshPointerRay(camera: THREE.Camera): void {
    this.computePointerRay(camera)
  }

  private computeCurrentHit(): PointerHit | null {
    if (!this.deps) return null

    // Hit-map UI hover first — Explorer cursor-over-control. Do not require DOM
    // `--interactive` (partial UI snapshots can drop that class while PE still exists).
    // react-ecs desktop buttons (Sky Chaser Start / How To Play close) fire onMouseUp
    // only after onMouseEnter; missing hover-enter means the overlay never dismisses.
    const uiHoverHit = this.deps.pickUiHoverHit?.(this.screenX, this.screenY)
    if (uiHoverHit) return uiHoverHit

    if (isPointerOverSceneUi(this.screenX, this.screenY)) {
      const uiRegionHit = this.deps.pickUiRegionHit?.(this.screenX, this.screenY)
      if (uiRegionHit) return uiRegionHit
      // DOM has an interactive node under the cursor but hit-map did not claim a BLOCK
      // shell (selection HUD / transparent PE after DecentraCraft unit select). Fall
      // through to world PE so click-to-move and hover tooltips still work.
    }

    if (!this.pointerEntitySet.size) return null
    this.deps.prepareRaycast?.()
    this.rebuildPointerCacheIfNeeded()
    const { collision, camera, getPlayerPosition } = this.deps

    // Always refresh ray from the live camera (VC lens may have moved this frame).
    this.refreshPointerRay(camera)
    camera.getWorldPosition(_camPos)
    const playerPos = getPlayerPosition()
    if (playerPos) _playerPos.copy(playerPos)

    return this.pickPointerHit(collision, _ray, _camPos, playerPos)
  }

  private onMouseMove = (e: MouseEvent): void => {
    this.screenDx += e.movementX
    this.screenDy += e.movementY
    this.screenX = e.clientX
    this.screenY = e.clientY
  }

  /**
   * Track cursor for PrimaryPointerInfo even over scene UI / chat overlays.
   * Edge-pan systems read screenCoordinates every tick — if we only update on canvas
   * mousemove, the left/top screen edges under HUD never refresh (left pan dead).
   * Delta: only accumulate when not over the canvas (canvas mousemove already counts).
   */
  private onDocumentPointerMove = (e: PointerEvent): void => {
    const overCanvas =
      e.target === this.canvas ||
      (e.target instanceof Node && this.canvas.contains(e.target))
    if (!overCanvas && (e.movementX || e.movementY)) {
      this.screenDx += e.movementX
      this.screenDy += e.movementY
    }
    this.screenX = e.clientX
    this.screenY = e.clientY
  }

  private onPointerDown = (e: PointerEvent): void => {
    if (!this.deps) return
    if (e.target !== this.canvas) return
    // Canvas received the event — not over interactive scene-UI DOM. Update ray origin
    // from this click (mousemove may be stale) and raycast world only. UI clicks use
    // onWindowUiPointerDown; pickUiRegionHit must not short-circuit canvas → 3D.
    this.screenX = e.clientX
    this.screenY = e.clientY
    this.pointerDirty = true
    // Canvas is the event target → DOM already passed through UI (pointer-events:none).
    // Always world-raycast; do NOT call pickUiRegionHit (that blocked DecentraCraft
    // click-to-move after unit select when selection HUD hit-map still claimed the point).
    // Full-screen PX dialogs use isUiOverlayPointerEvent / non-canvas targets.
    if (isUiOverlayPointerEvent(e)) {
      e.stopPropagation()
      return
    }
    if (this.deps.consumeSceneUiFieldPointer?.(e.clientX, e.clientY, e.target)) {
      e.stopPropagation()
      return
    }
    if (this.isTypingTarget()) return
    if (this.deps.isPointerBlocked()) return
    // Peer profile/trade menu (body or pill) — claim left/right click before scene PE /
    // level-state PlayerEntity inject (which was swallowing avatar clicks as entity=1).
    if (e.button === 0 || e.button === 2) {
      if (tryOpenPeerContextMenu(e.clientX, e.clientY)) {
        e.preventDefault()
        e.stopPropagation()
        return
      }
    }

    const button = mouseButtonToInputAction(e.button)
    // Unlocked LMB is camera orbit on empty ground. Explorer still fires IA_POINTER
    // on in-range PointerEvents (Creator Hub on_click / getClick). Skipping all
    // unlocked clicks ate VoxBoards halfpipe teleports. Misses stay orbit-only —
    // do not inject level-state PET_DOWN on PlayerEntity (that spammed every drag).
    // Exception: scene VirtualCamera owns look — LMB is scene orbit (isPressed + PPI).
    const sceneLookOwnsPointer = this.deps.isLookBlocked?.() === true
    const unlockedPointer =
      button === InputAction.IA_POINTER &&
      !!this.deps.isPointerLocked &&
      !this.deps.isPointerLocked() &&
      !sceneLookOwnsPointer
    const coords = this.pointerClientCoords(e.clientX, e.clientY)
    const hit = this.resolveWorldInteractHit(button)
    // Real PE / UI when in range. On IA_POINTER miss/OOR: level-state PET on PlayerEntity so
    // inputSystem.isPressed / isTriggered work (Explorer global button). Aim stays PPI ×
    // CameraEntity in the scene — never invent a y=0 ground PE hit.position.
    if (!this.canQueuePointerDown(button, hit)) {
      if (unlockedPointer) return
      if (button === InputAction.IA_POINTER) {
        const levelHit = this.buildLevelStatePointerHit()
        if (levelHit) {
          // Serialize presses: do not start DOWN2 while DOWN1 has no UP yet.
          if (this.downEntityByButton.has(button) || this.pendingPointerDown.has(button)) {
            this.stashedPointerDown.set(button, levelHit)
            this.levelStateButtons.add(button)
            this.deps.flushPointerCrdt?.()
            return
          }
          const player = this.deps.view.PlayerEntity
          this.levelStateButtons.add(button)
          this.downEntityByButton.set(button, player)
          this.pendingPointerDown.set(button, levelHit)
          clientDebugLog.log(
            'pointer',
            `click → level-state PlayerEntity (no PE in range; entities=${this.pointerEntitySet.size} meshes=${this.pointerTargets.length})`,
            { alsoConsole: true }
          )
          this.deps.flushPointerCrdt?.()
          return
        }
      }
      if (hit) {
        this.logInteractBlocked(mouseInteractLabel(button, e.button), button, hit)
      } else if (!this.shouldLogNoTarget(button, coords.x, coords.y)) {
        /* scene has no PointerEvents or right-click near a remote player — expected noise */
      } else {
        this.rebuildPointerCacheIfNeeded()
        const last = this.lastHit
        const lastHint = last
          ? ` lastHit=e${last.entity as number} cam=${last.cameraDistance.toFixed(1)}m`
          : ' lastHit=none'
        // Sample PE entity ids so we can see if craft clickables are in the 3D set.
        let sample = ''
        let n = 0
        for (const ent of this.pointerEntitySet) {
          if (n >= 4) break
          sample += (sample ? ',' : '') + `e${ent as number}`
          n++
        }
        clientDebugLog.log(
          'pointer',
          `${mouseInteractLabel(button, e.button)} — no in-range target ` +
            `(entities=${this.pointerEntitySet.size} meshes=${this.pointerTargets.length}${lastHint}` +
            (sample ? ` sample=[${sample}]` : '') +
            `)`,
          { level: 'warn', alsoConsole: true }
        )
      }
      return
    }
    // Serialize: one open press per button — stash extra downs until UP completes.
    if (this.downEntityByButton.has(button) || this.pendingPointerDown.has(button)) {
      this.stashedPointerDown.set(button, hit)
      this.deps.flushPointerCrdt?.()
      return
    }
    this.levelStateButtons.delete(button)
    const targetEntity = this.resolvePointerResultEntity(hit!.entity, button)
    this.downEntityByButton.set(button, targetEntity)
    this.pendingPointerDown.set(button, hit)
    if (button === InputAction.IA_POINTER) {
      const label =
        targetEntity !== hit!.entity
          ? `click → target ${targetEntity} (hit ${hit!.entity})`
          : `click → entity ${targetEntity}`
      clientDebugLog.log('pointer', label, { alsoConsole: true })
      this.deps.onWorldPointerDown?.(targetEntity)
    }
    if (unlockedPointer) e.stopPropagation()
    // Universal Explorer press edge: flush PET_DOWN immediately (world + UI + level-state).
    // Same-tick DOWN+UP on mouseup alone never leaves multi-frame isPressed for any scene.
    this.deps.flushPointerCrdt?.()
  }

  private onPointerUp = (e: PointerEvent): void => {
    if (!this.deps) return
    const button = mouseButtonToInputAction(e.button)
    if (!this.downEntityByButton.has(button) && !this.pendingPointerDown.has(button)) {
      // Orphan up after spam-drop — ignore.
      return
    }
    if (this.uiPointerButtons.has(button)) return
    this.pendingPointerUp.add(button)
    this.pointerDirty = true
    this.deps.flushPointerCrdt?.()
  }

  private onWindowUiPointerDown = (e: PointerEvent): void => {
    if (!this.deps?.pickUiHit) return
    const ownRoot = this.deps.uiRootId

    // PX enable/close (or any PX UI) — primary must not inject scene UI under the dialog.
    // Gate tags the event before either system runs (capture order).
    if (ownRoot && isForeignUiPointerOwner(ownRoot, e)) {
      return
    }

    // Left-drag orbit — never hijack canvas clicks without an interactive scene-ui node.
    // Debug HUD is client chrome, not scene UI — never treat it as overlay that
    // stopPropagation's world clicks (Labs Debug must leave canvas pointer live).
    if (e.target instanceof Element && e.target.closest('#debug-panel')) return

    const overUi =
      isUiOverlayPointerEvent(e) ||
      isPointerOverSceneUi(e.clientX, e.clientY) ||
      isSceneUiDomTarget(e.target)
    if (!overUi) return

    if (this.deps.consumeSceneUiFieldPointer?.(e.clientX, e.clientY, e.target)) {
      if (!(e.target instanceof Element) || !isSceneUiFieldDom(e.target)) {
        e.stopPropagation()
      }
      return
    }
    if (this.isTypingTarget() || this.deps.isSceneUiTypingActive?.()) return
    if (this.deps.isPointerBlocked()) return

    const hit = this.deps.pickUiHit(e.clientX, e.clientY, e.target)
    const button = mouseButtonToInputAction(e.button)
    if (!hit) {
      // Overlay owns the point but this root has no handler — do not fall through to world.
      // Do not stopImmediate: the owning root's system still needs this event.
      if (overUi) e.stopPropagation()
      return
    }
    if (!this.canQueuePointerDown(button, hit)) {
      if (isSceneUiDomTarget(e.target) || overUi) e.stopPropagation()
      return
    }

    // This root owns the click — claim exclusively so the other PES (primary vs PX)
    // cannot also queue an inject on the same window listener.
    e.stopPropagation()
    e.stopImmediatePropagation()
    // pickUiHit already resolved the react-ecs handler (smallest PointerEvents under point).
    // Do not re-walk ancestors — that can re-target a fullscreen scrim.
    const targetEntity = hit.isSceneUi
      ? hit.entity
      : this.resolvePointerResultEntity(hit.entity, button)
    this.uiPointerButtons.add(button)
    this.downEntityByButton.set(button, targetEntity)
    this.pendingPointerDown.set(button, hit)
    // Click implies the cursor is over the control — deliver PET_HOVER_ENTER before DOWN
    // so react-ecs onMouseUp (desktop: callback only while hovered) can fire.
    if (hit.isSceneUi) this.syncSceneUiHover(hit)
    if (button === InputAction.IA_POINTER) {
      const owner = uiPointerOwnerOf(e) ?? ownRoot ?? '?'
      clientDebugLog.log(
        'pointer',
        `ui down → entity ${targetEntity}${hit.isSceneUi ? ' (sceneUi)' : ''} root=${owner}`,
        { alsoConsole: true }
      )
    }
    // Universal press edge: PET_DOWN on mousedown for scene UI too (onMouseDown this edge).
    this.deps.flushPointerCrdt?.()
  }

  private onWindowUiPointerUp = (e: PointerEvent): void => {
    if (!this.deps) return
    const ownRoot = this.deps.uiRootId
    // Foreign root owned the gesture — never flush a scene inject from under a PX dialog.
    if (ownRoot && isForeignUiPointerOwner(ownRoot, e) && !this.uiPointerButtons.has(
      mouseButtonToInputAction(e.button)
    )) {
      return
    }
    const button = mouseButtonToInputAction(e.button)
    if (!this.uiPointerButtons.has(button)) return
    if (!this.downEntityByButton.has(button)) {
      this.uiPointerButtons.delete(button)
      return
    }
    this.pendingPointerUp.add(button)
    this.uiPointerButtons.delete(button)
    e.stopPropagation()
    e.stopImmediatePropagation()
    this.deps.flushPointerCrdt?.()
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    if (e.repeat) return
    if (!this.deps) return
    if (this.isTypingTarget() || this.deps.isSceneUiTypingActive?.()) return
    if (this.isPointerOverSceneUiField()) return
    if (this.deps.isPointerBlocked()) return

    const binding = keyCodeToInputActionBinding(e.code)
    if (!binding) return

    const { action, label, preventDefault } = binding
    // Locomotion / modifier keys are level-state via SceneInputRelay — not PE interact.
    // Wasd was spamming "no in-range target" and competing with left-click PE flushes.
    if (
      action === InputAction.IA_FORWARD ||
      action === InputAction.IA_BACKWARD ||
      action === InputAction.IA_LEFT ||
      action === InputAction.IA_RIGHT ||
      action === InputAction.IA_JUMP ||
      action === InputAction.IA_WALK ||
      action === InputAction.IA_MODIFIER
    ) {
      return
    }
    if (preventDefault) e.preventDefault()

    const coords = this.pointerClientCoords()
    // Keyboard interact (E/F/1–4) targets the world under the cursor, not scene UI.
    let hit = this.resolveWorldInteractHit(action)
    if (!this.canQueuePointerDown(action, hit)) {
      const level = this.buildLevelStatePointerHit()
      if (level && this.canQueuePointerDown(action, level)) {
        // Explorer: E/F without a PE mesh are level-state (InputHub snapshot +
        // play-frame reassert → isTriggered). A no-target pointer inject on
        // PlayerEntity holds react-ecs until UP (plaza reel bar) and runs the
        // empty-ground edge (GAME ENDED / shrug).
        if (action === InputAction.IA_PRIMARY || action === InputAction.IA_SECONDARY) {
          if (action === InputAction.IA_PRIMARY) this.primaryKeyDown = true
          clientDebugLog.log(
            'pointer',
            `${label} — level-state (no PE target; snapshot + reassert)`,
            { alsoConsole: true }
          )
          return
        }
        hit = level
      } else {
        if (hit) {
          this.logInteractBlocked(label, action, hit)
        } else if (!this.shouldLogNoTarget(action, coords.x, coords.y)) {
          /* expected when the scene has no pointer targets */
        } else {
          this.rebuildPointerCacheIfNeeded()
          clientDebugLog.log(
            'pointer',
            `${label} — no in-range target (entities=${this.pointerEntitySet.size} meshes=${this.pointerTargets.length})`,
            { level: 'warn', alsoConsole: true }
          )
        }
        return
      }
    }

    if (action === InputAction.IA_PRIMARY) this.primaryKeyDown = true
    const targetEntity = this.resolvePointerResultEntity(hit!.entity, action)
    this.downEntityByButton.set(action, targetEntity)
    this.pendingPointerDown.set(action, hit)
    clientDebugLog.log(
      'pointer',
      targetEntity !== hit!.entity ? `${label} → target ${targetEntity} (hit ${hit!.entity})` : `${label} → entity ${targetEntity}`,
      { alsoConsole: true }
    )
    this.deps?.flushPointerCrdt?.()
  }

  private onKeyUp = (e: KeyboardEvent): void => {
    const binding = keyCodeToInputActionBinding(e.code)
    if (!binding) return

    if (binding.action === InputAction.IA_PRIMARY) this.primaryKeyDown = false
    if (!this.downEntityByButton.has(binding.action)) return
    this.pendingPointerUp.add(binding.action)
    this.deps?.flushPointerCrdt?.()
  }

  hasPendingInput(): boolean {
    return (
      this.pendingPointerDown.size > 0 ||
      this.pendingPointerUp.size > 0 ||
      this.pendingInjectPayload !== null
    )
  }

  /** Queued browser pointerdown not yet written to PET / inject. */
  hasPendingDown(): boolean {
    return this.pendingPointerDown.size > 0
  }

  /** Queued browser pointerup not yet written to PET / inject. */
  hasPendingUp(): boolean {
    return this.pendingPointerUp.size > 0
  }

  /** True after syncInput PET edge — direct worker inject will carry the click. */
  hasPendingInjectPayload(): boolean {
    return this.pendingInjectPayload !== null
  }

  /** Browser pointer lock on the game canvas (Explorer PointerLock component). */
  isBrowserPointerLocked(): boolean {
    return this.deps?.isPointerLocked?.() === true
  }

  /** Scene VirtualCamera owns the lens — unlocked LMB is scene input, not freecam. */
  isLookOwnedByScene(): boolean {
    return this.deps?.isLookBlocked?.() === true
  }

  /**
   * Physical press still open (browser down, PET not yet UP).
   * Default IA_POINTER — scene `isPressed(POINTER)` / PointerLock-while-held.
   */
  isPointerActionHeld(button: InputActionValue = InputAction.IA_POINTER): boolean {
    return this.downEntityByButton.has(button) || this.pendingPointerDown.has(button)
  }

  /** Mobile HUD — same path as E/F keyboard interact. */
  triggerInputAction(action: InputActionValue, phase: 'down' | 'up'): void {
    if (!this.deps) return
    if (phase === 'down') {
      if (this.deps.isPointerBlocked()) return
      const binding = inputActionBinding(action)
      if (!binding) return
      let hit = this.resolveInteractHit(action)
      if (!this.canQueuePointerDown(action, hit)) {
        const level = this.buildLevelStatePointerHit()
        if (level && this.canQueuePointerDown(action, level)) {
          if (action === InputAction.IA_PRIMARY || action === InputAction.IA_SECONDARY) {
            if (action === InputAction.IA_PRIMARY) this.primaryKeyDown = true
            return
          }
          hit = level
        } else {
          if (hit) this.logInteractBlocked(binding.label, action, hit)
          return
        }
      }
      if (action === InputAction.IA_PRIMARY) this.primaryKeyDown = true
      const targetEntity = this.resolvePointerResultEntity(hit!.entity, action)
      this.downEntityByButton.set(action, targetEntity)
      this.pendingPointerDown.set(action, hit)
      this.deps.flushPointerCrdt?.()
      return
    }

    if (action === InputAction.IA_PRIMARY) this.primaryKeyDown = false
    if (!this.downEntityByButton.has(action)) return
    this.pendingPointerUp.add(action)
    this.deps.flushPointerCrdt?.()
  }

  /** Payload for direct worker injection (bypasses CRDT deliver when worker is busy). */
  consumeInjectPayload(): InjectPointerClickBody | null {
    const payload = this.pendingInjectPayload
    this.pendingInjectPayload = null
    return payload
  }

  consumeHoverInjects(): InjectPointerClickBody[] {
    if (!this.pendingHoverInjects.length) return []
    const out = this.pendingHoverInjects
    this.pendingHoverInjects = []
    return out
  }

  private tryWritePointerDown(button: InputActionValue, preferredHit: PointerHit | null = null): void {
    if (!this.deps) return

    // Global IA_POINTER on PlayerEntity — no PE component required (same as keyboard PETs).
    if (preferredHit?.isLevelState) {
      const player = this.deps.view.PlayerEntity
      this.levelStateButtons.add(button)
      this.downEntityByButton.set(button, player)
      this.writeResult(this.deps.ecs, player, preferredHit, PointerEventType.PET_DOWN, button)
      return
    }

    let activeHit = preferredHit ?? this.pickAtPointer()
    // Proximity is E/F-style interact only — never for left-click (phantom theater/NPC hits).
    if (!activeHit && this.allowsProximityFallback(button)) {
      activeHit = this.pickProximityTarget(button)
    }
    if (!activeHit) return

    // Scene UI pick already resolved the onMouseDown leaf — do not re-walk ancestors
    // (can re-target fullscreen scrim and close modals instead of CREATOR/USE cards).
    const targetEntity = activeHit.isSceneUi
      ? activeHit.entity
      : this.resolvePointerResultEntity(activeHit.entity, button)
    if (
      this.deps.isSceneUiFieldEntity?.(targetEntity) ||
      this.deps.isSceneUiFieldEntity?.(activeHit.entity)
    ) {
      return
    }
    const spec = activeHit.isSceneUi ? this.uiPointerSpec(targetEntity) : this.deps.ecs.PointerEvents.getOrNull(targetEntity)
    if (activeHit.isSceneUi) {
      if (!hasUiPointerEvent(spec, PointerEventType.PET_DOWN, button)) return
    } else if (!hasPointerEvent(spec, PointerEventType.PET_DOWN, button)) {
      return
    }
    if (!this.hitAllowsPointerDown(spec, button, activeHit)) return

    this.levelStateButtons.delete(button)
    this.downEntityByButton.set(button, targetEntity)
    this.writeResult(this.deps.ecs, targetEntity, activeHit, PointerEventType.PET_DOWN, button)
  }

  /**
   * Spatial proximity grab (nearest PE in range, not under cursor) — E/F only.
   * Left-click must not grab plaza theater helpers when the ray misses.
   */
  private allowsProximityFallback(button: InputActionValue): boolean {
    return button !== InputAction.IA_POINTER
  }

  /**
   * Re-use last hover hit for left-click when the fresh ray misses (thin water PE / pond
   * Cast Line). Only if that same entity still has PET_DOWN in range — not a free proximity grab.
   */
  private lastHoverPointerDownIfValid(button: InputActionValue): PointerHit | null {
    if (button !== InputAction.IA_POINTER) return null
    const last = this.lastHit
    if (!last || last.isSceneUi) return null
    if (!this.canQueuePointerDown(button, last)) return null
    return last
  }

  /** Crosshair hit — fall back to proximity / last frame when the center ray misses. */
  private resolveInteractHit(button: InputActionValue): PointerHit | null {
    const fresh = this.pickAtPointer()
    if (fresh && this.canQueuePointerDown(button, fresh)) return fresh
    // Left-click: sticky hover PE (fishing Cast Line) before giving up — not proximity.
    if (!this.allowsProximityFallback(button)) {
      return this.lastHoverPointerDownIfValid(button) ?? fresh
    }
    const proximity = this.pickProximityTarget(button)
    if (proximity && this.canQueuePointerDown(button, proximity)) {
      clientDebugLog.log('pointer', `proximity target entity=${proximity.entity} player=${proximity.playerDistance.toFixed(1)}m`, {
        alsoConsole: true
      })
      return proximity
    }
    if (this.lastHit && !this.lastHit.isSceneUi && this.canQueuePointerDown(button, this.lastHit)) {
      return this.lastHit
    }
    return fresh ?? proximity ?? this.lastHit
  }

  /**
   * Canvas / keyboard world interact — never short-circuit on scene-UI hit-map regions.
   * UI inject uses `onWindowUiPointerDown` + `pickUiHit` only.
   */
  private resolveWorldInteractHit(button: InputActionValue): PointerHit | null {
    const fresh = this.pickWorldHitAtPointer()
    if (fresh && this.canQueuePointerDown(button, fresh)) return fresh
    // Left-click: sticky hover PE (fishing Cast Line on thin water) before giving up.
    if (!this.allowsProximityFallback(button)) {
      const sticky = this.lastHoverPointerDownIfValid(button)
      if (sticky) {
        clientDebugLog.log(
          'pointer',
          `click sticky-hover → e${sticky.entity as number} cam=${sticky.cameraDistance.toFixed(1)}m`,
          { alsoConsole: true, throttleMs: 400, throttleKey: 'click-sticky-hover' }
        )
        return sticky
      }
      return fresh
    }
    const proximity = this.pickProximityTarget(button)
    if (proximity && this.canQueuePointerDown(button, proximity)) {
      clientDebugLog.log('pointer', `proximity target entity=${proximity.entity} player=${proximity.playerDistance.toFixed(1)}m`, {
        alsoConsole: true
      })
      return proximity
    }
    if (this.lastHit && !this.lastHit.isSceneUi && this.canQueuePointerDown(button, this.lastHit)) {
      return this.lastHit
    }
    return fresh ?? proximity
  }

  private canQueuePointerDown(button: InputActionValue, hit: PointerHit | null): boolean {
    if (!this.deps || !hit) return false
    // Global inputSystem edges on PlayerEntity — no PE mesh required.
    // Plaza fishing bite is isTriggered(IA_PRIMARY, PET_DOWN) with no entity.
    if (hit.isLevelState) return true
    const targetEntity = this.resolvePointerResultEntity(hit.entity, button)
    if (hit.isSceneUi) {
      const spec = this.uiPointerSpec(targetEntity)
      return hasUiPointerEvent(spec, PointerEventType.PET_DOWN, button)
    }
    // World props: always use projection PointerEvents — mount snapshot is UI-only.
    const spec = this.deps.ecs.PointerEvents.getOrNull(targetEntity)
    if (!hasPointerEvent(spec, PointerEventType.PET_DOWN, button)) return false
    return pointerEventInRange(spec, PointerEventType.PET_DOWN, button, hit)
  }

  /**
   * Global pointer edge when no PE mesh is under the cursor / in range.
   * Target stays PlayerEntity (no invented PE mesh). RaycastHit geometry is the
   * aim-ray × horizontal ground plane at player feet (or y=0) so scenes that place
   * click VFX from hit.position still get a board point; PPI remains the aim law.
   */
  private buildLevelStatePointerHit(): PointerHit | null {
    if (!this.deps) return null
    this.deps.camera.updateMatrixWorld(true)
    this.refreshPointerRay(this.deps.camera)
    this.deps.camera.getWorldPosition(_camPos)
    const ray = this.raycaster.ray
    const playerPos = this.deps.getPlayerPosition()
    const groundY = playerPos?.y ?? 0
    // Ray × horizontal plane y = groundY (Three Y-up). Looking up → fall back to feet/origin.
    let point = _camPos.clone()
    let distance = 0
    const dy = ray.direction.y
    if (Math.abs(dy) > 1e-5) {
      const t = (groundY - ray.origin.y) / dy
      if (t > 0 && t < 500) {
        point = ray.origin.clone().addScaledVector(ray.direction, t)
        point.y = groundY
        distance = t
      } else if (playerPos) {
        point = playerPos.clone()
        point.y = groundY
        distance = ray.origin.distanceTo(point)
      }
    } else if (playerPos) {
      point = playerPos.clone()
      point.y = groundY
      distance = ray.origin.distanceTo(point)
    }
    // Target for PET inject is still PlayerEntity (global isPressed). hit.entity stays
    // PlayerEntity so bubble targets work; writeResult sets hitEntity for RaycastHit —
    // level-state uses entityId 0 on the inject payload (empty ground; see writeResult).
    return {
      entity: this.deps.view.PlayerEntity,
      point,
      distance,
      normal: new THREE.Vector3(0, 1, 0),
      priority: -1,
      cameraDistance: distance,
      playerDistance: 0,
      inRange: true,
      isLevelState: true
    }
  }

  private hitAllowsPointerDown(
    spec: { pointerEvents: ReadonlyArray<PBPointerEvents_Entry> } | null | undefined,
    button: InputActionValue,
    hit: Pick<PointerHit, 'cameraDistance' | 'playerDistance' | 'isSceneUi'>
  ): boolean {
    if (hit.isSceneUi) {
      return hasUiPointerEvent(spec, PointerEventType.PET_DOWN, button)
    }
    return pointerEventInRange(spec, PointerEventType.PET_DOWN, button, hit)
  }

  private logInteractBlocked(label: string, button: InputActionValue, hit: PointerHit | null): void {
    if (!hit) {
      clientDebugLog.log('pointer', `${label} blocked — no target`, { level: 'warn', alsoConsole: true })
      return
    }
    const targetEntity = this.resolvePointerResultEntity(hit.entity, button)
    const spec = hit.isSceneUi ? this.uiPointerSpec(targetEntity) : this.deps?.ecs.PointerEvents.getOrNull(targetEntity)
    if (!hasPointerEvent(spec, PointerEventType.PET_DOWN, button)) {
      // Space/IA_JUMP is locomotion first — many PE targets only register IA_POINTER / IA_PRIMARY.
      // Do not spam "blocked" as if fishing/cast failed (button=8 is IA_JUMP).
      if (button === InputAction.IA_JUMP) return
      clientDebugLog.log(
        'pointer',
        `${label} blocked — entity=${targetEntity} missing PET_DOWN button=${button}`,
        { level: 'warn', alsoConsole: true }
      )
      return
    }
    clientDebugLog.log(
      'pointer',
      `${label} blocked — out of range entity=${targetEntity} cam=${hit.cameraDistance.toFixed(1)}m player=${hit.playerDistance.toFixed(1)}m`,
      { level: 'warn', alsoConsole: true }
    )
  }

  private tryWritePointerUp(button: InputActionValue, preferredHit: PointerHit | null = null): boolean {
    if (!this.deps) return false

    const downEntity = this.downEntityByButton.get(button)
    this.downEntityByButton.delete(button)
    if (downEntity === undefined) return false

    this.deps.camera.getWorldPosition(_camPos)

    // Level-state PET_DOWN had no PointerEvents on PlayerEntity — always pair PET_UP.
    if (this.levelStateButtons.has(button) || preferredHit?.isLevelState) {
      this.levelStateButtons.delete(button)
      const upHit: PointerHit =
        preferredHit?.isLevelState
          ? preferredHit
          : this.buildLevelStatePointerHit() ?? {
              entity: downEntity,
              point: _camPos.clone(),
              distance: 0,
              normal: new THREE.Vector3(0, 1, 0),
              priority: -1,
              cameraDistance: 0,
              playerDistance: 0,
              inRange: true,
              isLevelState: true
            }
      upHit.isLevelState = true
      upHit.entity = downEntity
      this.writeResult(this.deps.ecs, downEntity, upHit, PointerEventType.PET_UP, button)
      // Promote stashed next press (if any) only after this UP is written.
      this.promoteStashedPointerDown(button)
      return true
    }

    const isSceneUi = this.deps.ecs.UiTransform.has(downEntity)
    const spec = isSceneUi ? this.uiPointerSpec(downEntity) : this.deps.ecs.PointerEvents.getOrNull(downEntity)
    // onClick registers PET_DOWN only — renderer must still emit PET_UP (Unity / @dcl/ecs parity).
    if (isSceneUi) {
      if (
        !spec ||
        (!hasUiPointerEvent(spec, PointerEventType.PET_UP, button) &&
          !hasUiPointerEvent(spec, PointerEventType.PET_DOWN, button))
      ) {
        return false
      }
    } else if (
      !spec ||
      (!hasPointerEvent(spec, PointerEventType.PET_UP, button) &&
        !hasPointerEvent(spec, PointerEventType.PET_DOWN, button))
    ) {
      return false
    }

    const activeHit = preferredHit ?? this.pickAtPointer()
    const activeTarget =
      activeHit !== null ? this.resolvePointerResultEntity(activeHit.entity, button) : null
    const upHit: PointerHit =
      activeHit && activeTarget === downEntity
        ? activeHit
        : this.deps.ecs.UiTransform.has(downEntity)
          ? this.buildUiPointerHit(downEntity, _camPos)
          : buildSyntheticHit(
              downEntity,
              _camPos,
              this.deps.getPlayerPosition(),
              this.deps.getWorldTransformDeps()
            )

    this.writeResult(this.deps.ecs, downEntity, upHit, PointerEventType.PET_UP, button)
    this.promoteStashedPointerDown(button)
    return true
  }

  /**
   * After PET_UP, start at most one stashed press (latest spam click wins).
   */
  private promoteStashedPointerDown(button: InputActionValue): void {
    const next = this.stashedPointerDown.get(button)
    this.stashedPointerDown.delete(button)
    if (next === undefined || !this.deps) return
    if (this.downEntityByButton.has(button) || this.pendingPointerDown.has(button)) return
    if (next?.isLevelState) {
      this.levelStateButtons.add(button)
      this.downEntityByButton.set(button, this.deps.view.PlayerEntity)
      this.pendingPointerDown.set(button, next)
    } else if (next) {
      const targetEntity = this.resolvePointerResultEntity(next.entity, button)
      this.levelStateButtons.delete(button)
      this.downEntityByButton.set(button, targetEntity)
      this.pendingPointerDown.set(button, next)
    } else {
      return
    }
    // Flush will process this DOWN after current UP inject is delivered (coalesce).
    this.deps.flushPointerCrdt?.()
  }

  private tryPointerUp(button: InputActionValue, hit: PointerHit | null): void {
    this.tryWritePointerUp(button, hit ?? this.lastHit)
  }

  private pickAtPointer(): PointerHit | null {
    if (!this.deps) return null
    // Hover / PrimaryPointerInfo: UI above 3D when interactive/BLOCK region is under cursor.
    // Only when DOM also reports interactive scene UI — hit-map-only BLOCK must not kill world
    // hits when the canvas received the event (pointer-events:none pass-through).
    if (isPointerOverSceneUi(this.screenX, this.screenY)) {
      const uiHoverHit = this.deps.pickUiHoverHit?.(this.screenX, this.screenY)
      if (uiHoverHit) return uiHoverHit
      const uiRegionHit = this.deps.pickUiRegionHit?.(this.screenX, this.screenY)
      if (uiRegionHit) return uiRegionHit
    }
    return this.pickWorldHitAtPointer()
  }

  /** 3D MeshCollider / GLTF / MeshRenderer raycast at current screen pointer. */
  private pickWorldHitAtPointer(): PointerHit | null {
    if (!this.deps) return null
    this.deps.prepareRaycast?.()
    this.rebuildPointerCacheIfNeeded()
    const ray = this.computePointerRay(this.deps.camera)
    this.deps.camera.getWorldPosition(_camPos)
    return this.pickPointerHit(this.deps.collision, ray, _camPos, this.deps.getPlayerPosition())
  }

  private resolveHoverEntity(hit: PointerHit): Entity | null {
    if (!this.deps) return null
    const { ecs, view } = this.deps
    const button = InputAction.IA_POINTER
    const state = PointerEventType.PET_HOVER_ENTER
    if (hit.isSceneUi) {
      const target = resolveUiPointerResultEntity(
        ecs,
        view,
        hit.entity,
        button,
        state,
        this.deps.pointerEventsOf
      )
      const spec = this.uiPointerSpec(target)
      return hasUiPointerEvent(spec, state, button) ? target : null
    }
    const target = this.resolvePointerResultEntity(hit.entity, button, state)
    const spec = ecs.PointerEvents.getOrNull(target)
    return hasPointerEvent(spec, state, button) ? target : null
  }

  private computePointerRay(camera: THREE.Camera): THREE.Ray {
    // VC lens moves every frame — matrixWorld must be current for setFromCamera.
    camera.updateMatrixWorld(true)
    const pointerLocked = document.pointerLockElement === this.canvas
    if (pointerLocked) {
      // Fixed elevated aim (same as reticle) — not screen center / not world-tracked.
      _ndc.set(
        pointerLockAim.active ? pointerLockAim.ndcX : 0,
        pointerLockAim.active ? pointerLockAim.ndcY : POINTER_LOCK_AIM_NDC_Y
      )
    } else {
      const rect = this.canvas.getBoundingClientRect()
      const w = Math.max(1, rect.width)
      const h = Math.max(1, rect.height)
      _ndc.x = ((this.screenX - rect.left) / w) * 2 - 1
      _ndc.y = -((this.screenY - rect.top) / h) * 2 + 1
    }
    // Elevated top-down VC can sit 25–80m above the board; default far is Infinity but
    // near plane can still clip if camera was reconfigured. Keep a long PE range.
    this.raycaster.near = 0
    this.raycaster.far = 500
    this.raycaster.setFromCamera(_ndc, camera)
    return _ray.copy(this.raycaster.ray)
  }

  private rebuildChildrenByParent(): void {
    this.childrenByParent.clear()
    if (!this.deps) return
    const { ecs, view } = this.deps
    for (const [entity] of view.getEntitiesWith(ecs.Transform)) {
      const parent = ecs.Transform.get(entity).parent
      if (parent === undefined) continue
      let list = this.childrenByParent.get(parent)
      if (!list) {
        list = []
        this.childrenByParent.set(parent, list)
      }
      list.push(entity)
    }
  }

  private rebuildPointerEntitySet(): void {
    if (!this.deps) return
    const { ecs, view } = this.deps
    const { RootEntity: Root, PlayerEntity: Player, CameraEntity: Camera } = view

    this.pointerEntitySet.clear()
    for (const [entity] of view.getEntitiesWith(ecs.PointerEvents)) {
      if (entity === Root || entity === Player || entity === Camera) {
        continue
      }
      // Screen UI PE is handled via DOM pickUiHit — keep them out of 3D raycast.
      // Mixing 200+ UI PE entities into world targets caused DecentraCraft miss spam
      // (entities=90 meshes=70 lastHit=none while craft meshes never got priority).
      if (ecs.UiTransform?.has(entity)) continue
      this.pointerEntitySet.add(entity)
    }
  }

  private pickPointerHit(
    collision: CollisionSystem,
    ray: THREE.Ray,
    cameraPos: THREE.Vector3,
    playerPos: THREE.Vector3 | null
  ): PointerHit | null {
    if (!this.deps || !this.pointerEntitySet.size) return null

    let best: PointerHit | null = null

    if (this.pointerTargets.length) {
      // THREE.Raycaster skips object.visible === false. DCL `_collider` hulls are often hidden
      // but still CL_POINTER — temporarily unhide for the intersect, then restore.
      const visibilityRestore: { obj: THREE.Object3D; visible: boolean }[] = []
      for (const obj of this.pointerTargets) {
        if (obj.visible === false) {
          visibilityRestore.push({ obj, visible: false })
          obj.visible = true
        }
        // Hidden ancestors also block raycasts.
        let p: THREE.Object3D | null = obj.parent
        while (p) {
          if (p.visible === false) {
            visibilityRestore.push({ obj: p, visible: false })
            p.visible = true
          }
          p = p.parent
        }
      }
      try {
        this.raycaster.layers.set(0)
        this.raycaster.set(ray.origin, ray.direction)
        const hits = this.raycaster.intersectObjects(this.pointerTargets, true)

        for (const hit of hits) {
          let hitEntity = hit.object.userData.entity as Entity | undefined
          if (
            hitEntity === undefined &&
            hit.instanceId !== undefined &&
            this.deps.resolveMeshRendererInstanceHit
          ) {
            hitEntity =
              this.deps.resolveMeshRendererInstanceHit(hit.object, hit.instanceId) ?? undefined
          }
          if (hitEntity === undefined) continue
          const entity = this.resolveColliderPointerEntity(hitEntity) ?? hitEntity
          if (!this.pointerEntitySet.has(entity)) continue

          const spec = this.deps.ecs.PointerEvents.getOrNull(entity)
          if (!spec) continue

          const pointerHit = buildPointerHit(this.deps.ecs, entity, hit, spec, cameraPos, playerPos)
          pointerHit.entity = entity

          if (
            !best ||
            pointerHit.priority > best.priority ||
            (pointerHit.priority === best.priority && hit.distance < best.distance)
          ) {
            best = pointerHit
          }
        }
      } finally {
        for (const { obj, visible } of visibilityRestore) {
          obj.visible = visible
        }
      }
    }

    // CL_POINTER hulls without PointerEvents still occlude (dock planks, walls).
    // Explorer: closest collider wins — a non-PE hit in front of a watering box
    // is no hover, not "click through the walkway".
    const occluderHits = this.raycastPointerOccluders(collision, ray)
    let closestBlock: { distance: number; entity: Entity } | null = null
    for (const hit of occluderHits) {
      if (!closestBlock || hit.distance < closestBlock.distance) {
        closestBlock = hit
      }
    }
    if (closestBlock && (!best || closestBlock.distance < best.distance - 1e-4)) {
      const target = this.resolveColliderPointerEntity(closestBlock.entity) ?? closestBlock.entity
      const spec = this.deps.ecs.PointerEvents.getOrNull(target)
      if (spec && this.pointerEntitySet.has(target)) {
        const fromCollider = collision.raycast(ray, ColliderLayer.CL_POINTER)
        const match = fromCollider.find((h) => h.entity === closestBlock!.entity)
        if (match) {
          const pointerHit = buildPointerHitFromCollider(
            this.deps.ecs,
            match,
            spec,
            cameraPos,
            playerPos
          )
          pointerHit.entity = target
          best = pointerHit
        }
      } else {
        best = null
      }
    } else if (!best) {
      const colliderHits = collision.raycast(ray, ColliderLayer.CL_POINTER)
      for (const hit of colliderHits) {
        const targetEntity = this.resolveColliderPointerEntity(hit.entity)
        if (targetEntity === null) continue
        const spec = this.deps.ecs.PointerEvents.getOrNull(targetEntity)
        if (!spec) continue
        const pointerHit = buildPointerHitFromCollider(this.deps.ecs, hit, spec, cameraPos, playerPos)
        pointerHit.entity = targetEntity
        if (
          !best ||
          pointerHit.priority > best.priority ||
          (pointerHit.priority === best.priority && hit.distance < best.distance)
        ) {
          best = pointerHit
        }
      }
    }

    return best
  }

  /**
   * World CL_POINTER geometry: MeshCollider primitives + Gltf `*_collider` hulls
   * (and renderer water visual when the authored invisible mask includes POINTER).
   */
  private raycastPointerOccluders(
    collision: CollisionSystem,
    ray: THREE.Ray
  ): { distance: number; entity: Entity }[] {
    if (!this.deps) return []
    const { ecs, view, getEntityNodes } = this.deps
    const nodes = getEntityNodes()
    const colliderHits = collision.raycast(ray, ColliderLayer.CL_POINTER)
    const out: { distance: number; entity: Entity }[] = colliderHits.map((h) => ({
      distance: h.distance,
      entity: h.entity
    }))

    const gltfTargets: THREE.Object3D[] = []
    for (const [entity] of view.getEntitiesWith(ecs.GltfContainer)) {
      const obj = nodes.get(entity)
      const root = poseDrawVisual(obj, entity) ?? obj
      if (!root) continue
      collectGltfLayerTargetMeshes(
        root,
        ecs.GltfContainer.get(entity),
        entity,
        ColliderLayer.CL_POINTER,
        gltfTargets
      )
    }
    if (!gltfTargets.length) return out

    const visibilityRestore: { obj: THREE.Object3D; visible: boolean }[] = []
    for (const obj of gltfTargets) {
      if (obj.visible === false) {
        visibilityRestore.push({ obj, visible: false })
        obj.visible = true
      }
      let p: THREE.Object3D | null = obj.parent
      while (p) {
        if (p.visible === false) {
          visibilityRestore.push({ obj: p, visible: false })
          p.visible = true
        }
        p = p.parent
      }
    }
    try {
      this.raycaster.layers.set(0)
      this.raycaster.set(ray.origin, ray.direction)
      const hits = this.raycaster.intersectObjects(gltfTargets, true)
      for (const hit of hits) {
        const entity = hit.object.userData.entity as Entity | undefined
        if (entity === undefined) continue
        out.push({ distance: hit.distance, entity })
      }
    } finally {
      for (const { obj, visible } of visibilityRestore) obj.visible = visible
    }
    return out
  }

  /** Closest in-range PROXIMITY PointerEvents target (Genesis planters, E-key interact). */
  private pickProximityTarget(button: InputActionValue): PointerHit | null {
    if (!this.deps || !this.pointerEntitySet.size) return null
    const { ecs, camera, getPlayerPosition } = this.deps
    camera.getWorldPosition(_camPos)
    const playerPos = getPlayerPosition()

    let best: PointerHit | null = null
    for (const entity of this.pointerEntitySet) {
      const spec = ecs.PointerEvents.getOrNull(entity)
      if (!hasPointerEvent(spec, PointerEventType.PET_DOWN, button, InteractionType.PROXIMITY)) continue

      const distances = measureEntityDistances(
        entity,
        _camPos,
        playerPos,
        this.deps.getWorldTransformDeps()
      )
      const hit = buildSyntheticProximityHit(
        entity,
        spec!,
        distances,
        this.deps.getWorldTransformDeps()
      )
      if (!pointerEventInRange(spec, PointerEventType.PET_DOWN, button, hit)) continue

      if (!best || hit.playerDistance < best.playerDistance) best = hit
    }
    return best
  }

  /** Map collider entity to the nearest ancestor registered for pointer events. */
  private resolveColliderPointerEntity(entity: Entity): Entity | null {
    if (!this.deps) return null
    const { ecs, view } = this.deps
    const { RootEntity: Root, PlayerEntity: Player, CameraEntity: Camera } = view
    let current: Entity = entity
    for (;;) {
      if (this.pointerEntitySet.has(current)) return current
      const parent: Entity | undefined = ecs.Transform.getOrNull(current)?.parent
      if (parent === undefined || parent === Root || parent === Player || parent === Camera) {
        return null
      }
      current = parent
    }
  }

  /** Walk parent chain — sit triggers often live on a child with MeshCollider only. */
  private resolveHighlightEntity(entity: Entity): Entity {
    if (!this.deps) return entity
    const { ecs, view } = this.deps
    const { RootEntity: Root, PlayerEntity: Player, CameraEntity: Camera } = view
    let current: Entity = entity
    for (;;) {
      if (ecs.GltfContainer.has(current) || ecs.MeshRenderer.has(current)) return current
      const parent: Entity | undefined = ecs.Transform.getOrNull(current)?.parent
      if (parent === undefined || parent === Root || parent === Player || parent === Camera) {
        break
      }
      current = parent
    }
    return entity
  }

  private collectHighlightMeshes(entity: Entity): THREE.Mesh[] {
    if (!this.deps) return []
    const { ecs, getEntityNodes } = this.deps
    const nodes = getEntityNodes()
    const visualEntity = this.resolveHighlightEntity(entity)
    const meshes: THREE.Mesh[] = []

    if (ecs.GltfContainer.has(visualEntity)) {
      const obj = nodes.get(visualEntity)
      const gltfRoot = poseDrawVisual(obj, visualEntity) ?? obj
      if (gltfRoot && !obj?.userData.dclInstanced) {
        gltfRoot.traverse((node) => {
          if (!(node instanceof THREE.Mesh) || !node.geometry) return
          if (node.name === '__pointer_highlight__') return
          if ((node as THREE.InstancedMesh).isInstancedMesh) return
          if (isGltfInvisibleColliderMesh(node, gltfRoot)) return
          if (node.visible === false) return
          meshes.push(node)
        })
      }
    }

    if (!meshes.length && ecs.MeshRenderer.has(visualEntity)) {
      const obj = nodes.get(visualEntity)
      const primitive = poseDrawVisual(obj, visualEntity)
      if (primitive instanceof THREE.Mesh && primitive.geometry) meshes.push(primitive)
    }

    return meshes
  }

  private collectPointerTargets(): void {
    if (!this.deps) return
    const { ecs, getEntityNodes } = this.deps
    const nodes = getEntityNodes()
    this.pointerTargets.length = 0

    for (const entity of this.pointerEntitySet) {
      const obj = nodes.get(entity)
      if (this.isPointerEntityInactive(entity, obj)) continue
      if (ecs.GltfContainer.has(entity)) {
        const obj = nodes.get(entity)
        // GPU-instanced GLTF: empty marker only — InstancedMeshes added below for raycast.
        if (!obj?.userData.dclInstanced) {
          const gltfRoot = poseDrawVisual(obj, entity)
          if (gltfRoot) {
            collectGltfPointerTargetMeshes(
              gltfRoot,
              ecs.GltfContainer.get(entity),
              entity,
              true,
              this.pointerTargets
            )
          }
        }
        // Same entity may also have MeshCollider (pointer layer) for PE.
        if (ecs.MeshCollider.has(entity)) {
          const mesh = this.deps.collision.getColliderMesh(entity)
          if (mesh) this.pointerTargets.push(mesh)
        }
        this.collectDescendantPointerTargets(entity, ecs, nodes)
        continue
      }

      if (ecs.MeshCollider.has(entity)) {
        const mesh = this.deps.collision.getColliderMesh(entity)
        if (mesh) {
          // Live visual → collider pose before raycast (stale matrixWorld = PE miss).
          const visual = nodes.get(entity)
          if (visual) {
            visual.updateMatrixWorld(true)
            this.deps.collision.syncColliderEntityPose(entity, nodes)
          }
          mesh.updateMatrixWorld(true)
          this.pointerTargets.push(mesh)
        }
      }

      if (ecs.MeshRenderer.has(entity)) {
        const obj = nodes.get(entity)
        const primitive = poseDrawVisual(obj, entity)
        // Private MeshRenderer (textured / PE) — direct raycast target.
        // Marker-only instanced leaves use dclMeshRendererInstance (GPU InstancedMesh below).
        if (primitive instanceof THREE.Mesh && !primitive.userData.dclMeshRendererInstance) {
          primitive.userData.entity = entity
          obj?.updateMatrixWorld(true)
          primitive.updateMatrixWorld(true)
          this.pointerTargets.push(primitive)
        }
        // Instanced board tiles — marker Group only; GPU mesh is shared InstancedMesh.
      }

      this.collectDescendantPointerTargets(entity, ecs, nodes)
    }

    // Instance raycast for PE entities and instanced Gltf/MeshRenderer descendants
    // (asset-pack sit/sign: PE on parent, Gltf on child). Never dump the full board.
    const instanceEntities: Entity[] = []
    const seenInst = new Set<Entity>()
    const addIfInstanced = (entity: Entity): void => {
      if (seenInst.has(entity)) return
      const obj = nodes.get(entity)
      if (obj?.userData.dclInstanced || obj?.userData.dclMeshRendererInstanced) {
        seenInst.add(entity)
        instanceEntities.push(entity)
      }
    }
    for (const entity of this.pointerEntitySet) {
      addIfInstanced(entity)
      const stack = [...(this.childrenByParent.get(entity) ?? [])]
      while (stack.length) {
        const child = stack.pop()!
        addIfInstanced(child)
        const next = this.childrenByParent.get(child)
        if (next) stack.push(...next)
      }
    }
    if (instanceEntities.length) {
      const instMeshes =
        this.deps.getInstancePointerMeshesFor?.(instanceEntities) ??
        this.deps.getMeshRendererInstancePointerMeshes?.() ??
        []
      for (const mesh of instMeshes) {
        this.pointerTargets.push(mesh)
      }
    }
  }

  /**
   * Drop PE only when the scene collapsed the volume (plaza LO() scale 0.001).
   * VisibilityComponent hides drawing, not colliders / PointerEvents — Creator Hub
   * `click_area` (Winterfest X/Twitch/marketplace) is authored `visible: false`
   * with `visibleMeshesCollisionMask: CL_POINTER`.
   */
  private isPointerEntityInactive(
    entity: Entity,
    obj: THREE.Object3D | undefined
  ): boolean {
    const { ecs } = this.deps!
    if (obj) {
      obj.updateMatrixWorld(true)
      const e = obj.matrixWorld.elements
      const lx = Math.hypot(e[0]!, e[1]!, e[2]!)
      const ly = Math.hypot(e[4]!, e[5]!, e[6]!)
      const lz = Math.hypot(e[8]!, e[9]!, e[10]!)
      if (lx < 0.05 && ly < 0.05 && lz < 0.05) return true
    }
    if (ecs.Transform?.has(entity)) {
      const s = ecs.Transform.get(entity).scale
      if (Math.abs(s.x) < 0.05 && Math.abs(s.y) < 0.05 && Math.abs(s.z) < 0.05) return true
    }
    return false
  }

  /** Asset-pack Triggers: MeshCollider / GLTF on child entities under a PointerEvents parent. */
  private collectDescendantPointerTargets(
    entity: Entity,
    ecs: MirrorComponents,
    nodes: Map<Entity, THREE.Group>
  ): void {
    if (!this.deps) return
    const { collision } = this.deps
    const stack = [...(this.childrenByParent.get(entity) ?? [])]

    while (stack.length) {
      const child = stack.pop()!
      if (this.pointerEntitySet.has(child)) continue

      if (ecs.MeshCollider.has(child)) {
        const mesh = collision.getColliderMesh(child)
        if (mesh) this.pointerTargets.push(mesh)
      }

      if (ecs.GltfContainer.has(child)) {
        const obj = nodes.get(child)
        const gltfRoot = poseDrawVisual(obj, child)
        if (gltfRoot) {
          collectGltfPointerTargetMeshes(
            gltfRoot,
            ecs.GltfContainer.get(child),
            child,
            false,
            this.pointerTargets
          )
        }
      }

      if (ecs.MeshRenderer.has(child)) {
        const obj = nodes.get(child)
        const primitive = poseDrawVisual(obj, child)
        if (primitive instanceof THREE.Mesh && !primitive.userData.dclMeshRendererInstance) {
          primitive.userData.entity = child
          this.pointerTargets.push(primitive)
        }
      }

      const nested = this.childrenByParent.get(child)
      if (nested?.length) stack.push(...nested)
    }
  }

  private emitHover(
    ecs: MirrorComponents,
    entity: Entity,
    state:
      | typeof PointerEventType.PET_HOVER_ENTER
      | typeof PointerEventType.PET_HOVER_LEAVE,
    hit: PointerHit | null
  ): void {
    const isUi = hit?.isSceneUi === true || ecs.UiTransform.has(entity)
    const spec = isUi ? this.uiPointerSpec(entity) : ecs.PointerEvents.getOrNull(entity)
    const button = spec ? hoverButtonForSpec(spec, state) : InputAction.IA_POINTER
    if (!isUi) {
      if (!spec || !hasPointerEvent(spec, state, button)) return
    } else if (spec && !hasUiPointerEvent(spec, state, button)) {
      return
    }

    const syntheticHit: PointerHit =
      hit ??
      ({
        entity,
        point: _camPos.clone(),
        distance: 0,
        normal: new THREE.Vector3(0, 1, 0),
        priority: 0,
        cameraDistance: Infinity,
        playerDistance: Infinity,
        inRange: false,
        isSceneUi: isUi
      } as PointerHit)

    const targetEntity = isUi ? entity : this.resolvePointerResultEntity(entity, button, state)
    this.writeResult(ecs, targetEntity, syntheticHit, state, button)
    if (isUi) this.queueHoverInject(targetEntity, state, syntheticHit)
  }

  private syncSceneUiHover(hit: PointerHit): void {
    if (!this.deps) return
    const nextHover = this.resolveHoverEntity(hit)
    if (nextHover === this.hoverEntity) return
    if (this.hoverEntity !== null) {
      this.emitHover(this.deps.ecs, this.hoverEntity, PointerEventType.PET_HOVER_LEAVE, hit)
    }
    if (nextHover !== null) {
      this.emitHover(this.deps.ecs, nextHover, PointerEventType.PET_HOVER_ENTER, hit)
    }
    this.hoverEntity = nextHover
  }

  private queueHoverInject(
    entity: Entity,
    state:
      | typeof PointerEventType.PET_HOVER_ENTER
      | typeof PointerEventType.PET_HOVER_LEAVE,
    hit: PointerHit
  ): void {
    const ppi = this.buildPrimaryPointerInfo(false)
    const dclPoint = threeToDclVec(hit.point)
    const dclNormal = threeToDclVec(hit.normal)
    const ts = nextPointerEventTimestamp()
    this.pendingHoverInjects.push({
      entity: entity as number,
      entities: [entity as number],
      downEntities: [entity as number],
      upEntities: [entity as number],
      hitEntity: entity as number,
      button: InputAction.IA_POINTER,
      tickNumber: this.tickNumber,
      downTimestamp: ts,
      upTimestamp: ts,
      hitPosition: { x: dclPoint.x, y: dclPoint.y, z: dclPoint.z },
      hitNormal: { x: dclNormal.x, y: dclNormal.y, z: dclNormal.z },
      hitDistance: hit.distance,
      sceneUi: true,
      phase: state === PointerEventType.PET_HOVER_ENTER ? 'hover-enter' : 'hover-leave',
      primaryPointer: ppi
    })
  }

  private clearHoverIfNeeded(ecs: MirrorComponents): void {
    if (this.hoverEntity === null) return
    this.emitHover(ecs, this.hoverEntity, PointerEventType.PET_HOVER_LEAVE, null)
    this.hoverEntity = null
  }

  /**
   * Prefer topmost ancestor with matching PointerEvents — asset-packs registers onPointerDown
   * on the Triggers entity (often parent) while the raycast hits a child MeshCollider.
   */
  private buildUiPointerHit(entity: Entity, cameraPos: THREE.Vector3): PointerHit {
    return {
      entity,
      point: cameraPos.clone(),
      distance: 0,
      normal: new THREE.Vector3(0, 1, 0),
      priority: 0,
      cameraDistance: 0,
      playerDistance: 0,
      inRange: true,
      isSceneUi: true
    }
  }

  private uiPointerSpec(
    entity: Entity
  ): { pointerEvents: ReadonlyArray<PBPointerEvents_Entry> } | null | undefined {
    if (!this.deps) return null
    return this.deps.pointerEventsOf?.(entity) ?? this.deps.ecs.PointerEvents.getOrNull(entity)
  }

  private resolvePointerResultEntity(
    entity: Entity,
    button: InputActionValue,
    state: PointerEventTypeValue = PointerEventType.PET_DOWN
  ): Entity {
    if (!this.deps) return entity
    const { ecs, view } = this.deps
    if (ecs.UiTransform.has(entity)) {
      return resolveUiPointerResultEntity(ecs, view, entity, button, state, this.deps.pointerEventsOf)
    }
    const { RootEntity: Root, PlayerEntity: Player, CameraEntity: Camera } = view
    let current: Entity = entity
    let best: Entity | null = null
    for (;;) {
      const spec = ecs.PointerEvents.getOrNull(current)
      if (spec && hasPointerEvent(spec, state, button)) {
        best = current
      }
      const parent: Entity | undefined = ecs.Transform.getOrNull(current)?.parent
      if (parent === undefined || parent === Root || parent === Player || parent === Camera) {
        break
      }
      current = parent
    }
    return best ?? entity
  }

  /**
   * Every ancestor with matching PointerEvents — scene `onPointerDown` may register on a parent
   * Triggers entity while the raycast hits a child collider (865 vs trigger root).
   */
  private collectPointerResultTargets(
    entity: Entity,
    button: InputActionValue,
    state: PointerEventTypeValue
  ): Entity[] {
    if (!this.deps) return [entity]
    const { ecs, view } = this.deps
    if (ecs.UiTransform.has(entity)) {
      return collectUiPointerResultTargets(ecs, view, entity, button, state, this.deps.pointerEventsOf)
    }
    const { RootEntity: Root, PlayerEntity: Player, CameraEntity: Camera } = view
    const targets: Entity[] = []
    let current: Entity = entity
    for (;;) {
      const spec = ecs.PointerEvents.getOrNull(current)
      if (spec && pointerResultTarget(spec, state, button)) {
        targets.push(current)
      }
      const parent: Entity | undefined = ecs.Transform.getOrNull(current)?.parent
      if (parent === undefined || parent === Root || parent === Player || parent === Camera) {
        break
      }
      current = parent
    }
    if (!targets.length) targets.push(entity)
    return targets
  }

  private writeResult(
    ecs: MirrorComponents,
    targetEntity: Entity,
    hit: PointerHit,
    state: PointerEventTypeValue,
    button: InputActionValue
  ): void {
    const result: PBPointerEventsResult = {
      button,
      state,
      timestamp: nextPointerEventTimestamp(),
      tickNumber: this.tickNumber,
      hit: buildRaycastHit(hit),
      analog: undefined
    }
    let targets: Entity[]
    // Level-state / reserved player: single target (no PE bubble walk).
    if (hit.isLevelState) {
      targets = [targetEntity]
    } else {
      const bubbleFrom = hit.isSceneUi ? hit.entity : targetEntity
      targets = this.collectPointerResultTargets(bubbleFrom, button, state)
      // react-ecs onMouseDown registers on the resolved leaf — never bubble UI inject to scrim ancestors.
      if (hit.isSceneUi) {
        targets = [targetEntity]
      }
    }
    for (const entity of targets) {
      // Local host/projection only — PE edges to the scene worker are inject-only.
      // recordAppend is a no-op for PointerEventsResult (never-record gate).
      ecs.PointerEventsResult.addValue(entity, result)
      this.deps?.recordAppend?.(ecs.PointerEventsResult.componentId, entity, result)
    }
    if (state === PointerEventType.PET_DOWN) {
      this.downTimestampByButton.set(button, result.timestamp)
      this.pendingInjectDownEntities = [...targets]
      const dclPoint = threeToDclVec(hit.point)
      const dclNormal = threeToDclVec(hit.normal)
      const isSceneUi =
        hit.isSceneUi === true ||
        targets.some((id) => this.deps?.ecs.UiTransform.has(id as Entity)) ||
        (this.deps?.ecs.UiTransform.has(targetEntity) ?? false)
      // Every scene: DOWN edge inject so isPressed sticks until UP (Explorer press lifecycle).
      // Attach PPI so worker edge tick has live screen/ray (UI chrome gate + ground ray).
      // Ray origin/direction required for Explorer-parity RaycastHit (click VFX placement).
      const ppi = this.buildPrimaryPointerInfo(false)
      const dclOrigin = threeToDclVec(_ray.origin)
      // DecentraCraft (-16,124): HS() = getInputCommand(IA_POINTER, PET_DOWN)?.hit?.entityId
      // matches unit/building colliders. Level-state ground must report entityId 0 (empty),
      // not PlayerEntity — otherwise jT (isPressOnSelectable) can poison release path.
      const rayHitEntity = hit.isLevelState === true ? 0 : (hit.entity as number)
      this.pendingInjectPayload = {
        entity: targetEntity,
        entities: [...targets],
        downEntities: [...targets],
        upEntities: [...targets],
        hitEntity: rayHitEntity,
        button,
        tickNumber: this.tickNumber,
        downTimestamp: result.timestamp,
        upTimestamp: result.timestamp,
        hitPosition: { x: dclPoint.x, y: dclPoint.y, z: dclPoint.z },
        hitNormal: { x: dclNormal.x, y: dclNormal.y, z: dclNormal.z },
        hitDistance: hit.distance,
        hitOrigin: { x: dclOrigin.x, y: dclOrigin.y, z: dclOrigin.z },
        hitDirection: {
          x: ppi.worldRayDirection.x,
          y: ppi.worldRayDirection.y,
          z: ppi.worldRayDirection.z
        },
        meshName: hit.meshName,
        sceneUi: isSceneUi,
        levelState: hit.isLevelState === true,
        phase: 'down',
        primaryPointer: ppi
      }
    } else if (state === PointerEventType.PET_UP) {
      const downTs = this.downTimestampByButton.get(button)
      if (downTs !== undefined) {
        this.downTimestampByButton.delete(button)
        const dclPoint = threeToDclVec(hit.point)
        const dclNormal = threeToDclVec(hit.normal)
        const downEntities = this.pendingInjectDownEntities ?? [...targets]
        this.pendingInjectDownEntities = null
        const isSceneUi =
          hit.isSceneUi === true ||
          downEntities.some((id) => this.deps?.ecs.UiTransform.has(id as Entity)) ||
          (this.deps?.ecs.UiTransform.has(targetEntity) ?? false)
        const ppi = this.buildPrimaryPointerInfo(false)
        const dclOrigin = threeToDclVec(_ray.origin)
        const rayHitEntity = hit.isLevelState === true ? 0 : (hit.entity as number)
        this.pendingInjectPayload = {
          entity: targetEntity,
          entities: [...targets],
          downEntities,
          upEntities: [...targets],
          hitEntity: rayHitEntity,
          button,
          tickNumber: this.tickNumber,
          downTimestamp: downTs,
          upTimestamp: result.timestamp,
          hitPosition: { x: dclPoint.x, y: dclPoint.y, z: dclPoint.z },
          hitNormal: { x: dclNormal.x, y: dclNormal.y, z: dclNormal.z },
          hitDistance: hit.distance,
          hitOrigin: { x: dclOrigin.x, y: dclOrigin.y, z: dclOrigin.z },
          hitDirection: {
            x: ppi.worldRayDirection.x,
            y: ppi.worldRayDirection.y,
            z: ppi.worldRayDirection.z
          },
          meshName: hit.meshName,
          sceneUi: isSceneUi,
          levelState: hit.isLevelState === true,
          phase: 'up',
          primaryPointer: ppi
        }
      }
    }
    if (state === PointerEventType.PET_DOWN || state === PointerEventType.PET_UP) {
      const entityLabel =
        targets.length > 1
          ? `[${targets.join(', ')}] (hit=${hit.entity})`
          : targets[0] !== hit.entity
            ? `${targets[0]} (hit=${hit.entity})`
            : String(targets[0])
      const line = `${state === PointerEventType.PET_DOWN ? 'PET_DOWN' : 'PET_UP'} entity=${entityLabel} button=${button} ts=${result.timestamp}`
      console.log('[pointer]', line)
      clientDebugLog.log('pointer', line, { alsoConsole: false })
    }
  }

  /**
   * Write PrimaryPointerInfo to the projection ECS.
   * @param consumeDelta — true clears screenDx/Dy after capture (only once per frame).
   *   tickPlayFrame calls syncInput (consume=false) then getPrimaryPointerSnapshot (true)
   *   so the worker embed sees real screenDelta for VC drag/edge pan.
   */
  private syncPrimaryPointerInfo(
    _camera: THREE.Camera,
    hit: PointerHit | null,
    consumeDelta = false
  ): void {
    if (!this.deps) return
    const { ecs, view } = this.deps

    const info = this.buildPrimaryPointerInfo(consumeDelta)

    // Include quantized world ray — under pointer-lock, screen coords stay fixed while the
    // camera (and thus aim ray) turns. Plaza fishing bobber systems read worldRayDirection.
    const d = info.worldRayDirection
    const key =
      `${info.screenCoordinates.x.toFixed(1)}|${info.screenCoordinates.y.toFixed(1)}|` +
      `${info.screenDelta.x}|${info.screenDelta.y}|${hit?.entity ?? ''}|` +
      `${d.x.toFixed(3)}|${d.y.toFixed(3)}|${d.z.toFixed(3)}`
    if (key === this.lastPrimaryInfoKey) return
    this.lastPrimaryInfoKey = key

    ecs.PrimaryPointerInfo.createOrReplace(view.RootEntity, info)
  }

  /**
   * Live PPI fields from current `_ray` + virtual canvas screen coords.
   * Always builds from the ray — do not depend on projection read-back for play-frame embed.
   * @param consumeDelta clear movement accumulators after reading (Explorer per-sample delta).
   */
  private buildPrimaryPointerInfo(consumeDelta = false): {
    pointerType: number
    screenCoordinates: { x: number; y: number }
    screenDelta: { x: number; y: number }
    worldRayDirection: { x: number; y: number; z: number }
  } {
    const worldDir = _ray.direction.clone()
    const dclDir = threeToDclVec(worldDir)
    // Virtual canvas space — matches UiCanvasInformation so scene systems that
    // rebuild rays from screenCoordinates + canvas size stay consistent.
    const screen = this.screenCoordinatesInVirtualCanvas()
    // Explorer/Unity: +screenDelta.y = cursor moved toward top of screen.
    // DOM movementY is opposite (positive = move down) — invert for parity.
    const deltaX = this.screenDx
    const deltaY = -this.screenDy
    if (consumeDelta) {
      this.screenDx = 0
      this.screenDy = 0
    }
    return {
      pointerType: 1,
      screenCoordinates: { x: screen.x, y: screen.y },
      screenDelta: { x: deltaX, y: deltaY },
      worldRayDirection: { x: dclDir.x, y: dclDir.y, z: dclDir.z }
    }
  }

  /**
   * Map document client coords → virtual UI canvas pixels (stretch-fill canvas rect).
   * **Y origin is bottom-left** (Unity / DCL Explorer PrimaryPointerInfo), not DOM top-left.
   * Clamp to [0, vw]×[0, vh]. Cursor slightly outside the canvas (HUD over edge) still
   * reports edge pixels so edge-pan (x≈0 left, x≈vw right) keeps working.
   */
  private screenCoordinatesInVirtualCanvas(): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect()
    const w = Math.max(1, rect.width)
    const h = Math.max(1, rect.height)
    // Prefer live UiCanvasInformation. Pre-7.26 scenes omit virtual size — use the
    // canvas box (not SDK 7.26's 1920×1080 default).
    let vw = Math.max(1, Math.round(w))
    let vh = Math.max(1, Math.round(h))
    const canvasInfo = this.deps?.ecs.UiCanvasInformation?.getOrNull?.(
      this.deps.view.RootEntity
    ) as { width?: number; height?: number } | null | undefined
    if (canvasInfo?.width && canvasInfo.width > 0) vw = canvasInfo.width
    if (canvasInfo?.height && canvasInfo.height > 0) vh = canvasInfo.height

    const nx = (this.screenX - rect.left) / w
    // DOM: ny=0 at top. Explorer PrimaryPointerInfo: y=0 at bottom.
    const nyTop = (this.screenY - rect.top) / h
    const nyBottom = 1 - nyTop
    // Keep a 1px interior when exactly 0,0 — some scenes treat (0,0) as "no cursor".
    let x = Math.min(vw, Math.max(0, nx * vw))
    let y = Math.min(vh, Math.max(0, nyBottom * vh))
    if (x === 0 && y === 0) {
      x = 1
      y = 1
    }
    return { x, y }
  }

  /**
   * Snapshot for play-frame-tick embed — always current ray, never null when bound.
   * Previously read projection after dirty-key skip and could drop worldRayDirection,
   * which left the worker with stale/missing PPI (plaza fishing bobber aim).
   */
  getPrimaryPointerSnapshot(): {
    pointerType: number
    screenCoordinates: { x: number; y: number }
    screenDelta: { x: number; y: number }
    worldRayDirection: { x: number; y: number; z: number }
  } | null {
    if (!this.deps) return null
    const camera = this.deps.camera
    camera.updateMatrixWorld(true)
    const el = camera.matrixWorld.elements
    const screenKey = `${this.screenX.toFixed(1)}|${this.screenY.toFixed(1)}|${this.screenDx}|${this.screenDy}`
    let camSame = this.lastPpiSnapshot != null
    if (camSame) {
      for (let i = 0; i < 16; i++) {
        if (Math.abs(el[i] - this.lastPpiCamElements[i]) > 1e-6) {
          camSame = false
          break
        }
      }
    }
    if (!camSame || screenKey !== this.lastPpiScreenKey) {
      this.refreshPointerRay(camera)
      this.lastPpiCamElements.set(el)
      this.lastPpiScreenKey = screenKey
    }
    // Consume deltas here (once per play frame) so worker embed gets non-zero screenDelta
    // for DecentraCraft VC drag/edge pan. syncInput earlier this frame uses consume=false.
    const info = this.buildPrimaryPointerInfo(true)
    this.lastPpiSnapshot = info
    const d = info.worldRayDirection
    const key =
      `${info.screenCoordinates.x.toFixed(1)}|${info.screenCoordinates.y.toFixed(1)}|` +
      `${info.screenDelta.x}|${info.screenDelta.y}|${this.lastHit?.entity ?? ''}|` +
      `${d.x.toFixed(3)}|${d.y.toFixed(3)}|${d.z.toFixed(3)}`
    // Play-frame embed is the guest source. Do not dirty host PPI every look —
    // that was identity echo back through renderer-inbound-deliver.
    this.lastPrimaryInfoKey = key
    this.maybeLogPrimaryPointer(info)
    return info
  }

  /**
   * Throttled diagnostic for fishing bobber aim (~2 Hz).
   * Includes DCL camera origin + estimated water-plane (y=1.2) aim point so we can
   * verify scene setBobberPosition should land in the pond.
   */
  private maybeLogPrimaryPointer(info: {
    screenCoordinates: { x: number; y: number }
    worldRayDirection: { x: number; y: number; z: number }
  }): void {
    if (!PointerEventsSystem.ppiDiagEnabled) return
    const now = performance.now()
    if (now - this.lastPpiDiagAt < PointerEventsSystem.PPI_DIAG_MS) return
    this.lastPpiDiagAt = now
    const d = info.worldRayDirection
    const s = info.screenCoordinates
    const locked = document.pointerLockElement === this.canvas
    const hit = this.lastHit
    const hitLabel = hit
      ? `hit=e${hit.entity as number} cam=${hit.cameraDistance.toFixed(1)}m`
      : 'hit=none'

    // Ray origin = live Three camera → DCL (same path as reserved CameraEntity pose).
    let originLabel = 'cam=?'
    let aimLabel = 'aim=?'
    if (this.deps) {
      this.deps.camera.getWorldPosition(_camPos)
      const camDcl = threeToDclVec(_camPos)
      originLabel = `cam=(${camDcl.x.toFixed(1)},${camDcl.y.toFixed(1)},${camDcl.z.toFixed(1)})`
      // Plaza pond water ≈ y=1.2 — scene bobber systems intersect this plane.
      const waterY = 1.2
      if (Math.abs(d.y) > 1e-4) {
        const t = (waterY - camDcl.y) / d.y
        if (t > 0 && t < 80) {
          aimLabel = `aim=(${(camDcl.x + d.x * t).toFixed(1)},${waterY.toFixed(1)},${(camDcl.z + d.z * t).toFixed(1)}) t=${t.toFixed(1)}`
        } else {
          aimLabel = `aim=miss(t=${t.toFixed(1)})`
        }
      } else {
        aimLabel = 'aim=parallel'
      }
    }

    clientDebugLog.log(
      'pointer',
      `PPI screen=(${s.x.toFixed(0)},${s.y.toFixed(0)}) ray=(${d.x.toFixed(3)},${d.y.toFixed(3)},${d.z.toFixed(3)}) ` +
        `${originLabel} ${aimLabel} lock=${locked ? 1 : 0} ${hitLabel}`,
      { alsoConsole: true, throttleMs: PointerEventsSystem.PPI_DIAG_MS, throttleKey: 'ppi-diag' }
    )
  }

  /** Crosshair over UiInput / UiDropdown — never route E/F/etc. as ECS pointer keys. */
  private isPointerOverSceneUiField(): boolean {
    if (!this.deps?.pickUiRegionHit || !this.deps.isSceneUiFieldEntity) return false
    const hit = this.deps.pickUiRegionHit(this.screenX, this.screenY)
    return hit !== null && this.deps.isSceneUiFieldEntity(hit.entity)
  }

  private isTypingTarget(): boolean {
    if (isTextInputFocused()) return true
    if (isSceneUiTypingFocus()) return true
    return false
  }
}

function mouseButtonToInputAction(button: number): InputActionValue {
  // DCL: IA_POINTER = left click, IA_SECONDARY = right click; IA_PRIMARY is E-key only.
  if (button === 0) return InputAction.IA_POINTER
  if (button === 2) return InputAction.IA_SECONDARY
  return InputAction.IA_POINTER
}

function mouseInteractLabel(button: InputActionValue, mouseButton?: number): string {
  if (mouseButton === 2) return 'right-click'
  return inputActionInteractLabel(button)
}

function buildPointerHit(
  _ecs: MirrorComponents,
  entity: Entity,
  hit: THREE.Intersection,
  spec: { pointerEvents: ReadonlyArray<PBPointerEvents_Entry> },
  cameraPos: THREE.Vector3,
  playerPos: THREE.Vector3 | null
): PointerHit {
  const { cameraDistance, playerDistance } = measureHitDistances(hit.point, cameraPos, playerPos)
  return {
    entity,
    point: hit.point.clone(),
    distance: hit.distance,
    normal: (hit.normal ?? _worldNormal.set(0, 1, 0)).clone(),
    meshName: hit.object.name || undefined,
    priority: maxEntryPriority(spec),
    cameraDistance,
    playerDistance,
    inRange: pointerHighlightInRange(spec, cameraDistance, playerDistance)
  }
}

function buildPointerHitFromCollider(
  _ecs: MirrorComponents,
  hit: { entity: Entity; point: THREE.Vector3; distance: number; normal: THREE.Vector3 },
  spec: { pointerEvents: ReadonlyArray<PBPointerEvents_Entry> },
  cameraPos: THREE.Vector3,
  playerPos: THREE.Vector3 | null
): PointerHit {
  const { cameraDistance, playerDistance } = measureHitDistances(hit.point, cameraPos, playerPos)
  return {
    entity: hit.entity,
    point: hit.point,
    distance: hit.distance,
    normal: hit.normal,
    priority: maxEntryPriority(spec),
    cameraDistance,
    playerDistance,
    inRange: pointerHighlightInRange(spec, cameraDistance, playerDistance)
  }
}

function measureHitDistances(
  point: THREE.Vector3,
  cameraPos: THREE.Vector3,
  playerPos: THREE.Vector3 | null
): { cameraDistance: number; playerDistance: number } {
  return {
    cameraDistance: cameraPos.distanceTo(point),
    playerDistance: playerPos ? playerPos.distanceTo(point) : Infinity
  }
}

function measureEntityDistances(
  entity: Entity,
  cameraPos: THREE.Vector3,
  playerPos: THREE.Vector3 | null,
  worldDeps: EntityWorldTransformDeps | null
): { cameraDistance: number; playerDistance: number } {
  if (!worldDeps || !resolveEntityWorldPosition(entity, worldDeps, _entityPos)) {
    return { cameraDistance: Infinity, playerDistance: Infinity }
  }
  return {
    cameraDistance: cameraPos.distanceTo(_entityPos),
    playerDistance: playerPos ? playerPos.distanceTo(_entityPos) : Infinity
  }
}

function buttonMatches(entryButton: number | undefined, pressed: InputActionValue): boolean {
  const btn = entryButton ?? InputAction.IA_ANY
  if (btn === InputAction.IA_ANY) return true
  return btn === pressed
}

function hasPointerEvent(
  spec: { pointerEvents: ReadonlyArray<PBPointerEvents_Entry> } | null | undefined,
  eventType: PointerEventTypeValue,
  button: InputActionValue,
  interaction?: number
): boolean {
  if (!spec) return false
  return spec.pointerEvents.some(
    (entry) =>
      entry.eventType === eventType &&
      buttonMatches(entry.eventInfo?.button, button) &&
      (interaction === undefined || (entry.interactionType ?? InteractionType.CURSOR) === interaction)
  )
}

/** onClick registers PET_DOWN only — PET_UP results must still land on that entity. */
function pointerResultTarget(
  spec: { pointerEvents: ReadonlyArray<PBPointerEvents_Entry> },
  state: PointerEventTypeValue,
  button: InputActionValue
): boolean {
  if (hasPointerEvent(spec, state, button)) return true
  if (state === PointerEventType.PET_UP && hasPointerEvent(spec, PointerEventType.PET_DOWN, button)) {
    return true
  }
  return false
}

function maxEntryPriority(spec: { pointerEvents: ReadonlyArray<PBPointerEvents_Entry> }): number {
  let max = 0
  for (const entry of spec.pointerEvents) {
    const p = entry.eventInfo?.priority ?? 0
    if (p > max) max = p
  }
  return max
}

/** Hover tooltip range — any cursor entry with showFeedback within its distance fields. */
function pointerFeedbackInRange(
  spec: { pointerEvents: ReadonlyArray<PBPointerEvents_Entry> },
  hit: Pick<PointerHit, 'cameraDistance' | 'playerDistance'>
): boolean {
  for (const entry of spec.pointerEvents) {
    if ((entry.interactionType ?? InteractionType.CURSOR) !== InteractionType.CURSOR) continue
    const info = entry.eventInfo
    if (info?.showFeedback === false) continue
    if (entryPassesDistance(entry, hit.cameraDistance, hit.playerDistance)) return true
  }
  return false
}

/** Green/red outline — only PointerEvents entries with showHighlight, using that entry's distance fields. */
function pointerHighlightInRange(
  spec: { pointerEvents: ReadonlyArray<PBPointerEvents_Entry> },
  cameraDistance: number,
  playerDistance: number
): boolean {
  for (const entry of spec.pointerEvents) {
    if ((entry.interactionType ?? InteractionType.CURSOR) !== InteractionType.CURSOR) continue
    const info = entry.eventInfo
    if (info?.showFeedback === false) continue
    if (!pointerShowHighlight(info)) continue
    if (entryPassesDistance(entry, cameraDistance, playerDistance)) return true
  }
  return false
}

/** Match a specific PointerEvents entry (event type + button) using only that entry's distance fields. */
function pointerEventInRange(
  spec: { pointerEvents: ReadonlyArray<PBPointerEvents_Entry> } | null | undefined,
  eventType: PointerEventTypeValue,
  button: InputActionValue,
  hit: Pick<PointerHit, 'cameraDistance' | 'playerDistance'>
): boolean {
  if (!spec) return false
  for (const entry of spec.pointerEvents) {
    if (entry.eventType !== eventType) continue
    if (!buttonMatches(entry.eventInfo?.button, button)) continue
    const interaction = entry.interactionType ?? InteractionType.CURSOR
    if (interaction !== InteractionType.CURSOR && interaction !== InteractionType.PROXIMITY) continue
    return entryPassesDistance(entry, hit.cameraDistance, hit.playerDistance)
  }
  return false
}

function buildSyntheticProximityHit(
  entity: Entity,
  spec: { pointerEvents: ReadonlyArray<PBPointerEvents_Entry> },
  distances: { cameraDistance: number; playerDistance: number },
  worldDeps: EntityWorldTransformDeps | null
): PointerHit {
  const point =
    (worldDeps && resolveEntityWorldPosition(entity, worldDeps, new THREE.Vector3())) ??
    _camPos.clone()
  return {
    entity,
    point,
    distance: distances.cameraDistance,
    normal: new THREE.Vector3(0, 1, 0),
    priority: maxEntryPriority(spec),
    cameraDistance: distances.cameraDistance,
    playerDistance: distances.playerDistance,
    inRange: pointerHighlightInRange(spec, distances.cameraDistance, distances.playerDistance)
  }
}

/**
 * PointerEvents range is avatar→hit (SDK `maxDistance` default 10).
 * The aim ray still originates at the camera; only the gate uses player distance.
 * 3rd-person lens is 5–8m behind the avatar — cameraDistance would fail a 10m PE
 * on a prop next to the player.
 */
function entryPassesDistance(
  entry: Readonly<PBPointerEvents_Entry>,
  _cameraDistance: number,
  playerDistance: number
): boolean {
  const maxDistance = entry.eventInfo?.maxDistance ?? 10
  if (playerDistance > maxDistance) return false
  const maxPlayerDistance = entry.eventInfo?.maxPlayerDistance
  if (maxPlayerDistance !== undefined && maxPlayerDistance > 0 && playerDistance > maxPlayerDistance) {
    return false
  }
  return true
}

function hoverButtonForSpec(
  spec: { pointerEvents: ReadonlyArray<PBPointerEvents_Entry> },
  state: typeof PointerEventType.PET_HOVER_ENTER | typeof PointerEventType.PET_HOVER_LEAVE
): InputActionValue {
  for (const entry of spec.pointerEvents) {
    if (entry.eventType !== state) continue
    if ((entry.interactionType ?? InteractionType.CURSOR) !== InteractionType.CURSOR) continue
    return (entry.eventInfo?.button ?? InputAction.IA_POINTER) as InputActionValue
  }
  return InputAction.IA_POINTER
}

function buildSyntheticHit(
  entity: Entity,
  cameraPos: THREE.Vector3,
  playerPos: THREE.Vector3 | null,
  worldDeps: EntityWorldTransformDeps | null
): PointerHit {
  const spec = worldDeps?.view.components.PointerEvents.getOrNull(entity) ?? null
  const { cameraDistance, playerDistance } = measureEntityDistances(
    entity,
    cameraPos,
    playerPos,
    worldDeps
  )
  const point =
    (worldDeps && resolveEntityWorldPosition(entity, worldDeps, new THREE.Vector3())) ??
    cameraPos.clone()
  return {
    entity,
    point,
    distance: cameraDistance,
    normal: new THREE.Vector3(0, 1, 0),
    priority: spec ? maxEntryPriority(spec) : 0,
    cameraDistance,
    playerDistance,
    inRange: spec ? pointerHighlightInRange(spec, cameraDistance, playerDistance) : false
  }
}

function buildRaycastHit(hit: PointerHit): RaycastHit {
  const dclPoint = threeToDclVec(hit.point)
  const dclNormal = threeToDclVec(hit.normal)
  return {
    entityId: hit.entity,
    position: { x: dclPoint.x, y: dclPoint.y, z: dclPoint.z },
    globalOrigin: undefined,
    direction: undefined,
    normalHit: { x: dclNormal.x, y: dclNormal.y, z: dclNormal.z },
    length: hit.distance,
    meshName: hit.meshName
  }
}
