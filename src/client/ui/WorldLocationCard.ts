import type { ResolvedScene } from '../../dcl/content/types'
import { sceneChatRailIcon } from './shell/icons'

export type WorldLocationCardOptions = {
  scene: ResolvedScene
  title: string
  getCoordsLabel: () => string
  onJumpToGenesis?: () => void
  /**
   * Parcel minimap stack: left chevron slides the circular map open/closed.
   * When provided, the card is mounted into the stack host (not body).
   */
  mapToggle?: {
    host: HTMLElement
    /** Called when the user toggles the map. */
    onCollapsedChange?: (collapsed: boolean) => void
    /** Start with map hidden (default false = map open). */
    initiallyCollapsed?: boolean
  }
  /**
   * Scene options (⋯) — live polls / Q&A. Called with the options button as anchor.
   */
  onSceneOptions?: (anchor: HTMLElement) => void
}

const EXPAND_SVG = `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
  <path d="M8 14l4-4 4 4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M8 10l4-4 4 4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`

const OPTIONS_SVG = `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
  <circle cx="12" cy="6.5" r="1.4" fill="currentColor"/>
  <circle cx="12" cy="12" r="1.4" fill="currentColor"/>
  <circle cx="12" cy="17.5" r="1.4" fill="currentColor"/>
</svg>`

/** Top-left HUD location pill — scene/world name + live coordinates. */
export class WorldLocationCard {
  readonly root: HTMLDivElement
  private readonly titleEl: HTMLElement
  private readonly coordsEl: HTMLElement
  private readonly expandBtn: HTMLButtonElement | null
  private readonly optionsBtn: HTMLButtonElement | null
  private collapsed = false
  private disposed = false
  private readonly getCoordsLabel: () => string
  private readonly mapToggle: WorldLocationCardOptions['mapToggle']
  private readonly showJump: boolean
  private readonly onMapCollapsedChange: ((collapsed: boolean) => void) | null

