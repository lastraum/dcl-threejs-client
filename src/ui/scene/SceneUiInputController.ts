import type { Entity } from '@dcl/ecs'
import type { MirrorComponents } from '../../bridge/mirrorComponents'
import { clientDebugLog } from '../../client/debug/ClientDebugLog'
import type { SceneUiHitMap } from './uiHitMap'
import { isSceneUiFormField, isSceneUiTypingFocus } from './sceneUiTyping'

export type SceneUiInputControllerDeps = {
  hitMap: SceneUiHitMap
  getEcs: () => MirrorComponents | null
  getFormField: (entity: Entity) => HTMLInputElement | HTMLSelectElement | null
}

/**
 * Sole owner of scene ECS form interaction (UiInput / UiDropdown).
 * PointerEventsSystem delegates here; never inspects DOM for forms itself.
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

  shouldPinEntity(entity: Entity, el: HTMLElement): boolean {
    if (!this.editingEntities.has(entity)) return false
    const field = this.deps.getFormField(entity)
    if (field && document.activeElement === field) return true
    return el.contains(document.activeElement)
  }

  /**
   * Single gate: DOM field click or hit-map pick (canvas path).
   * Returns true when the pointer must not become an ECS PointerEvents PET_DOWN.
   */
  consumePointerDown(clientX: number, clientY: number, target: EventTarget | null): boolean {
    if (target instanceof Element && isSceneUiFormField(target)) {
      const entity = this.entityFromDomTarget(target)
      if (entity !== null && this.isFormEntity(entity)) {
        const field =
          target instanceof HTMLInputElement || target instanceof HTMLSelectElement ? target : undefined
        this.focusEntity(entity, field)
        clientDebugLog.log('scene-ui', `form focus → entity ${entity} (DOM)`, { alsoConsole: true })
        return true
      }
      return true
    }

    const entity = this.pickFormEntityFromHitMap(clientX, clientY)
    if (entity === null) return false

    this.focusEntity(entity)
    clientDebugLog.log('scene-ui', `form focus → entity ${entity} (hit map)`, { alsoConsole: true })
    return true
  }

  isFormEntity(entity: Entity): boolean {
    if (this.deps.getFormField(entity) !== null) return true
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
        const field = this.deps.getFormField(entity)
        if (field && document.activeElement === field) return
        if (isSceneUiTypingFocus()) {
          const activeEntity = this.entityFromDomTarget(document.activeElement)
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

  private pickFormEntityFromHitMap(clientX: number, clientY: number): Entity | null {
    for (const entity of this.deps.hitMap.hitTestCandidates(clientX, clientY)) {
      if (this.isFormEntity(entity)) return entity
    }
    return null
  }

  private entityFromDomTarget(target: EventTarget | null): Entity | null {
    if (!(target instanceof Element)) return null
    const host = target.closest('.scene-ui-node[data-entity]')
    if (!host) return null
    const id = Number(host.getAttribute('data-entity'))
    return Number.isFinite(id) ? (id as Entity) : null
  }

  private focusEntity(
    entity: Entity,
    fieldEl?: HTMLInputElement | HTMLSelectElement
  ): void {
    this.beginEditing(entity)
    const field = fieldEl ?? this.deps.getFormField(entity)
    if (!field || field.disabled) return
    field.focus({ preventScroll: true })
    if (field instanceof HTMLInputElement) {
      const len = field.value.length
      field.setSelectionRange(len, len)
    }
  }
}