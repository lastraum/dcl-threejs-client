import type { Entity } from '@dcl/ecs'
import type { PBUiBackground } from '@dcl/ecs/dist/components/generated/pb/decentraland/sdk/components/ui_background.gen'
import type { PBUiDropdown } from '@dcl/ecs/dist/components/generated/pb/decentraland/sdk/components/ui_dropdown.gen'
import type { PBUiInput } from '@dcl/ecs/dist/components/generated/pb/decentraland/sdk/components/ui_input.gen'
import type { PBUiText } from '@dcl/ecs/dist/components/generated/pb/decentraland/sdk/components/ui_text.gen'
import type { PBUiTransform } from '@dcl/ecs/dist/components/generated/pb/decentraland/sdk/components/ui_transform.gen'
import type { ResolvedScene } from '../../dcl/content/types'
import { PointerFilterMode } from './yogaEnums'
import { isUiEntityVisible } from './uiVisibility'
import type { LayoutBox } from './yogaLayout'
import {
  layoutToScreen,
  type UiViewport,
  type VirtualCanvasSize,
  type ScreenUiRect
} from './virtualCanvas'
import {
  applyUiBackgroundStyles,
  hasUiBackgroundTexture,
  hasUiVisualBackground,
  resolveUiBackgroundImageUrl
} from './uiBackgroundStyle'
import { isUiPointerInteractive } from './uiPointer'
import type { MirrorComponents } from '../../bridge/mirrorComponents'
import type { UiScreenRegion } from './uiHitMap'
import { CANVAS_ROOT_ENTITY } from './uiTree'
import {
  applyUiDropdownStyles,
  applyUiInputStyles,
  applyUiTextStyles,
  borderCss,
  borderRadiusCss,
  flexContainerCss,
  sanitizeUiTextHtml,
  textAlignCss,
  uiScreenScaleFromViewport,
  type UiScreenScale
} from './uiDomStyles'
import { measureUiText } from './uiTextMeasure'
import {
  findFullscreenModalRoot,
  isModalBackdropBox,
  isUiDescendantOf,
  modalBackdropStackZ,
  pickTopmostModalBackdrop
} from './uiModalBackdrop'

export type SceneUiDrawInput = {
  boxes: LayoutBox[]
  transformOf: (e: Entity) => PBUiTransform | null
  textOf: (e: Entity) => PBUiText | null
  inputOf: (e: Entity) => PBUiInput | null
  dropdownOf: (e: Entity) => PBUiDropdown | null
  backgroundOf: (e: Entity) => PBUiBackground | null
  virtual: VirtualCanvasSize
  interactable: ScreenUiRect
  viewport: UiViewport
  scene: ResolvedScene | null
  ecs: MirrorComponents
  onRegions?: (regions: UiScreenRegion[]) => void
}

type ScreenBox = {
  entity: Entity
  left: number
  top: number
  width: number
  height: number
  depth: number
  zIndex: number
}

/** Nearest visible UiTransform ancestor that is also in the active (rendered) set. */
function uiParent(entity: Entity, transformOf: (e: Entity) => PBUiTransform | null, active: Set<Entity>): Entity | null {
  let parent = transformOf(entity)?.parent ?? CANVAS_ROOT_ENTITY
  while (parent !== CANVAS_ROOT_ENTITY && parent !== 0) {
    if (active.has(parent as Entity)) return parent as Entity
    const pt = transformOf(parent as Entity)
    parent = pt?.parent ?? CANVAS_ROOT_ENTITY
  }
  return null
}

function uiDepth(entity: Entity, transformOf: (e: Entity) => PBUiTransform | null, active: Set<Entity>): number {
  let depth = 0
  let current: Entity | null = entity
  while (current) {
    const parent = uiParent(current, transformOf, active)
    if (!parent) break
    depth++
    current = parent
  }
  return depth
}

function minTextBox(
  screen: Omit<ScreenBox, 'depth' | 'zIndex' | 'entity'>,
  text: PBUiText | null,
  scale: UiScreenScale
): { width: number; height: number } {
  if (!text?.value?.trim()) {
    return { width: screen.width, height: screen.height }
  }
  const measured = measureUiText(text, scale.uniform)
  return {
    width: Math.max(screen.width, measured.width),
    height: Math.max(screen.height, measured.height)
  }
}

