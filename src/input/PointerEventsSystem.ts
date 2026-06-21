import * as THREE from 'three'
import type { Entity } from '@dcl/ecs'
import type { ProjectionView } from '../bridge/ProjectionView'
import type { PBPointerEvents_Entry } from '@dcl/ecs/dist/components/generated/pb/decentraland/sdk/components/pointer_events.gen'
import type { PBPointerEventsResult } from '@dcl/ecs/dist/components/generated/pb/decentraland/sdk/components/pointer_events_result.gen'
import type { RaycastHit } from '@dcl/ecs/dist/components/generated/pb/decentraland/sdk/components/common/raycast_hit.gen'
import { InputAction, InteractionType, PointerEventType, type InputActionValue, type PointerEventTypeValue } from './pointerConstants'
import { inputActionBinding, inputActionInteractLabel, keyCodeToInputActionBinding } from './inputActionBinding'
import type { MirrorComponents } from '../bridge/mirrorComponents'
import { dclToThreeVec, threeToDclVec } from '../bridge/dclTransform'
import type { CollisionSystem } from '../collision/CollisionSystem'
import { ColliderLayer } from '../collision/ColliderLayer'
import { isGltfInvisibleColliderMesh } from '../collision/gltfColliderNaming'
import { collectGltfPointerTargetMeshes } from '../collision/gltfPointerMeshes'
import { PointerHighlightFeedback } from './PointerHighlightFeedback'
import { PointerHoverFeedback } from './PointerHoverFeedback'
import { clientDebugLog } from '../client/debug/ClientDebugLog'
import type { InjectPointerClickBody } from '../player/injectPointerClick'

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
}

type PointerDeps = {
  ecs: MirrorComponents
  view: ProjectionView
  collision: CollisionSystem
  getEntityNodes: () => Map<Entity, THREE.Group>
  camera: THREE.Camera
  getPlayerPosition: () => THREE.Vector3 | null
  isPointerBlocked: () => boolean
  flushPointerCrdt?: () => void
  /** Source-capture each PointerEventsResult append for the outbound CrdtEncoder. */
  recordAppend?: (componentId: number, entity: Entity, value: unknown) => void
}

