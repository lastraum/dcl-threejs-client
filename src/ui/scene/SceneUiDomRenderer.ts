import type { Entity } from '@dcl/ecs'
import type { PBUiBackground } from '@dcl/ecs/dist/components/generated/pb/decentraland/sdk/components/ui_background.gen'
import type { PBUiDropdown } from '@dcl/ecs/dist/components/generated/pb/decentraland/sdk/components/ui_dropdown.gen'
import type { PBUiInput } from '@dcl/ecs/dist/components/generated/pb/decentraland/sdk/components/ui_input.gen'
import type { PBUiText } from '@dcl/ecs/dist/components/generated/pb/decentraland/sdk/components/ui_text.gen'
import type { PBUiTransform } from '@dcl/ecs/dist/components/generated/pb/decentraland/sdk/components/ui_transform.gen'
import type { ResolvedScene } from '../../dcl/content/types'
import { YGOverflow } from './yogaEnums'
import { isUiEntityVisible } from './uiVisibility'
import type { UiViewport, VirtualCanvasSize, ScreenUiRect } from './virtualCanvas'
import { layoutToScreen } from './virtualCanvas'
import {
  applyUiBackgroundStyles,
  BackgroundTextureMode,
  extractUiTextureSrc,
  hasUiBackgroundTexture,
  hasUiVisualBackground,
  normalizeBackgroundTextureMode,
  parseUiBackgroundUvRect,
  resolveUiBackgroundImageUrl
} from './uiBackgroundStyle'
import {
  isFullscreenUiPeAllowed,
  isUiEntityPointerCapturing,
  type UiPointerEventsLookup
} from './uiPointer'
import type { MirrorComponents } from '../../bridge/mirrorComponents'
import type { UiScreenRegion } from './uiHitMap'
import { CANVAS_ROOT_ENTITY } from './uiTree'
import type { LayoutBox } from './yogaLayout'
import {
  applyUiDropdownStyles,
  applyUiInputStyles,
  applyUiTextStyles,
  applyUiTransformContentStyles,
  applyYogaLayoutBox,
  borderCss,
  borderRadiusCss,
  flexContainerCss,
  sanitizeUiTextHtml,
  textAlignCss,
  uiScreenScaleFromViewport,
  type UiScreenScale
} from './uiDomStyles'

/** Missing-box (`none`) — real layout bug; warn once per entity. */
const yogaMissingBoxWarned = new Set<number>()
/** Sticky 0×0 across many paints — progressive flex fill is normal; only warn when stuck. */
const yogaZeroBoxStreak = new Map<number, number>()
const yogaZeroBoxWarned = new Set<number>()
/** Frames of continuous 0×0 before treating as sticky (COD: quiet progressive inventory fill). */
const YOGA_ZERO_STICKY_FRAMES = 12

export type SceneUiDrawInput = {
  forest: Map<Entity, Entity[]>
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
  /** Worker mount snapshot PointerEvents — projection can lag one frame behind paint. */
  pointerEventsOf?: UiPointerEventsLookup
  /** DOM screen rects for `?sceneuidebug` — same source as pointer hits. */
  onRegions?: (regions: UiScreenRegion[]) => void
  /**
   * Worker-authoritative mounted UiTransform ids (canvas-reachable).
   * Mirrors Explorer UITransformReleaseSystem — pool entries not listed here are released.
   */
  mountedEntities: ReadonlySet<Entity>
  /** Full worker UiTransform mount set — superset of mountedEntities for pool purge. */
  authoritativeEntities: ReadonlySet<Entity>
  /** Yoga layout boxes — sole geometry authority for paint + hit-map (canvas-absolute). */
  layoutBoxes: ReadonlyMap<Entity, LayoutBox>
}

