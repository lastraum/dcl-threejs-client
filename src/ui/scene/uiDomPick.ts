import type { Entity } from '@dcl/ecs'
import { isSceneUiFieldDom } from './sceneUiTyping'

/** Scene ECS UI overlay host — sole authority for screen-space hit testing. */
export const SCENE_UI_ROOT = '#scene-ui-root'

/** Worker mount set — stale pooled DOM must not block clicks or raycasts. */
let authoritativeEntity: ((entity: Entity) => boolean) | null = null

export function setSceneUiAuthoritativeEntityCheck(
  fn: ((entity: Entity) => boolean) | null
): void {
  authoritativeEntity = fn
}

function resolveAcceptEntity(
  acceptEntity?: (entity: Entity) => boolean
): ((entity: Entity) => boolean) | undefined {
  if (acceptEntity) return acceptEntity
  return authoritativeEntity ?? undefined
}

function sceneUiRoot(): Element | null {
  return document.querySelector(SCENE_UI_ROOT)
}

function entityFromSceneUiNode(node: HTMLElement): Entity | null {
  const id = Number(node.getAttribute('data-entity'))
  return Number.isFinite(id) && id > 0 ? (id as Entity) : null
}

function sceneUiNodeFromElement(el: Element): HTMLElement | null {
  const node = el.closest('.scene-ui-node[data-entity]')
  return node instanceof HTMLElement ? node : null
}

/** True when this node can receive hits — mirrors ECS visibility (display:none / unmounted). */
export function sceneUiNodeHitVisible(node: HTMLElement): boolean {
  if (!node.isConnected) return false
  const style = window.getComputedStyle(node)
  if (style.display === 'none' || style.visibility === 'hidden') return false
  if (parseFloat(style.opacity) < 0.01) return false
  if (style.pointerEvents === 'none') return false
  const rect = node.getBoundingClientRect()
  return rect.width > 0.5 && rect.height > 0.5
}

function nodePointerEventsAuto(node: HTMLElement): boolean {
  return sceneUiNodeHitVisible(node)
}

/** True when `el` is a pickable scene UI control — BLOCK, onPointerDown/Up, or field. */
export function isInteractiveSceneUiElement(el: Element): boolean {
  if (isSceneUiFieldDom(el)) return true
  const node = sceneUiNodeFromElement(el)
  return (
    node !== null &&
    node.classList.contains('scene-ui-node--interactive') &&
    sceneUiNodeHitVisible(node)
  )
}

/** Event target is inside the scene ECS UI overlay. */
export function isSceneUiDomTarget(target: EventTarget | null): boolean {
  return target instanceof Element && !!target.closest(SCENE_UI_ROOT)
}

/** Target is a clickable scene UI control (button, input, dropdown). */
export function isSceneUiInteractiveTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false
  if (!target.closest(SCENE_UI_ROOT)) return false
  return isInteractiveSceneUiElement(target)
}

/** Nearest interactive `.scene-ui-node[data-entity]` for a DOM event target. */
export function entityFromSceneUiDomTarget(
  target: EventTarget | null,
  acceptEntity?: (entity: Entity) => boolean
): Entity | null {
  if (!(target instanceof Element)) return null
  const root = sceneUiRoot()
  if (!root?.contains(target)) return null
  const node = sceneUiNodeFromElement(target)
  if (!node || !nodePointerEventsAuto(node)) return null
  const entity = entityFromSceneUiNode(node)
  if (entity === null) return null
  const accept = resolveAcceptEntity(acceptEntity)
  if (accept && !accept(entity)) return null
  return entity
}

/** All interactive scene UI entities under (clientX, clientY), topmost DOM order first. */
export function collectSceneUiEntitiesFromDom(
  clientX: number,
  clientY: number,
  acceptEntity?: (entity: Entity) => boolean
): Entity[] {
  if (typeof document.elementsFromPoint !== 'function') return []
  const root = sceneUiRoot()
  if (!root) return []
  const accept = resolveAcceptEntity(acceptEntity)
  const seen = new Set<number>()
  const entities: Entity[] = []

  for (const el of document.elementsFromPoint(clientX, clientY)) {
    if (!(el instanceof Element)) continue
    if (!root.contains(el)) continue
    if (!isInteractiveSceneUiElement(el)) continue
    const node = sceneUiNodeFromElement(el)
    if (!node) continue
    const entity = entityFromSceneUiNode(node)
    if (entity === null) continue
    if (accept && !accept(entity)) continue
    const id = entity as number
    if (seen.has(id)) continue
    seen.add(id)
    entities.push(entity)
  }
  return entities
}

/**
 * Topmost interactive scene UI entity at screen coords.
 * Authoritative input path — matches rendered DOM (scroll-aware).
 */
export function pickSceneUiEntityFromDom(
  clientX: number,
  clientY: number,
  acceptEntity?: (entity: Entity) => boolean
): Entity | null {
  return collectSceneUiEntitiesFromDom(clientX, clientY, acceptEntity)[0] ?? null
}

/** Topmost interactive scene UI at screen coords — blocks 3D raycast when over overlay. */
export function isPointerOverSceneUi(clientX: number, clientY: number): boolean {
  return pickSceneUiEntityFromDom(clientX, clientY) !== null
}