  constructor({
    scene,
    title,
    getCoordsLabel,
    onJumpToGenesis,
    mapToggle,
    onSceneOptions
  }: WorldLocationCardOptions) {
    this.getCoordsLabel = getCoordsLabel
    this.mapToggle = mapToggle
    this.onMapCollapsedChange = mapToggle?.onCollapsedChange ?? null
    this.showJump = scene.source.kind === 'world' && !!onJumpToGenesis
    const showExpand = this.showJump || !!mapToggle
    const showOptions = typeof onSceneOptions === 'function'

    this.root = document.createElement('div')
    this.root.id = 'world-location-card'
    this.root.className = 'world-location-card'
    if (!this.showJump) this.root.classList.add('is-parcel-pill')
    if (mapToggle) this.root.classList.add('is-above-minimap')

    const expandMarkup = showExpand
      ? `<button type="button" class="world-location-card__expand" aria-label="Collapse" aria-expanded="true">
          ${EXPAND_SVG}
        </button>`
      : ''

    const optionsMarkup = showOptions
      ? `<div class="world-location-card__actions">
          <button type="button" class="world-location-card__icon-btn world-location-card__icon-btn--active" aria-label="Scene options" data-scene-options>
            ${OPTIONS_SVG}
          </button>
        </div>`
      : this.showJump
        ? `<div class="world-location-card__actions">
          <button type="button" class="world-location-card__icon-btn" aria-label="Favorite world" disabled>
            <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M12 20.5 9.7 18.4C5.4 14.6 3 12.4 3 9.5 3 7.2 4.7 5.5 7 5.5c1.4 0 2.7.7 3.5 1.7.8-1 2.1-1.7 3.5-1.7 2.3 0 4 1.7 4 4 0 2.9-2.4 5.1-6.7 8.9L12 20.5z" stroke="currentColor" stroke-width="1.5"/>
            </svg>
          </button>
        </div>`
        : ''

    this.root.innerHTML = `
      <div class="world-location-card__header">
        ${expandMarkup}
        <div class="world-location-card__info">
          <h2 class="world-location-card__title"></h2>
          <p class="world-location-card__coords">
            <span class="world-location-card__pin" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none">
                <path d="M12 21s6-4.35 6-10a6 6 0 1 0-12 0c0 5.65 6 10 6 10z" stroke="currentColor" stroke-width="1.5"/>
                <circle cx="12" cy="11" r="2" fill="currentColor"/>
              </svg>
            </span>
            <span class="world-location-card__coords-text">0, 0</span>
            <span class="world-location-card__info-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none">
                <circle cx="12" cy="12" r="8.5" stroke="currentColor" stroke-width="1.5"/>
                <path d="M12 10.5v5M12 8.2v.1" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
              </svg>
            </span>
          </p>
        </div>
        ${optionsMarkup}
      </div>
      ${
        this.showJump
          ? `<div class="world-location-card__body">
        <div class="world-location-card__divider" aria-hidden="true"></div>
        <button type="button" class="world-location-card__jump">
          <span class="world-location-card__jump-icon" aria-hidden="true">${sceneChatRailIcon()}</span>
          <span class="world-location-card__jump-text">JUMP BACK TO GENESIS CITY</span>
        </button>
      </div>`
          : ''
      }
    `

    this.titleEl = this.root.querySelector('.world-location-card__title')!
    this.coordsEl = this.root.querySelector('.world-location-card__coords-text')!
    this.expandBtn = this.root.querySelector('.world-location-card__expand')
    this.optionsBtn = this.root.querySelector('[data-scene-options]')

    this.titleEl.textContent = title

    if (showExpand && this.expandBtn) {
      this.expandBtn.addEventListener('click', (ev) => {
        ev.stopPropagation()
        this.setCollapsed(!this.collapsed)
      })
    }
    if (this.showJump) {
      const jumpBtn = this.root.querySelector('.world-location-card__jump') as HTMLButtonElement
      jumpBtn.addEventListener('click', () => onJumpToGenesis!())
    }
    if (this.optionsBtn && onSceneOptions) {
      this.optionsBtn.addEventListener('click', (ev) => {
        ev.stopPropagation()
        onSceneOptions(this.optionsBtn!)
      })
    }

    const mountHost = mapToggle?.host ?? document.body
    mountHost.appendChild(this.root)

    if (mapToggle?.initiallyCollapsed) {
      this.setCollapsed(true)
    }

    const tick = (): void => {
      if (this.disposed) return
      this.coordsEl.textContent = this.getCoordsLabel()
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  }

  private setCollapsed(next: boolean): void {
    this.collapsed = next
    this.root.classList.toggle('is-collapsed', next)
    // Map stack: collapse class lives on the shared host so the circle slides away.
    if (this.mapToggle?.host) {
      this.mapToggle.host.classList.toggle('is-map-collapsed', next)
    }
    if (this.expandBtn) {
      this.expandBtn.setAttribute('aria-expanded', next ? 'false' : 'true')
      if (this.mapToggle) {
        this.expandBtn.setAttribute('aria-label', next ? 'Show map' : 'Hide map')
      } else {
        this.expandBtn.setAttribute(
          'aria-label',
          next ? 'Expand location card' : 'Collapse location card'
        )
      }
    }
    this.onMapCollapsedChange?.(next)
  }

  isMapCollapsed(): boolean {
    return this.collapsed
  }

  /** Update scene/world title (e.g. after seamless promote or soft context). */
  setTitle(title: string): void {
    this.titleEl.textContent = title
  }

  setVisible(visible: boolean): void {
    // When stacked, host owns visibility so the translucent frame toggles together.
    if (this.mapToggle?.host) {
      this.mapToggle.host.hidden = !visible
      return
    }
    this.root.hidden = !visible
  }

  dispose(): void {
    this.disposed = true
    this.root.remove()
  }
}