/** Yoga canvas-absolute box → client-space hit region (same mapping as DOM paint). */
function pushLayoutHitRegion(
  regions: UiScreenRegion[],
  entity: Entity,
  transform: PBUiTransform,
  layoutBox: LayoutBox,
  input: Pick<SceneUiDrawInput, 'interactable' | 'viewport' | 'virtual'>,
  depth: number
): void {
  if (layoutBox.width <= 0.5 || layoutBox.height <= 0.5) return
  // Pointer only (not paint). overflow:hidden clips off-canvas nodes; a fully
  // outside box cannot receive clicks. Display/opacity still decide visibility.
  const vw = input.virtual?.width ?? input.interactable.width
  const vh = input.virtual?.height ?? input.interactable.height
  if (
    layoutBox.left >= vw - 1 ||
    layoutBox.top >= vh - 1 ||
    layoutBox.left + layoutBox.width <= 1 ||
    layoutBox.top + layoutBox.height <= 1
  ) {
    return
  }
  const screen = layoutToScreen(
    input.interactable,
    input.viewport,
    layoutBox.left,
    layoutBox.top,
    layoutBox.width,
    layoutBox.height
  )
  if (screen.width <= 0.5 || screen.height <= 0.5) return
  regions.push({
    entity,
    left: screen.left,
    top: screen.top,
    width: screen.width,
    height: screen.height,
    zIndex: transform.zIndex ?? 0,
    depth
  })
}

function isSceneUiNodeInteractive(
  entity: Entity,
  ecs: MirrorComponents,
  transform: PBUiTransform,
  _inputOf: (e: Entity) => PBUiInput | null,
  _dropdownOf: (e: Entity) => PBUiDropdown | null,
  pointerEventsOf?: UiPointerEventsLookup,
  background?: PBUiBackground | null,
  layoutBox?: LayoutBox | null,
  forest?: Map<Entity, Entity[]> | null
): boolean {
  // Explorer parity: PE / BLOCK / fields while UiTransform chain is visible.
  if (!isUiEntityPointerCapturing(ecs, entity, pointerEventsOf, background ?? null)) {
    return false
  }
  // Near-fullscreen transparent PE shells must not get pointer-events:auto — they
  // steal inventory GLB / world mesh PE. Visible scrim / BLOCK / text / child paint still capture.
  if (layoutBox && layoutBox.width * layoutBox.height >= 1920 * 1080 * 0.45) {
    return isFullscreenUiPeAllowed(ecs, entity, { forest: forest ?? null })
  }
  void transform
  return true
}

function applySceneUiNodePointerState(
  el: HTMLElement,
  interactive: boolean,
  hasField: boolean
): void {
  if (interactive) {
    el.classList.add('scene-ui-node--interactive')
    el.style.pointerEvents = 'auto'
    el.style.cursor = hasField ? 'text' : 'pointer'
  } else {
    el.classList.remove('scene-ui-node--interactive')
    el.style.pointerEvents = 'none'
    el.style.cursor = ''
  }
}

function ensureContentRoot(shell: HTMLElement): HTMLElement {
  let content = shell.querySelector(':scope > .scene-ui-node__content') as HTMLElement | null
  if (!content) {
    content = document.createElement('div')
    content.className = 'scene-ui-node__content'
    shell.appendChild(content)
  }
  // Fill the yoga shell so UiText height:100% / flex center resolve against a real box.
  // Without this, Label entities without explicit height (CREATOR MODE, titles, ✕) collapse:
  // content height:auto + child height:100% → 0px painted text while borders/bg still show.
  content.style.position = 'absolute'
  content.style.left = '0'
  content.style.top = '0'
  content.style.right = '0'
  content.style.bottom = '0'
  content.style.width = '100%'
  content.style.height = '100%'
  content.style.boxSizing = 'border-box'
  content.style.margin = '0'
  // Shell owns interactivity; child entity shells are siblings and stack above content.
  content.style.pointerEvents = 'none'
  content.style.zIndex = '0'
  return content
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
  onFieldFocus?: (entity: Entity) => void
  onFieldBlur?: (entity: Entity) => void
  isEditingEntity?: (entity: Entity) => boolean
  /**
   * Keep DOM nodes alive while focused/editing — only while the entity is still mounted in ECS.
   * `alive` = mounted entity set (includes display:none); unmounted entities must not pin.
   */
  shouldPinEntity?: (entity: Entity, el: HTMLElement, alive: Set<Entity>) => boolean
  /** Entity removed from ECS — clear edit state before DOM teardown. */
  onEntityReleased?: (entity: Entity) => void
}