function ensureBgLayer(el: HTMLElement): HTMLElement {
  let bg = el.querySelector('.scene-ui-node__bg') as HTMLElement | null
  if (!bg) {
    bg = document.createElement('div')
    bg.className = 'scene-ui-node__bg'
    el.prepend(bg)
  }
  return bg
}

/** Reparent only when needed; preserve focus if the active field lives inside the node. */
function adoptNode(parent: HTMLElement, node: HTMLElement): void {
  if (node.parentElement === parent) return
  const active = document.activeElement
  const focusInside = active instanceof HTMLElement && node.contains(active)
  parent.appendChild(node)
  if (focusInside && active instanceof HTMLElement && active.isConnected) {
    active.focus({ preventScroll: true })
  }
}

type SceneUiDomCallbacks = {
  onInputChange?: (entity: Entity, value: string) => void
  onInputSubmit?: (entity: Entity, value: string) => void
  onDropdownChange?: (entity: Entity, index: number) => void
  onFormFocus?: (entity: Entity) => void
  onFormBlur?: (entity: Entity) => void
  isEditingEntity?: (entity: Entity) => boolean
  /** Keep DOM nodes alive while focused/editing — never tear down mid-typing. */
  shouldPinEntity?: (entity: Entity, el: HTMLElement) => boolean
}

/** DOM pool renderer — nested by UiTransform.parent so text clips inside rounded panels. */
export class SceneUiDomRenderer {
  private readonly host: HTMLElement
  private readonly nodes = new Map<Entity, HTMLElement>()
  private readonly callbacks: SceneUiDomCallbacks
  private readonly boundInputs = new WeakSet<HTMLInputElement>()
  private readonly boundSelects = new WeakSet<HTMLSelectElement>()

  constructor(host: HTMLElement, callbacks: SceneUiDomCallbacks = {}) {
    this.host = host
    this.callbacks = callbacks
  }

  dispose(): void {
    this.host.replaceChildren()
    this.nodes.clear()
  }

  getFormField(entity: Entity): HTMLInputElement | HTMLSelectElement | null {
    const el = this.nodes.get(entity)
    if (!el) return null
    return (
      (el.querySelector('.scene-ui-node__input') as HTMLInputElement | null) ??
      (el.querySelector('.scene-ui-node__select') as HTMLSelectElement | null)
    )
  }

