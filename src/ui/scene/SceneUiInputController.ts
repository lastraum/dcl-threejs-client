import type { Entity } from '@dcl/ecs'
import type { MirrorComponents } from '../../bridge/mirrorComponents'
import { clientDebugLog } from '../../client/debug/ClientDebugLog'
import { entityFromSceneUiDomTarget, pickSceneUiEntityFromDom } from './uiDomPick'
import { isSceneUiFieldDom, isSceneUiTypingFocus } from './sceneUiTyping'

export type SceneUiInputControllerDeps = {
  getEcs: () => MirrorComponents | null
  getFieldDom: (entity: Entity) => HTMLInputElement | HTMLSelectElement | null
  isAuthoritativeUiEntity?: (entity: Entity) => boolean
}

/**
 * Sole owner of UiInput / UiDropdown interaction on the main thread.
 * PointerEventsSystem delegates here; never inspects field DOM itself.
 */
export class SceneUiInputController {
  private focusedEntity: Entity | null = null
  /** Entities with an active edit session — survives until real blur. */
  private readonly editingEntities = new Set<Entity>()

  constructor(private readonly deps: SceneUiInputControllerDeps) {}

  bind(): void {
    /* pointer routing via PointerEventsSystem → consumePointerDown */
  }

  dispose(): void {
    this.focusedEntity = null
    this.editingEntities.clear()
  }

  onDomInput(_entity: Entity, _value: string): void {
    /* writeback handled in SceneUiBridge */
  }

  isEditingEntity(entity: Entity): boolean {
    return this.editingEntities.has(entity)
  }

  /** True when the player is typing in scene UI — blocks game pointer/keyboard routing. */
  isTypingActive(): boolean {
    if (isSceneUiTypingFocus()) return true
    return this.focusedEntity !== null && this.editingEntities.has(this.focusedEntity)
  }

  /**
   * Never keep DOM after ECS unmount — react-ecs recycles entity ids on re-open; pinned nodes
   * stole clicks (PET_DOWN to dead entities) until the user hammered the real control.
   */
  shouldPinEntity(_entity: Entity, _el: HTMLElement, _alive: Set<Entity>): boolean {
    return false
  }

  /** Entity left the ECS UI tree — drop edit session and blur so DOM can be removed. */
  releaseEntity(entity: Entity): void {
    const field = this.deps.getFieldDom(entity)
    if (field && document.activeElement === field) {
      field.blur()
    }
    this.endEditing(entity)
  }

  /** Drop edit sessions for entities recycled or unmounted by react-ecs. */
  pruneStaleEntities(alive: Set<Entity>): void {
    for (const entity of [...this.editingEntities]) {
      if (!alive.has(entity)) this.releaseEntity(entity)
    }
  }

  /** Blur scene UI fields when their panel unmounted — avoids invisible focus traps. */
  releaseAllIfNothingMounted(alive: Set<Entity>): void {
    if (isSceneUiTypingFocus()) {
      const activeEntity = entityFromSceneUiDomTarget(document.activeElement)
      if (activeEntity !== null && !alive.has(activeEntity)) {
        const el = document.activeElement
        if (el instanceof HTMLElement) el.blur()
      }
    }
    for (const entity of [...this.editingEntities]) {
      if (!alive.has(entity)) this.releaseEntity(entity)
    }
  }

  /**
   * Single gate: DOM field click or DOM pick at coords.
   * Returns true when the pointer must not become an ECS PointerEvents PET_DOWN.
   */
  consumePointerDown(clientX: number, clientY: number, target: EventTarget | null): boolean {
    const accept = (entity: Entity) => this.deps.isAuthoritativeUiEntity?.(entity) ?? true
    if (target instanceof Element && isSceneUiFieldDom(target)) {
      const entity = entityFromSceneUiDomTarget(target, accept)
      if (entity !== null && this.isFieldEntity(entity)) {
        const field =
          target instanceof HTMLInputElement || target instanceof HTMLSelectElement ? target : undefined
        this.focusEntity(entity, field)
        clientDebugLog.log('scene-ui', `field focus → entity ${entity} (DOM)`, { alsoConsole: true })
        return true
      }
      return true
    }

    const entity =
      entityFromSceneUiDomTarget(target, accept) ?? this.pickFieldEntityFromDom(clientX, clientY, accept)
    if (entity === null || !this.isFieldEntity(entity)) return false

    this.focusEntity(entity)
    clientDebugLog.log('scene-ui', `field focus → entity ${entity} (DOM)`, { alsoConsole: true })
    return true
  }

  isFieldEntity(entity: Entity): boolean {
    if (this.deps.getFieldDom(entity) !== null) return true
    const ecs = this.deps.getEcs()
    if (!ecs) return false
    return ecs.UiInput.has(entity) || ecs.UiDropdown.has(entity)
  }

  isFocused(entity: Entity): boolean {
    return this.focusedEntity === entity
  }

  onFieldFocus(entity: Entity): void {
    this.beginEditing(entity)
  }

  onFieldBlur(entity: Entity): void {
    // Defer — sync/reparent can fire spurious blur between pointerdown and focus.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const field = this.deps.getFieldDom(entity)
        if (field && document.activeElement === field) return
        if (isSceneUiTypingFocus()) {
          const activeEntity = entityFromSceneUiDomTarget(document.activeElement)
          if (activeEntity === entity) return
        }
        this.endEditing(entity)
      })
    })
  }

  private beginEditing(entity: Entity): void {
    if (this.focusedEntity !== null && this.focusedEntity !== entity) {
      this.endEditing(this.focusedEntity)
    }
    this.focusedEntity = entity
    this.editingEntities.add(entity)
  }

  private endEditing(entity: Entity): void {
    this.editingEntities.delete(entity)
    if (this.focusedEntity === entity) this.focusedEntity = null
  }

  private pickFieldEntityFromDom(
    clientX: number,
    clientY: number,
    accept?: (entity: Entity) => boolean
  ): Entity | null {
    const entity = pickSceneUiEntityFromDom(clientX, clientY, accept)
    return entity !== null && this.isFieldEntity(entity) ? entity : null
  }

  private focusEntity(
    entity: Entity,
    fieldEl?: HTMLInputElement | HTMLSelectElement
  ): void {
    this.beginEditing(entity)
    const field = fieldEl ?? this.deps.getFieldDom(entity)
    if (!field || field.disabled) return
    field.focus({ preventScroll: true })
    if (field instanceof HTMLInputElement) {
      const len = field.value.length
      field.setSelectionRange(len, len)
    }
  }
}