import type { Entity } from '@dcl/ecs'
import { isSceneUiFieldDom } from './sceneUiTyping'

/** Primary parcel scene UI overlay. */
export const SCENE_UI_ROOT = '#scene-ui-root'
/** Portable experience / smart wearable UI — separate host so PE clicks work. */
export const PE_UI_ROOT = '#pe-ui-root'
/** Any scene ECS UI overlay (primary or PE). */
export const SCENE_UI_ROOT_SELECTOR = `${SCENE_UI_ROOT}, ${PE_UI_ROOT}`

/** Worker mount set — stale pooled DOM must not block clicks or raycasts. */
let authoritativeEntity: ((entity: Entity) => boolean) | null = null
/** PE bridge entities — checked when primary accept fails (multi-root). */
let peAuthoritativeEntity: ((entity: Entity) => boolean) | null = null

export function setSceneUiAuthoritativeEntityCheck(
  fn: ((entity: Entity) => boolean) | null
): void {
  authoritativeEntity = fn
}

/** PE SceneUiBridge registers here so primary doesn't reject PE entity ids. */
export function setPeUiAuthoritativeEntityCheck(
  fn: ((entity: Entity) => boolean) | null
): void {
  peAuthoritativeEntity = fn
}

function resolveAcceptEntity(
  acceptEntity?: (entity: Entity) => boolean
): ((entity: Entity) => boolean) | undefined {
  if (acceptEntity) return acceptEntity
  if (!authoritativeEntity && !peAuthoritativeEntity) return undefined
  return (entity) => {
    if (authoritativeEntity?.(entity)) return true
    if (peAuthoritativeEntity?.(entity)) return true
    // If only one registry is set, require it; if both set, either may accept.
    if (authoritativeEntity && peAuthoritativeEntity) return false
    return false
  }
}

function isUnderAnySceneUiRoot(el: Element): boolean {
  return !!el.closest(SCENE_UI_ROOT_SELECTOR)
}

function anySceneUiRootPresent(): boolean {
  return !!(document.querySelector(SCENE_UI_ROOT) || document.querySelector(PE_UI_ROOT))
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

/** Event target is inside the scene ECS UI overlay (primary or PE). */
export function isSceneUiDomTarget(target: EventTarget | null): boolean {
  return target instanceof Element && isUnderAnySceneUiRoot(target)
}

/** Target is a clickable scene UI control (button, input, dropdown). */
export function isSceneUiInteractiveTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false
  if (!isUnderAnySceneUiRoot(target)) return false
  return isInteractiveSceneUiElement(target)
}

/** Nearest interactive `.scene-ui-node[data-entity]` for a DOM event target. */
export function entityFromSceneUiDomTarget(
  target: EventTarget | null,
  acceptEntity?: (entity: Entity) => boolean
): Entity | null {
  if (!(target instanceof Element)) return null
  if (!isUnderAnySceneUiRoot(target)) return null
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
  if (!anySceneUiRootPresent()) return []
  const accept = resolveAcceptEntity(acceptEntity)
  const seen = new Set<number>()
  const entities: Entity[] = []

  for (const el of document.elementsFromPoint(clientX, clientY)) {
    if (!(el instanceof Element)) continue
    if (!isUnderAnySceneUiRoot(el)) continue
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

/**
 * Host id of the topmost interactive ECS UI under the point (`scene-ui-root` | `pe-ui-root`).
 * Primary and portable-experience (PX) each own a root; hit-maps must not pierce the other.
 */
export function topmostInteractiveUiRootId(clientX: number, clientY: number): string | null {
  if (typeof document.elementsFromPoint !== 'function') return null
  if (!anySceneUiRootPresent()) return null
  for (const el of document.elementsFromPoint(clientX, clientY)) {
    if (!(el instanceof Element)) continue
    // Any hittable node under a root (not only --interactive) — PX dialog chrome counts.
    if (el.closest(PE_UI_ROOT)) return 'pe-ui-root'
    if (el.closest(SCENE_UI_ROOT)) return 'scene-ui-root'
    if (el instanceof HTMLCanvasElement) return null
  }
  return null
}

/** Host id for an event target under scene/PX UI, or null. */
export function uiRootIdFromEventTarget(target: EventTarget | null): string | null {
  if (!(target instanceof Element)) return null
  const root = target.closest(SCENE_UI_ROOT_SELECTOR)
  return root instanceof HTMLElement && root.id ? root.id : null
}

/**
 * True when a different ECS UI root owns the top layer at this point.
 * Any click whose target is under `#pe-ui-root` blocks primary (and reverse) — not only
 * nodes with `.scene-ui-node--interactive` (labels/scrim chrome were slipping through).
 */
export function isForeignUiRootOnTop(
  ownRootId: string,
  clientX: number,
  clientY: number,
  eventTarget?: EventTarget | null
): boolean {
  // ANY target under a root owns the click — do not require interactive class.
  const fromTarget = uiRootIdFromEventTarget(eventTarget ?? null)
  if (fromTarget) return fromTarget !== ownRootId
  const top = topmostInteractiveUiRootId(clientX, clientY)
  if (!top) return false
  return top !== ownRootId
}