  render(input: SceneUiDrawInput): void {
    const seen = new Set<Entity>()
    const regions: UiScreenRegion[] = []
    const scale = uiScreenScaleFromViewport(input.viewport)

    const screenByEntity = new Map<Entity, ScreenBox>()
    const layoutByEntity = new Map<Entity, LayoutBox>()

    for (const box of input.boxes) {
      layoutByEntity.set(box.entity, box)
      const transform = input.transformOf(box.entity)
      if (!transform || !isUiEntityVisible(box.entity, input.transformOf)) continue

      const text = input.textOf(box.entity)
      const bg = input.backgroundOf(box.entity)
      const uiInput = input.inputOf(box.entity)
      const uiDropdown = input.dropdownOf(box.entity)
      const raw = layoutToScreen(
        input.interactable,
        input.viewport,
        box.left,
        box.top,
        box.width,
        box.height
      )
      const mins = minTextBox(raw, text, scale)
      const width = Math.max(0, mins.width)
      const height = Math.max(0, mins.height)
      if (
        width < 0.5 &&
        height < 0.5 &&
        !text?.value?.trim() &&
        !uiInput &&
        !uiDropdown &&
        !hasUiVisualBackground(bg)
      ) {
        continue
      }

      seen.add(box.entity)
      screenByEntity.set(box.entity, {
        entity: box.entity,
        left: raw.left,
        top: raw.top,
        width: Math.max(width, text?.value ? 1 : 0),
        height: Math.max(height, text?.value ? 1 : 0),
        depth: 0,
        zIndex: transform.zIndex ?? 0
      })
    }

    const backdropCandidates: Array<{ entity: Entity; zIndex: number }> = []
    for (const screen of screenByEntity.values()) {
      const layout = layoutByEntity.get(screen.entity)
      if (!layout) continue
      const bg = input.backgroundOf(screen.entity)
      if (isModalBackdropBox(layout, bg, input.virtual)) {
        backdropCandidates.push({
          entity: screen.entity,
          zIndex: modalBackdropStackZ(screen.entity, input.transformOf)
        })
      }
    }
    const topBackdrop = pickTopmostModalBackdrop(backdropCandidates)
    const modalRoot =
      topBackdrop && backdropCandidates.length > 0
        ? findFullscreenModalRoot(
            topBackdrop,
            (e) => layoutByEntity.get(e),
            input.transformOf,
            input.virtual
          )
        : null
    if (topBackdrop && backdropCandidates.length > 1) {
      for (const row of backdropCandidates) {
        if (row.entity === topBackdrop) continue
        seen.delete(row.entity)
        screenByEntity.delete(row.entity)
      }
    }

    // Only prune sibling modal trees when multiple scrims stack (view swap lag).
    if (modalRoot && backdropCandidates.length > 1) {
      for (const entity of [...seen]) {
        if (!isUiDescendantOf(entity, modalRoot, input.transformOf)) {
          seen.delete(entity)
          screenByEntity.delete(entity)
        }
      }
    }

    for (const screen of screenByEntity.values()) {
      screen.depth = uiDepth(screen.entity, input.transformOf, seen)
    }

    const renderOrder = [...screenByEntity.values()].sort((a, b) => {
      if (a.depth !== b.depth) return a.depth - b.depth
      if (a.zIndex !== b.zIndex) return a.zIndex - b.zIndex
      return (a.entity as number) - (b.entity as number)
    })

    for (const screen of renderOrder) {
      const transform = input.transformOf(screen.entity)!
      const bg = input.backgroundOf(screen.entity)
      const text = input.textOf(screen.entity)
      const uiInput = input.inputOf(screen.entity)
      const uiDropdown = input.dropdownOf(screen.entity)
      const flex = flexContainerCss(transform)
      const borders = borderCss(transform, scale)
      const radius = borderRadiusCss(transform, scale)
      const layoutBox = layoutByEntity.get(screen.entity)!

      const parentEntity = uiParent(screen.entity, input.transformOf, seen)
      const parentEl = parentEntity ? this.nodes.get(parentEntity) : this.host
      if (!parentEl) continue

      let el = this.nodes.get(screen.entity)
      if (!el) {
        el = document.createElement('div')
        el.className = 'scene-ui-node'
        el.dataset.entity = String(screen.entity)
        this.nodes.set(screen.entity, el)
      }
      adoptNode(parentEl, el)

      const parentLayout = parentEntity ? layoutByEntity.get(parentEntity) : null
      const relLeft = parentLayout
        ? (layoutBox.left - parentLayout.left) * input.viewport.scaleX
        : layoutBox.left * input.viewport.scaleX
      const relTop = parentLayout
        ? (layoutBox.top - parentLayout.top) * input.viewport.scaleY
        : layoutBox.top * input.viewport.scaleY

      el.style.position = 'absolute'
      el.style.left = `${relLeft}px`
      el.style.top = `${relTop}px`
      el.style.width = `${screen.width}px`
      el.style.height = `${screen.height}px`
      el.style.opacity = String(Math.min(1, Math.max(0, transform.opacity ?? 1)))
      el.style.zIndex = String(screen.zIndex)
      el.style.boxSizing = 'border-box'
      el.style.display = 'flex'
      el.style.flexDirection = flex.flexDirection
      el.style.backgroundImage = ''
      el.style.borderImage = ''

      // Padding is owned by Yoga — applying it again in CSS double-insets children.
      el.style.padding = '0'

      if (radius) {
        el.style.borderRadius = radius
        el.style.overflow = 'hidden'
      } else {
        el.style.borderRadius = ''
        el.style.overflow = flex.overflow
      }

      if (borders.width) {
        el.style.borderStyle = borders.style
        el.style.borderWidth = borders.width
        el.style.borderTopColor = borders.topColor
        el.style.borderRightColor = borders.rightColor
        el.style.borderBottomColor = borders.bottomColor
        el.style.borderLeftColor = borders.leftColor
      } else {
        el.style.border = 'none'
      }

      if (text?.value?.trim()) {
        const align = textAlignCss(text.textAlign)
        el.style.alignItems = align.alignItems
        el.style.justifyContent = align.justifyContent
      } else {
        el.style.alignItems = flex.alignItems
        el.style.justifyContent = flex.justifyContent
      }

      const inActiveModal =
        modalRoot !== null && isUiDescendantOf(screen.entity, modalRoot, input.transformOf)
      const interactive =
        transform.pointerFilter === PointerFilterMode.BLOCK ||
        isUiPointerInteractive(input.ecs, screen.entity) ||
        inActiveModal ||
        !!uiInput ||
        !!uiDropdown
      el.style.pointerEvents = interactive ? 'auto' : 'none'
      el.style.cursor = uiInput || uiDropdown ? 'text' : interactive ? 'pointer' : ''

      const imageUrl = resolveUiBackgroundImageUrl(bg, input.scene)
      const hasBg = hasUiVisualBackground(bg, imageUrl)
      const colorOnlyBg = hasBg && !imageUrl && !hasUiBackgroundTexture(bg)
      if (hasBg) {
        if (colorOnlyBg) {
          el.querySelector('.scene-ui-node__bg')?.remove()
          applyUiBackgroundStyles(el, bg, null, scale)
        } else {
          el.style.backgroundColor = 'transparent'
          const bgEl = ensureBgLayer(el)
          bgEl.style.position = 'absolute'
          bgEl.style.inset = '0'
          bgEl.style.width = '100%'
          bgEl.style.height = '100%'
          bgEl.style.pointerEvents = 'none'
          bgEl.style.zIndex = '0'
          if (radius) bgEl.style.borderRadius = radius
          else bgEl.style.borderRadius = ''
          applyUiBackgroundStyles(bgEl, bg, imageUrl, scale)
        }
      } else {
        el.style.backgroundColor = 'transparent'
        el.querySelector('.scene-ui-node__bg')?.remove()
      }

      regions.push({
        entity: screen.entity,
        left: screen.left,
        top: screen.top,
        width: screen.width,
        height: screen.height,
        zIndex: screen.zIndex,
        depth: screen.depth
      })

      if (uiInput) {
        this.syncUiInput(el, screen.entity, uiInput, scale, hasBg)
      } else if (uiDropdown) {
        this.syncUiDropdown(el, screen.entity, uiDropdown, scale)
      } else if (text?.value?.trim()) {
        const span = el.querySelector('.scene-ui-node__text') as HTMLElement | null
        const label = span ?? document.createElement('div')
        label.className = 'scene-ui-node__text'
        label.innerHTML = sanitizeUiTextHtml(text.value)
        applyUiTextStyles(label, text, scale)
        if (!span) el.appendChild(label)
        el.querySelector('.scene-ui-node__input')?.remove()
        el.querySelector('.scene-ui-node__select')?.remove()
      } else {
        el.querySelector('.scene-ui-node__text')?.remove()
        el.querySelector('.scene-ui-node__input')?.remove()
        el.querySelector('.scene-ui-node__select')?.remove()
      }
    }

    for (const [entity, el] of this.nodes) {
      if (!seen.has(entity)) {
        if (this.callbacks.shouldPinEntity?.(entity, el)) continue
        el.remove()
        this.nodes.delete(entity)
      }
    }

    this.purgeOrphanHostChildren()

    input.onRegions?.(regions)
  }