/** DOM pool renderer — nested by ECS parent for z-index; yoga boxes mapped to screen px (DFS). */
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

  /** Scene teardown only — react-ecs `destroy()` / `update(null)` equivalent. */
  dispose(): void {
    this.releaseAll()
    this.host.replaceChildren()
  }

  /** Per-entity pool release when the worker mount set becomes empty. */
  releaseAll(): void {
    for (const [entity, el] of [...this.nodes]) {
      this.releaseNode(entity, el)
    }
    this.purgeDisconnectedNodes()
    this.purgeOrphanHostChildren()
  }

  /** Worker mount set — remove pooled nodes that outlived react-ecs unmount (double scrim root cause). */
  purgeUnauthoritativeDom(authoritative: ReadonlySet<Entity>): void {
    for (const [entity, el] of [...this.nodes]) {
      if (!authoritative.has(entity)) this.releaseNode(entity, el)
    }
    for (const el of this.host.querySelectorAll('.scene-ui-node[data-entity]')) {
      if (!(el instanceof HTMLElement)) continue
      const id = Number(el.dataset.entity)
      if (!Number.isFinite(id)) {
        el.remove()
        continue
      }
      const entity = id as Entity
      if (authoritative.has(entity)) continue
      const mapped = this.nodes.get(entity)
      if (mapped) this.releaseNode(entity, mapped)
      else el.remove()
    }
    this.purgeDisconnectedNodes()
    this.purgeOrphanHostChildren()
  }

  /** Drop layout-hidden / unmounted nodes not listed in the mount set (callable without full render). */
  purgeStaleDomTree(alive: ReadonlySet<Entity>): void {
    this.purgeStaleDomTreeInternal(alive)
    this.purgeDisconnectedNodes()
    this.purgeOrphanHostChildren()
  }

  /** Drop DOM immediately when projection deletes UiTransform (before next layout pass). */
  purgeProjectionRemoved(removed: ReadonlySet<Entity>): void {
    if (!removed.size) return
    for (const entity of removed) {
      const el = this.nodes.get(entity)
      if (el) this.releaseNode(entity, el)
    }
    this.purgeDisconnectedNodes()
    this.purgeOrphanHostChildren()
  }

  getPooledNodeCount(): number {
    return this.nodes.size
  }

  countConnectedDomNodes(): number {
    return this.host.querySelectorAll('.scene-ui-node[data-entity]').length
  }

  countInteractiveDomNodes(): number {
    return this.host.querySelectorAll('.scene-ui-node.scene-ui-node--interactive').length
  }

  getNode(entity: Entity): HTMLElement | null {
    return this.nodes.get(entity) ?? null
  }

  getFieldDom(entity: Entity): HTMLInputElement | HTMLSelectElement | null {
    const el = this.nodes.get(entity)
    if (!el) return null
    return (
      (el.querySelector('.scene-ui-node__input') as HTMLInputElement | null) ??
      (el.querySelector('.scene-ui-node__select') as HTMLSelectElement | null)
    )
  }

  render(input: SceneUiDrawInput): void {
    this.purgeDisconnectedNodes()
    this.purgeOrphanHostChildren()

    const alive = new Set<Entity>(input.mountedEntities)
    const visited = new Set<Entity>()
    const regions: UiScreenRegion[] = []
    const scale = uiScreenScaleFromViewport(input.viewport)
    this.ensureLayoutHost()

    // Explorer free stack among canvas roots — low→high author zIndex (later DOM on top).
    const roots = [...(input.forest.get(CANVAS_ROOT_ENTITY) ?? [])].sort((a, b) => {
      const za = input.transformOf(a)?.zIndex ?? 0
      const zb = input.transformOf(b)?.zIndex ?? 0
      return za - zb
    })
    for (const root of roots) {
      this.renderEntityTree(root, input, alive, visited, 0, regions, scale)
    }

    for (const entity of alive) {
      if (visited.has(entity)) continue
      const el = this.nodes.get(entity)
      if (el) this.applyHiddenDomState(el)
    }

    for (const [entity, el] of [...this.nodes]) {
      if (input.authoritativeEntities.has(entity) && input.mountedEntities.has(entity)) continue
      if (this.callbacks.shouldPinEntity?.(entity, el, alive)) continue
      this.releaseNode(entity, el)
    }

    this.purgeStaleDomTreeInternal(input.authoritativeEntities)
    this.purgeDisconnectedNodes()
    this.purgeOrphanHostChildren()
    // Free-stack hosts (roots + elevated tooltips): paint low→high zIndex among host kids.
    this.orderHostFreeStack()
    input.onRegions?.(regions)
  }

  /** Reorder canvas-absolute host children by author zIndex (Explorer free stack). */
  private orderHostFreeStack(): void {
    const kids = [...this.host.children].filter(
      (n): n is HTMLElement =>
        n instanceof HTMLElement && n.classList.contains('scene-ui-node')
    )
    if (kids.length < 2) return
    kids.sort((a, b) => {
      const za = Number.parseFloat(a.style.zIndex || '0') || 0
      const zb = Number.parseFloat(b.style.zIndex || '0') || 0
      return za - zb
    })
    for (const el of kids) this.host.appendChild(el)
  }

  /**
   * Layout-stable paint: re-style only dirty entities, then rebuild hit regions from Yoga boxes.
   * Returns false if a dirty entity has no node yet (caller must full render).
   */
  patchEntities(dirty: readonly Entity[], input: SceneUiDrawInput): boolean {
    const scale = uiScreenScaleFromViewport(input.viewport)
    const alive = new Set<Entity>(input.mountedEntities)
    const patched = new Set<Entity>()
    for (const entity of dirty) {
      if (!alive.has(entity)) {
        const el = this.nodes.get(entity)
        if (el) this.applyHiddenDomState(el)
        continue
      }
      if (!this.nodes.has(entity) && isUiEntityVisible(entity, input.transformOf)) {
        return false
      }
      // depth ignored for patch (regions rebuilt below)
      this.renderEntityTree(entity, input, alive, patched, 0, [], scale)
    }
    // Poker leave-seat / modal close: only a few dirties arrive, but siblings that became
    // display:none (or lost mount) must hide even if not in the dirty set — else stacked HUD.
    for (const [entity, el] of [...this.nodes]) {
      if (patched.has(entity)) continue
      if (!alive.has(entity) || !input.authoritativeEntities.has(entity)) {
        this.applyHiddenDomState(el)
        continue
      }
      if (!isUiEntityVisible(entity, input.transformOf)) {
        this.applyHiddenDomState(el)
        // Hide subtree shells even when only an ancestor flipped display:none.
        const hideKids = (e: Entity): void => {
          for (const child of input.forest.get(e) ?? []) {
            const node = this.nodes.get(child)
            if (node) this.applyHiddenDomState(node)
            hideKids(child)
          }
        }
        hideKids(entity)
      }
    }
    const regions: UiScreenRegion[] = []
    this.collectHitRegionsFromForest(input, regions)
    input.onRegions?.(regions)
    return true
  }

  /**
   * Hit-map from Yoga layout boxes (canvas-absolute) + viewport mapping.
   * Single authority with paint geometry — avoids getBoundingClientRect drift vs nested transforms.
   */
  private collectHitRegionsFromForest(input: SceneUiDrawInput, regions: UiScreenRegion[]): void {
    const walk = (entity: Entity, depth: number): void => {
      if (!input.mountedEntities.has(entity)) return
      const transform = input.transformOf(entity)
      if (transform && isUiEntityVisible(entity, input.transformOf)) {
        const layoutBox = input.layoutBoxes.get(entity)
        if (layoutBox) pushLayoutHitRegion(regions, entity, transform, layoutBox, input, depth)
      }
      for (const child of input.forest.get(entity) ?? []) walk(child, depth + 1)
    }
    for (const root of input.forest.get(CANVAS_ROOT_ENTITY) ?? []) walk(root, 0)
  }

  /** `#scene-ui-root` is the layout containing block (aligned to interactable canvas rect). */
  private ensureLayoutHost(): HTMLElement {
    this.host.style.pointerEvents = 'none'
    this.host.style.overflow = 'hidden'
    for (const stale of this.host.querySelectorAll('.scene-ui-canvas')) {
      stale.remove()
    }
    return this.host
  }

  /**
   * Nest under ECS parent shell so overflow:hidden on shop panels clips children.
   * Flat canvas-absolute (host + abs box) painted every inventory icon over the 3D world
   * because parents no longer clipped — fishing mash screenshot.
   *
   * Explorer free stack: when author zIndex is strictly higher than the parent, promote
   * to canvas-absolute so hover tooltips / overlays stack above sibling HUD roots instead
   * of being trapped in the parent's transform stacking context.
   *
   * Unusable (0×0) parents → canvas-absolute fallback for that node only; never nest under
   * a collapsed shell (that piled icons at one point).
   */
  private resolveDomParent(
    transform: PBUiTransform,
    transformOf: (e: Entity) => PBUiTransform | null
  ): {
    parent: HTMLElement
    coords: 'canvas' | 'parent'
  } {
    const parentId = transform.parent ?? CANVAS_ROOT_ENTITY
    if (parentId === CANVAS_ROOT_ENTITY || parentId === 0) {
      return { parent: this.host, coords: 'canvas' }
    }
    const selfZ = transform.zIndex ?? 0
    const parentZ = transformOf(parentId as Entity)?.zIndex ?? 0
    // Free stack: elevated zIndex breaks out of parent clip/isolation (command-center
    // tooltips, NEW banners over grids). Same z stays nested for inventory cells.
    if (selfZ > parentZ) {
      return { parent: this.host, coords: 'canvas' }
    }
    const parentShell = this.nodes.get(parentId as Entity)
    if (
      parentShell?.isConnected &&
      parentShell.dataset.uiUnusable !== '1' &&
      parentShell.style.display !== 'none'
    ) {
      return { parent: parentShell, coords: 'parent' }
    }
    // Parent missing/hidden/unusable — do not paint orphans at canvas abs (that scatters
    // shop icons). Caller still hides 0×0 subtrees; this is for late parent create order.
    return { parent: this.host, coords: 'canvas' }
  }

  private getOrCreateNode(entity: Entity): HTMLElement {
    let el = this.nodes.get(entity)
    if (!el) {
      el = document.createElement('div')
      el.className = 'scene-ui-node'
      el.dataset.entity = String(entity)
      this.nodes.set(entity, el)
      return el
    }
    if (el.dataset.entity !== String(entity)) {
      this.releaseNode(entity, el)
      el = document.createElement('div')
      el.className = 'scene-ui-node'
      el.dataset.entity = String(entity)
      this.nodes.set(entity, el)
    }
    return el
  }

  private renderEntityTree(
    entity: Entity,
    input: SceneUiDrawInput,
    alive: ReadonlySet<Entity>,
    visited: Set<Entity>,
    depth: number,
    regions: UiScreenRegion[],
    scale: UiScreenScale
  ): void {
    if (!input.mountedEntities.has(entity) || !alive.has(entity)) return
    visited.add(entity)

    const transform = input.transformOf(entity)
    if (!transform || !isUiEntityVisible(entity, input.transformOf)) {
      // display:none / opacity 0 — hide this shell and the whole subtree (do not paint
      // children as canvas-absolute orphans; that tiles every shop icon across the screen).
      const hidden = this.nodes.get(entity)
      if (hidden) this.applyHiddenDomState(hidden)
      const hideSubtree = (e: Entity): void => {
        for (const child of input.forest.get(e) ?? []) {
          visited.add(child)
          const node = this.nodes.get(child)
          if (node) this.applyHiddenDomState(node)
          hideSubtree(child)
        }
      }
      hideSubtree(entity)
      return
    }

    const { parent: domParent, coords } = this.resolveDomParent(transform, input.transformOf)
    const shell = this.getOrCreateNode(entity)
    adoptNode(domParent, shell)
    const el = ensureContentRoot(shell)

    const text = input.textOf(entity)
    const bg = input.backgroundOf(entity)
    const uiInput = input.inputOf(entity)
    const uiDropdown = input.dropdownOf(entity)
    const flex = flexContainerCss(transform)
    const borders = borderCss(transform, scale)
    const radius = borderRadiusCss(transform, scale)
    const layoutBox = input.layoutBoxes.get(entity)
    // Visibility is UiTransform.display + opacity (isUiEntityVisible above), not
    // canvas bounds. Explorer keeps display:flex nodes in the tree while they sit
    // off-canvas (Layer showFrom, plaza letterbox at top:100%, cake strip at
    // bottom:-20%). Host overflow:hidden clips; hiding here parked swipe panels
    // and invented a second visibility law.
    if (!layoutBox || layoutBox.width <= 0.5 || layoutBox.height <= 0.5) {
      // Collapsed yoga box — hide shell AND entire subtree. Painting children as
      // canvas-absolute orphans scattered fishing shop icons across the 3D view.
      this.applyHiddenDomState(shell)
      shell.dataset.uiUnusable = '1'
      if (
        typeof location !== 'undefined' &&
        location.search.includes('sceneuidebug') &&
        input.mountedEntities.has(entity)
      ) {
        const id = entity as number
        if (!layoutBox) {
          // Missing box — layout completeness bug (not progressive flex).
          if (!yogaMissingBoxWarned.has(id)) {
            yogaMissingBoxWarned.add(id)
            console.warn(`[scene-ui] yoga box unusable for mounted entity ${entity} (none)`)
          }
        } else {
          // 0×0 is normal while flex grids fill (inventory slots); only warn if sticky.
          const streak = (yogaZeroBoxStreak.get(id) ?? 0) + 1
          yogaZeroBoxStreak.set(id, streak)
          if (streak >= YOGA_ZERO_STICKY_FRAMES && !yogaZeroBoxWarned.has(id)) {
            yogaZeroBoxWarned.add(id)
            console.warn(
              `[scene-ui] yoga box sticky 0×0 for mounted entity ${entity} (${streak} paints)`
            )
          }
        }
      }
      const hideSubtree = (e: Entity): void => {
        for (const child of input.forest.get(e) ?? []) {
          visited.add(child)
          const node = this.nodes.get(child)
          if (node) {
            this.applyHiddenDomState(node)
            node.dataset.uiUnusable = '1'
          }
          hideSubtree(child)
        }
      }
      hideSubtree(entity)
      return
    }

    // Recovered a real box — clear progressive 0×0 streak so reopen doesn't false-sticky.
    yogaZeroBoxStreak.delete(entity as number)
    delete shell.dataset.uiUnusable
    // Undo applyHiddenDomState — display:none stuck after prior hide left dead shells.
    shell.style.display = 'block'
    shell.style.visibility = 'visible'
    applyUiTransformContentStyles(el, transform, scale)
    shell.style.opacity = String(Math.min(1, Math.max(0, transform.opacity ?? 1)))
    shell.style.zIndex = String(transform.zIndex ?? 0)
    shell.style.backgroundImage = ''
    shell.style.borderImage = ''
    shell.removeAttribute('aria-hidden')
    shell.style.pointerEvents = ''
    shell.removeAttribute('inert')

    // Text leaves: don't clip labels that slightly exceed yoga's tight content box
    // (Admin Tools titles/buttons were shredding under overflow:hidden + padding).
    if (text?.value?.trim() && !uiInput && !uiDropdown) {
      el.style.overflow = 'visible'
    }

    if (radius) {
      shell.style.borderRadius = radius
      el.style.borderRadius = radius
    } else {
      shell.style.borderRadius = ''
      el.style.borderRadius = ''
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

    const interactive = isSceneUiNodeInteractive(
      entity,
      input.ecs,
      transform,
      input.inputOf,
      input.dropdownOf,
      input.pointerEventsOf,
      bg,
      layoutBox,
      input.forest
    )

    // Clip only when author sets overflow hidden/scroll (Explorer free stack).
    // Do NOT clip solely for border-radius — that trapped poker face/card icons inside
    // rounded seat rows (DCL client lets children paint outside the rounded panel).
    // Border-radius still applies on shell/bg layers for the rounded look.
    const clipShell =
      transform.overflow === YGOverflow.HIDDEN || transform.overflow === YGOverflow.SCROLL

    const compactControl =
      layoutBox.width < 500 &&
      layoutBox.height < 160 &&
      (!!bg || interactive || borders.width !== '')
    if (text?.value?.trim()) {
      if (compactControl || interactive) {
        el.style.alignItems = flex.alignItems
        el.style.justifyContent = flex.justifyContent
      } else {
        const align = textAlignCss(text.textAlign)
        el.style.alignItems = align.alignItems
        el.style.justifyContent = align.justifyContent
      }
    } else {
      el.style.alignItems = flex.alignItems
      el.style.justifyContent = flex.justifyContent
    }

    applySceneUiNodePointerState(shell, interactive, !!uiInput || !!uiDropdown)

    const imageUrl = resolveUiBackgroundImageUrl(bg, input.scene)
    const hasBg = hasUiVisualBackground(bg, imageUrl)
    const colorOnlyBg = hasBg && !imageUrl && !hasUiBackgroundTexture(bg)
    const rawTexSrc = bg ? extractUiTextureSrc(bg.texture) : null
    const texMode =
      bg && (imageUrl || rawTexSrc)
        ? normalizeBackgroundTextureMode(bg.textureMode, rawTexSrc, bg.textureSlices, bg.uvs)
        : BackgroundTextureMode.STRETCH
    // Atlas UV sprites must never take the nine-slice border-image path.
    const useNineSlice =
      imageUrl &&
      texMode === BackgroundTextureMode.NINE_SLICES &&
      !parseUiBackgroundUvRect(bg?.uvs)
    if (hasBg) {
      if (colorOnlyBg) {
        el.querySelector('.scene-ui-node__bg')?.remove()
        el.querySelector('.scene-ui-node__bg-img')?.remove()
        applyUiBackgroundStyles(el, bg, null, scale)
      } else if (useNineSlice) {
        el.style.backgroundColor = 'transparent'
        el.querySelector('.scene-ui-node__bg-img')?.remove()
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
      } else {
        el.querySelector('.scene-ui-node__bg')?.remove()
        el.style.backgroundColor = 'transparent'
        // Do not clear el.opacity here — applyUiBackgroundStyles owns it. Clearing every
        // paint then early-returning on a stable sig left reel bar BGs flashing.
        applyUiBackgroundStyles(el, bg, imageUrl, scale)
      }
    } else {
      el.style.backgroundColor = 'transparent'
      el.style.borderImage = ''
      el.style.borderImageSource = ''
      el.style.opacity = ''
      el.style.overflow = ''
      el.querySelector('.scene-ui-node__bg')?.remove()
      el.querySelector('.scene-ui-node__bg-img')?.remove()
    }

    if (uiInput) {
      this.syncUiInput(el, entity, uiInput, scale, hasBg)
    } else if (uiDropdown) {
      this.syncUiDropdown(el, entity, uiDropdown, scale)
    } else if (text?.value?.trim()) {
      const span = el.querySelector('.scene-ui-node__text') as HTMLElement | null
      const label = span ?? document.createElement('div')
      label.className = 'scene-ui-node__text'
      // Avoid innerHTML thrash on stable labels when PE repaints every dirty tick.
      const html = sanitizeUiTextHtml(text.value)
      if (label.dataset.dclUiText !== html) {
        label.dataset.dclUiText = html
        label.innerHTML = html
      }
      // Buttons / compact chrome: keep labels on one line (Admin Tools "Stream", "Play action").
      const preferSingleLine = compactControl || interactive
      applyUiTextStyles(label, text, scale, preferSingleLine)
      if (!span) el.appendChild(label)
      el.querySelector('.scene-ui-node__input')?.remove()
      el.querySelector('.scene-ui-node__select')?.remove()
    } else {
      el.querySelector('.scene-ui-node__text')?.remove()
      el.querySelector('.scene-ui-node__input')?.remove()
      el.querySelector('.scene-ui-node__select')?.remove()
    }

    // Nested shells: parent-relative; roots: canvas-absolute. Clip large panels (clipShell).
    applyYogaLayoutBox(shell, layoutBox, scale, coords, clipShell)
    // Author zIndex — must paint order among siblings (later DOM = on top for equal isolate).
    const z = transform.zIndex ?? 0
    shell.style.zIndex = String(z)
    shell.style.setProperty('z-index', String(z), 'important')

    // Hit map always canvas-absolute (not nested DOM rects).
    pushLayoutHitRegion(regions, entity, transform, layoutBox, input, depth)

    // Explorer stacking: siblings paint low→high zIndex so higher author zIndex wins.
    const children = [...(input.forest.get(entity) ?? [])].sort((a, b) => {
      const ta = input.transformOf(a)
      const tb = input.transformOf(b)
      return (ta?.zIndex ?? 0) - (tb?.zIndex ?? 0)
    })
    for (const child of children) {
      this.renderEntityTree(child, input, alive, visited, depth + 1, regions, scale)
    }
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
    field.addEventListener('focus', () => this.callbacks.onFieldFocus?.(entity))
    field.addEventListener('blur', () => this.callbacks.onFieldBlur?.(entity))
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
    select.addEventListener('focus', () => this.callbacks.onFieldFocus?.(entity))
    select.addEventListener('blur', () => this.callbacks.onFieldBlur?.(entity))
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

  private applyHiddenDomState(shell: HTMLElement): void {
    shell.classList.remove('scene-ui-node--interactive')
    shell.style.display = 'none'
    shell.style.pointerEvents = 'none'
    shell.style.visibility = 'hidden'
    shell.style.cursor = ''
    shell.style.transform = ''
    shell.setAttribute('inert', '')
    shell.setAttribute('aria-hidden', 'true')
  }

  /**
   * react-ecs conditional unmount removes entities; any leftover DOM with pointer-events:auto
   * intercepts clicks and delivers PET_DOWN to recycled/dead entity ids.
   */
  private purgeStaleDomTreeInternal(alive: ReadonlySet<Entity>): void {
    for (const el of this.host.querySelectorAll('.scene-ui-node[data-entity]')) {
      if (!(el instanceof HTMLElement)) continue
      const id = Number(el.dataset.entity)
      if (!Number.isFinite(id)) {
        el.remove()
        continue
      }
      const entity = id as Entity
      if (alive.has(entity)) continue
      this.callbacks.onEntityReleased?.(entity)
      this.nodes.delete(entity)
      el.remove()
    }
  }

  private releaseNode(entity: Entity, el: HTMLElement): void {
    const field = el.querySelector('.scene-ui-node__input, .scene-ui-node__select') as
      | HTMLInputElement
      | HTMLSelectElement
      | null
    if (field && document.activeElement === field) {
      field.blur()
    }
    el.style.cssText = ''
    el.replaceChildren()
    this.callbacks.onEntityReleased?.(entity)
    for (const [id, node] of [...this.nodes]) {
      if (id === entity || el.contains(node)) {
        if (id !== entity) this.callbacks.onEntityReleased?.(id)
        this.nodes.delete(id)
      }
    }
    el.remove()
  }

  /** Drop map entries whose nodes were removed with a parent (react-ecs recycle). */
  private purgeDisconnectedNodes(): void {
    for (const [entity, el] of [...this.nodes]) {
      if (el.isConnected) continue
      this.callbacks.onEntityReleased?.(entity)
      this.nodes.delete(entity)
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
    for (const el of this.host.querySelectorAll('.scene-ui-node[data-entity]')) {
      if (!(el instanceof HTMLElement)) continue
      const id = Number(el.dataset.entity)
      if (!Number.isFinite(id) || !this.nodes.has(id as Entity)) {
        el.remove()
      }
    }
  }
}

/**
 * Scene ECS UI overlay host.
 * - `scene-ui-root` — primary parcel scene UI
 * - `pe-ui-root` — portable experience / smart wearable UI (separate so PE
 *   clicks and paint never fight primary, and primary setVisible can't hide PE)
 */
export function ensureSceneUiRoot(rootId = 'scene-ui-root'): HTMLElement {
  let root = document.getElementById(rootId)
  if (!root) {
    root = document.createElement('div')
    root.id = rootId
    document.body.appendChild(root)
  }
  return root
}