const _ray = new THREE.Ray()
const _ndc = new THREE.Vector2()
const _camPos = new THREE.Vector3()
const _playerPos = new THREE.Vector3()
const _entityPos = new THREE.Vector3()
const _worldNormal = new THREE.Vector3()

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
  private primaryKeyDown = false
  private readonly pendingPointerDown = new Map<InputActionValue, PointerHit | null>()
  private readonly pendingPointerUp = new Set<InputActionValue>()

  private hoverEntity: Entity | null = null
  private lastHit: PointerHit | null = null
  private readonly downEntityByButton = new Map<InputActionValue, Entity>()
  private timestamp = 1
  private tickNumber = 0
  private readonly downTimestampByButton = new Map<InputActionValue, number>()
  private pendingInjectPayload: InjectPointerClickBody | null = null

  private lastPrimaryInfoKey = ''

  /** Capture phase so pointer clicks run before PlayerInput sets camera-orbit state. */
  private static readonly captureMouse = { capture: true } as const

  constructor(private readonly canvas: HTMLElement) {
    this.canvas.addEventListener('mousemove', this.onMouseMove)
    this.canvas.addEventListener('mousedown', this.onMouseDown, PointerEventsSystem.captureMouse)
    window.addEventListener('mouseup', this.onMouseUp, PointerEventsSystem.captureMouse)
    window.addEventListener('keydown', this.onKeyDown)
    window.addEventListener('keyup', this.onKeyUp)
    this.screenX = window.innerWidth * 0.5
    this.screenY = window.innerHeight * 0.5
  }

  dispose(): void {
    this.canvas.removeEventListener('mousemove', this.onMouseMove)
    this.canvas.removeEventListener('mousedown', this.onMouseDown, PointerEventsSystem.captureMouse)
    window.removeEventListener('mouseup', this.onMouseUp, PointerEventsSystem.captureMouse)
    window.removeEventListener('keydown', this.onKeyDown)
    window.removeEventListener('keyup', this.onKeyUp)
    this.hoverFeedback.dispose()
    this.highlightFeedback.dispose()
    this.deps = null
    this.pointerTargets.length = 0
    this.pointerEntitySet.clear()
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
    this.rebuildPointerEntitySet()
    this.rebuildChildrenByParent()
    this.collectPointerTargets()
    this.pointerCacheDirty = false
  }

  /** Tooltip + mesh highlight only (no CRDT). */
  updateVisuals(tickNumber: number): void {
    if (!this.deps) return

    this.tickNumber = tickNumber
    this.rebuildPointerCacheIfNeeded()

    const pointerLocked = document.pointerLockElement === this.canvas
    const needsRaycast =
      this.pointerDirty || pointerLocked || tickNumber % 3 === 0 || this.primaryKeyDown
    if (!needsRaycast && this.lastHit) {
      this.applyHoverFromHit(this.lastHit)
      this.screenDx = 0
      this.screenDy = 0
      return
    }

    const hit = this.computeCurrentHit()
    this.lastHit = hit

    if (!this.pointerEntitySet.size || !hit) {
      this.hoverFeedback.hide()
      this.highlightFeedback.clear()
      this.screenDx = 0
      this.screenDy = 0
      this.pointerDirty = false
      return
    }

    this.applyHoverFromHit(hit)
    this.screenDx = 0
    this.screenDy = 0
    this.pointerDirty = false
  }

  private applyHoverFromHit(hit: PointerHit): void {
    if (!this.deps) return
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

    const hit = this.pointerEntitySet.size ? this.computeCurrentHit() : null
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

    if (!this.pointerEntitySet.size) {
      this.clearHoverIfNeeded(ecs)
      this.syncPrimaryPointerInfo(camera, null)
      return
    }

    this.syncPrimaryPointerInfo(camera, hit)

    const nextHover = hit ? this.resolvePointerResultEntity(hit.entity, InputAction.IA_POINTER) : null
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

  private computeCurrentHit(): PointerHit | null {
    if (!this.deps || !this.pointerEntitySet.size) return null
    const { collision, camera, getPlayerPosition } = this.deps

    const pointerLocked = document.pointerLockElement === this.canvas
    if (!pointerLocked || this.pointerDirty) {
      const ray = this.computePointerRay(camera)
      _ray.copy(ray)
    } else {
      this.raycaster.setFromCamera(_ndc.set(0, 0), camera)
      _ray.copy(this.raycaster.ray)
    }

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
    this.pointerDirty = true
  }

  private onMouseDown = (e: MouseEvent): void => {
    if (!this.deps) return
    if (this.isTypingTarget()) return
    if (this.deps.isPointerBlocked()) return

    const button = mouseButtonToInputAction(e.button)
    const hit = this.resolveInteractHit(button)
    if (!this.canQueuePointerDown(button, hit)) {
      if (hit) this.logInteractBlocked(mouseInteractLabel(button), button, hit)
      return
    }
    const targetEntity = this.resolvePointerResultEntity(hit!.entity, button)
    this.downEntityByButton.set(button, targetEntity)
    this.pendingPointerDown.set(button, hit)
    if (button === InputAction.IA_POINTER) {
      const label =
        targetEntity !== hit!.entity ? `click → target ${targetEntity} (hit ${hit!.entity})` : `click → entity ${targetEntity}`
      clientDebugLog.log('pointer', label, { alsoConsole: true })
    }
  }

  private onMouseUp = (e: MouseEvent): void => {
    if (!this.deps) return
    const button = mouseButtonToInputAction(e.button)
    if (!this.downEntityByButton.has(button)) return
    this.pendingPointerUp.add(button)
    console.log('[pointer]', `mouseup → flush entity=${this.downEntityByButton.get(button)} button=${button}`)
    this.deps.flushPointerCrdt?.()
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    if (e.repeat) return
    if (!this.deps) return
    if (this.isTypingTarget()) return
    if (this.deps.isPointerBlocked()) return

    const binding = keyCodeToInputActionBinding(e.code)
    if (!binding) return

    const { action, label, preventDefault } = binding
    if (preventDefault) e.preventDefault()

    const hit = this.resolveInteractHit(action)
    if (!this.canQueuePointerDown(action, hit)) {
      if (hit) this.logInteractBlocked(label, action, hit)
      return
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
    return this.pendingPointerDown.size > 0 || this.pendingPointerUp.size > 0
  }

  /** Mobile HUD — same path as E/F keyboard interact. */
  triggerInputAction(action: InputActionValue, phase: 'down' | 'up'): void {
    if (!this.deps) return
    if (phase === 'down') {
      if (this.deps.isPointerBlocked()) return
      const binding = inputActionBinding(action)
      if (!binding) return
      const hit = this.resolveInteractHit(action)
      if (!this.canQueuePointerDown(action, hit)) {
        if (hit) this.logInteractBlocked(binding.label, action, hit)
        return
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

  private tryWritePointerDown(button: InputActionValue, preferredHit: PointerHit | null = null): void {
    if (!this.deps) return

    const activeHit = preferredHit ?? this.pickAtPointer()
    if (!activeHit) return

    const targetEntity = this.resolvePointerResultEntity(activeHit.entity, button)
    const spec = this.deps.ecs.PointerEvents.getOrNull(targetEntity)
    if (!hasPointerEvent(spec, PointerEventType.PET_DOWN, button)) return
    if (!this.hitAllowsPointerDown(spec, button, activeHit)) return

    this.downEntityByButton.set(button, targetEntity)
    this.writeResult(this.deps.ecs, targetEntity, activeHit, PointerEventType.PET_DOWN, button)
  }

  /** Crosshair hit — fall back to last frame when pointer-locked center ray misses collider shell. */
  private resolveInteractHit(button: InputActionValue): PointerHit | null {
    const fresh = this.pickAtPointer()
    if (fresh && this.canQueuePointerDown(button, fresh)) return fresh
    if (this.lastHit && this.canQueuePointerDown(button, this.lastHit)) return this.lastHit
    return fresh ?? this.lastHit
  }

  private canQueuePointerDown(button: InputActionValue, hit: PointerHit | null): boolean {
    if (!this.deps || !hit) return false
    const targetEntity = this.resolvePointerResultEntity(hit.entity, button)
    const spec = this.deps.ecs.PointerEvents.getOrNull(targetEntity)
    if (!hasPointerEvent(spec, PointerEventType.PET_DOWN, button)) return false
    return pointerEventInRange(spec, PointerEventType.PET_DOWN, button, hit)
  }

  private hitAllowsPointerDown(
    spec: { pointerEvents: ReadonlyArray<PBPointerEvents_Entry> } | null | undefined,
    button: InputActionValue,
    hit: Pick<PointerHit, 'cameraDistance' | 'playerDistance'>
  ): boolean {
    return pointerEventInRange(spec, PointerEventType.PET_DOWN, button, hit)
  }

  private logInteractBlocked(label: string, button: InputActionValue, hit: PointerHit | null): void {
    if (!hit) {
      clientDebugLog.log('pointer', `${label} blocked — no target`, { level: 'warn', alsoConsole: true })
      return
    }
    const targetEntity = this.resolvePointerResultEntity(hit.entity, button)
    const spec = this.deps?.ecs.PointerEvents.getOrNull(targetEntity)
    if (!hasPointerEvent(spec, PointerEventType.PET_DOWN, button)) {
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

    const spec = this.deps.ecs.PointerEvents.getOrNull(downEntity)
    // onClick registers PET_DOWN only — renderer must still emit PET_UP (Unity / @dcl/ecs parity).
    if (
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
        : buildSyntheticHit(this.deps.ecs, downEntity, _camPos, this.deps.getPlayerPosition())

    this.writeResult(this.deps.ecs, downEntity, upHit, PointerEventType.PET_UP, button)
    return true
  }

  private tryPointerUp(button: InputActionValue, hit: PointerHit | null): void {
    this.tryWritePointerUp(button, hit ?? this.lastHit)
  }

  private pickAtPointer(): PointerHit | null {
    if (!this.deps) return null
    this.rebuildPointerCacheIfNeeded()
    const ray = this.computePointerRay(this.deps.camera)
    this.deps.camera.getWorldPosition(_camPos)
    return this.pickPointerHit(this.deps.collision, ray, _camPos, this.deps.getPlayerPosition())
  }

  private computePointerRay(camera: THREE.Camera): THREE.Ray {
    const pointerLocked = document.pointerLockElement === this.canvas
    if (pointerLocked) {
      _ndc.set(0, 0)
    } else {
      const rect = this.canvas.getBoundingClientRect()
      _ndc.x = ((this.screenX - rect.left) / rect.width) * 2 - 1
      _ndc.y = -((this.screenY - rect.top) / rect.height) * 2 + 1
    }
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

    if (!this.pointerTargets.length) return null

    this.raycaster.layers.set(0)
    this.raycaster.set(ray.origin, ray.direction)
    const hits = this.raycaster.intersectObjects(this.pointerTargets, false)

    let best: PointerHit | null = null
    for (const hit of hits) {
      const hitEntity = hit.object.userData.entity as Entity | undefined
      if (hitEntity === undefined) continue
      const entity = this.resolveColliderPointerEntity(hitEntity) ?? hitEntity
      if (!this.pointerEntitySet.has(entity)) continue

      const spec = this.deps.ecs.PointerEvents.getOrNull(entity)
      if (!spec) continue

      const pointerHit = buildPointerHit(this.deps.ecs, entity, hit, spec, cameraPos, playerPos)
      pointerHit.entity = entity

      if (!best || pointerHit.priority > best.priority || (pointerHit.priority === best.priority && hit.distance < best.distance)) {
        best = pointerHit
      }
    }

    if (!best) {
      const colliderHits = collision.raycast(ray, ColliderLayer.CL_POINTER)
      for (const hit of colliderHits) {
        const targetEntity = this.resolveColliderPointerEntity(hit.entity)
        if (targetEntity === null) continue
        const spec = this.deps.ecs.PointerEvents.getOrNull(targetEntity)
        if (!spec) continue
        const pointerHit = buildPointerHitFromCollider(this.deps.ecs, hit, spec, cameraPos, playerPos)
        pointerHit.entity = targetEntity
        if (!best || pointerHit.priority > best.priority || (pointerHit.priority === best.priority && hit.distance < best.distance)) {
          best = pointerHit
        }
      }
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
      const gltfRoot = obj?.children.find((c) => c.name.startsWith('__mesh_'))
      if (gltfRoot) {
        gltfRoot.traverse((node) => {
          if (!(node instanceof THREE.Mesh) || !node.geometry) return
          if (node.name === '__pointer_highlight__') return
          if (isGltfInvisibleColliderMesh(node, gltfRoot)) return
          if (node.visible === false) return
          meshes.push(node)
        })
      }
    }

    if (!meshes.length && ecs.MeshRenderer.has(visualEntity)) {
      const obj = nodes.get(visualEntity)
      const primitive = obj?.getObjectByName(`__mesh_${visualEntity}`)
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
      if (ecs.GltfContainer.has(entity)) {
        const obj = nodes.get(entity)
        const gltfRoot = obj?.children.find((c) => c.name.startsWith('__mesh_'))
        if (!gltfRoot) continue
        collectGltfPointerTargetMeshes(
          gltfRoot,
          ecs.GltfContainer.get(entity),
          entity,
          true,
          this.pointerTargets
        )
        continue
      }

      if (ecs.MeshCollider.has(entity)) {
        const mesh = this.deps.collision.getColliderMesh(entity)
        if (mesh) this.pointerTargets.push(mesh)
      }

      if (ecs.MeshRenderer.has(entity)) {
        const obj = nodes.get(entity)
        const mk = `__mesh_${entity}`
        const primitive = obj?.getObjectByName(mk)
        if (primitive instanceof THREE.Mesh) {
          primitive.userData.entity = entity
          this.pointerTargets.push(primitive)
        }
      }

      this.collectDescendantPointerTargets(entity, ecs, nodes)
    }
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
        const gltfRoot = obj?.children.find((c) => c.name.startsWith('__mesh_'))
        if (gltfRoot) {
          collectGltfPointerTargetMeshes(
            gltfRoot,
            ecs.GltfContainer.get(child),
            child,
            true,
            this.pointerTargets
          )
        }
      }

      if (ecs.MeshRenderer.has(child)) {
        const obj = nodes.get(child)
        const primitive = obj?.getObjectByName(`__mesh_${child}`)
        if (primitive instanceof THREE.Mesh) {
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
    const spec = ecs.PointerEvents.getOrNull(entity)
    if (!spec) return

    const button = hoverButtonForSpec(spec, state)
    if (!hasPointerEvent(spec, state, button)) return

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
        inRange: false
      } as PointerHit)

    const targetEntity = this.resolvePointerResultEntity(entity, button, state)
    this.writeResult(ecs, targetEntity, syntheticHit, state, button)
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
  private resolvePointerResultEntity(
    entity: Entity,
    button: InputActionValue,
    state: PointerEventTypeValue = PointerEventType.PET_DOWN
  ): Entity {
    if (!this.deps) return entity
    const { ecs, view } = this.deps
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
      timestamp: this.timestamp++,
      tickNumber: this.tickNumber,
      hit: buildRaycastHit(hit),
      analog: undefined
    }
    const targets = this.collectPointerResultTargets(targetEntity, button, state)
    for (const entity of targets) {
      ecs.PointerEventsResult.addValue(entity, result)
      this.deps?.recordAppend?.(ecs.PointerEventsResult.componentId, entity, result)
    }
    if (state === PointerEventType.PET_DOWN) {
      this.downTimestampByButton.set(button, result.timestamp)
    } else if (state === PointerEventType.PET_UP) {
      const downTs = this.downTimestampByButton.get(button)
      if (downTs !== undefined) {
        this.downTimestampByButton.delete(button)
        const dclPoint = threeToDclVec(hit.point)
        const dclNormal = threeToDclVec(hit.normal)
        this.pendingInjectPayload = {
          entity: targetEntity,
          entities: [...targets],
          hitEntity: hit.entity,
          button,
          tickNumber: this.tickNumber,
          downTimestamp: downTs,
          upTimestamp: result.timestamp,
          hitPosition: { x: dclPoint.x, y: dclPoint.y, z: dclPoint.z },
          hitNormal: { x: dclNormal.x, y: dclNormal.y, z: dclNormal.z },
          hitDistance: hit.distance,
          meshName: hit.meshName
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

  private syncPrimaryPointerInfo(_camera: THREE.Camera, hit: PointerHit | null): void {
    if (!this.deps) return
    const { ecs, view } = this.deps

    const worldDir = _ray.direction.clone()
    const dclDir = threeToDclVec(worldDir)

    const info = {
      pointerType: 1,
      screenCoordinates: { x: this.screenX, y: this.screenY },
      screenDelta: { x: this.screenDx, y: this.screenDy },
      worldRayDirection: { x: dclDir.x, y: dclDir.y, z: dclDir.z }
    }

    const key = `${info.screenCoordinates.x}|${info.screenCoordinates.y}|${info.screenDelta.x}|${info.screenDelta.y}|${hit?.entity ?? ''}`
    if (key === this.lastPrimaryInfoKey) return
    this.lastPrimaryInfoKey = key

    ecs.PrimaryPointerInfo.createOrReplace(view.RootEntity, info)
  }

  private isTypingTarget(): boolean {
    const el = document.activeElement
    if (!el || el === this.canvas) return false
    if (el instanceof HTMLElement && !isVisibleTypingElement(el)) return false
    if (el instanceof HTMLInputElement) {
      const type = el.type.toLowerCase()
      return type !== 'checkbox' && type !== 'radio' && type !== 'button' && type !== 'submit' && type !== 'reset'
    }
    if (el instanceof HTMLTextAreaElement) return true
    if (el instanceof HTMLElement && el.isContentEditable) return true
    return false
  }
}

function isVisibleTypingElement(el: HTMLElement): boolean {
  if (!el.isConnected) return false
  if (el.closest('[hidden]')) return false
  const style = window.getComputedStyle(el)
  return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0'
}

function mouseButtonToInputAction(button: number): InputActionValue {
  // DCL: IA_POINTER = left click, IA_SECONDARY = right click; IA_PRIMARY is E-key only.
  if (button === 0) return InputAction.IA_POINTER
  if (button === 2) return InputAction.IA_SECONDARY
  return InputAction.IA_POINTER
}

function mouseInteractLabel(button: InputActionValue): string {
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
  ecs: MirrorComponents,
  entity: Entity,
  cameraPos: THREE.Vector3,
  playerPos: THREE.Vector3 | null
): { cameraDistance: number; playerDistance: number } {
  const transform = ecs.Transform.getOrNull(entity)
  if (!transform) return { cameraDistance: Infinity, playerDistance: Infinity }

  _entityPos.copy(
    dclToThreeVec(
      new THREE.Vector3(transform.position.x, transform.position.y, transform.position.z),
      _entityPos
    )
  )
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
  interaction: number = InteractionType.CURSOR
): boolean {
  if (!spec) return false
  return spec.pointerEvents.some(
    (entry) =>
      entry.eventType === eventType &&
      buttonMatches(entry.eventInfo?.button, button) &&
      (entry.interactionType ?? InteractionType.CURSOR) === interaction
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
    if (info?.showHighlight === false) continue
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
    if ((entry.interactionType ?? InteractionType.CURSOR) !== InteractionType.CURSOR) continue
    if (!buttonMatches(entry.eventInfo?.button, button)) continue
    return entryPassesDistance(entry, hit.cameraDistance, hit.playerDistance)
  }
  return false
}

/** Camera maxDistance on the entry first; if that fails, player distance (maxPlayerDistance or same maxDistance). */
function entryPassesDistance(
  entry: Readonly<PBPointerEvents_Entry>,
  cameraDistance: number,
  playerDistance: number
): boolean {
  const maxDistance = entry.eventInfo?.maxDistance
  const maxPlayerDistance = entry.eventInfo?.maxPlayerDistance

  if (maxDistance !== undefined) {
    if (cameraDistance <= maxDistance) return true
    const playerLimit =
      maxPlayerDistance !== undefined && maxPlayerDistance > 0 ? maxPlayerDistance : maxDistance
    return playerDistance <= playerLimit
  }

  if (maxPlayerDistance !== undefined && maxPlayerDistance > 0) {
    return playerDistance <= maxPlayerDistance
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
  ecs: MirrorComponents,
  entity: Entity,
  cameraPos: THREE.Vector3,
  playerPos: THREE.Vector3 | null
): PointerHit {
  const spec = ecs.PointerEvents.getOrNull(entity)
  const transform = ecs.Transform.getOrNull(entity)
  const { cameraDistance, playerDistance } = measureEntityDistances(ecs, entity, cameraPos, playerPos)
  const point = transform
    ? dclToThreeVec(
        new THREE.Vector3(transform.position.x, transform.position.y, transform.position.z),
        new THREE.Vector3()
      )
    : cameraPos.clone()
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