  /**
   * Incremental UiInput sync — reuse the existing <input>, never clobber value while editing.
   */
  private syncUiInput(
    host: HTMLElement,
    entity: Entity,
    uiInput: PBUiInput,
    scale: UiScreenScale,
    hasBg: boolean
  ): void {
    host.querySelector('.scene-ui-node__text')?.remove()
    host.querySelector('.scene-ui-node__select')?.remove()

    let field = host.querySelector('.scene-ui-node__input') as HTMLInputElement | null
    if (!field) {
      field = document.createElement('input')
      field.className = 'scene-ui-node__input'
      field.type = 'text'
      host.appendChild(field)
    }
    this.bindInputEvents(field, host, entity)
    const editing =
      (this.callbacks.isEditingEntity?.(entity) ?? false) || document.activeElement === field
    applyUiInputStyles(field, uiInput, scale, !editing, hasBg)
  }

  /**
   * Incremental UiDropdown sync — reuse <select>, skip selected-index overwrite while editing.
   */
  private syncUiDropdown(
    host: HTMLElement,
    entity: Entity,
    uiDropdown: PBUiDropdown,
    scale: UiScreenScale
  ): void {
    host.querySelector('.scene-ui-node__text')?.remove()
    host.querySelector('.scene-ui-node__input')?.remove()

    let select = host.querySelector('.scene-ui-node__select') as HTMLSelectElement | null
    if (!select) {
      select = document.createElement('select')
      select.className = 'scene-ui-node__select'
      host.appendChild(select)
    }
    this.bindSelectEvents(select, entity)
    const editing =
      (this.callbacks.isEditingEntity?.(entity) ?? false) || document.activeElement === select
    this.syncDropdownOptions(select, uiDropdown, !editing)
    applyUiDropdownStyles(select, uiDropdown, scale)
  }

  private bindInputEvents(field: HTMLInputElement, _host: HTMLElement, entity: Entity): void {
    if (this.boundInputs.has(field)) return
    this.boundInputs.add(field)
    field.addEventListener('pointerdown', (e) => e.stopPropagation())
    field.addEventListener('input', () => {
      this.callbacks.onInputChange?.(entity, field.value)
    })
    field.addEventListener('change', () => {
      this.callbacks.onInputChange?.(entity, field.value)
    })
    field.addEventListener('keydown', (e) => {
      e.stopPropagation()
      if (e.key === 'Enter') {
        this.callbacks.onInputSubmit?.(entity, field.value)
      }
    })
    field.addEventListener('focus', () => this.callbacks.onFormFocus?.(entity))
    field.addEventListener('blur', () => this.callbacks.onFormBlur?.(entity))
  }

  private bindSelectEvents(select: HTMLSelectElement, entity: Entity): void {
    if (this.boundSelects.has(select)) return
    this.boundSelects.add(select)
    select.addEventListener('change', () => {
      const raw = select.value
      const index = raw === '' ? -1 : Number(raw)
      if (!Number.isFinite(index)) return
      this.callbacks.onDropdownChange?.(entity, index)
    })
    select.addEventListener('focus', () => this.callbacks.onFormFocus?.(entity))
    select.addEventListener('blur', () => this.callbacks.onFormBlur?.(entity))
  }

  private syncDropdownOptions(
    select: HTMLSelectElement,
    dropdown: PBUiDropdown,
    syncSelected = true
  ): void {
    const selected = dropdown.selectedIndex
    const options = dropdown.options ?? []
    const needsRebuild =
      select.options.length !== options.length + (dropdown.acceptEmpty ? 1 : 0) ||
      [...select.options].some((opt, i) => {
        if (dropdown.acceptEmpty && i === 0) {
          return opt.value !== '' || opt.textContent !== (dropdown.emptyLabel ?? '')
        }
        const idx = dropdown.acceptEmpty ? i - 1 : i
        return opt.value !== String(idx) || opt.textContent !== options[idx]
      })
    if (!needsRebuild) {
      if (syncSelected) {
        select.value = selected === undefined || selected === null ? '' : String(selected)
      }
      return
    }
    const localValue = syncSelected ? null : select.value
    select.replaceChildren()
    if (dropdown.acceptEmpty) {
      const empty = document.createElement('option')
      empty.value = ''
      empty.textContent = dropdown.emptyLabel ?? ''
      select.appendChild(empty)
    }
    for (let i = 0; i < options.length; i++) {
      const opt = document.createElement('option')
      opt.value = String(i)
      opt.textContent = options[i] ?? ''
      select.appendChild(opt)
    }
    if (syncSelected) {
      select.value = selected === undefined || selected === null ? '' : String(selected)
    } else if (localValue !== null) {
      select.value = localValue
    }
  }

  /** Drop detached top-level nodes (entity recycle / conditional unmount safety). */
  private purgeOrphanHostChildren(): void {
    for (const child of [...this.host.children]) {
      const id = child instanceof HTMLElement ? Number(child.dataset.entity) : NaN
      if (!Number.isFinite(id) || !this.nodes.has(id as Entity)) {
        child.remove()
      }
    }
  }
}

export function ensureSceneUiRoot(): HTMLElement {
  let root = document.getElementById('scene-ui-root')
  if (!root) {
    root = document.createElement('div')
    root.id = 'scene-ui-root'
    document.body.appendChild(root)
  }
  return root
}