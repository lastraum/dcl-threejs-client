import type { ResolvedScene } from '../../dcl/content/types'
import { SCENE_CHAT_RAIL_ICON } from './shell/icons'

export type WorldLocationCardOptions = {
  scene: ResolvedScene
  title: string
  getCoordsLabel: () => string
  onJumpToGenesis?: () => void
}

/** Top-left HUD location pill — scene/world name + live coordinates. */
export class WorldLocationCard {
  private readonly root: HTMLDivElement
  private readonly titleEl: HTMLElement
  private readonly coordsEl: HTMLElement
  private readonly expandBtn: HTMLButtonElement | null
  private collapsed = false
  private disposed = false
  private readonly getCoordsLabel: () => string

  constructor({ scene, title, getCoordsLabel, onJumpToGenesis }: WorldLocationCardOptions) {
    this.getCoordsLabel = getCoordsLabel
    const showJump = scene.source.kind === 'world' && !!onJumpToGenesis

    this.root = document.createElement('div')
    this.root.id = 'world-location-card'
    this.root.className = 'world-location-card'
    if (!showJump) this.root.classList.add('is-parcel-pill')

    const expandMarkup = showJump
      ? `<button type="button" class="world-location-card__expand" aria-label="Collapse location card" aria-expanded="true">
          <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M8 14l4-4 4 4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
            <path d="M8 10l4-4 4 4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </button>`
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
        ${
          showJump
            ? `<div class="world-location-card__actions">
          <button type="button" class="world-location-card__icon-btn" aria-label="Favorite world" disabled>
            <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M12 20.5 9.7 18.4C5.4 14.6 3 12.4 3 9.5 3 7.2 4.7 5.5 7 5.5c1.4 0 2.7.7 3.5 1.7.8-1 2.1-1.7 3.5-1.7 2.3 0 4 1.7 4 4 0 2.9-2.4 5.1-6.7 8.9L12 20.5z" stroke="currentColor" stroke-width="1.5"/>
            </svg>
          </button>
          <button type="button" class="world-location-card__icon-btn" aria-label="World options" disabled>
            <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <circle cx="12" cy="6.5" r="1.4" fill="currentColor"/>
              <circle cx="12" cy="12" r="1.4" fill="currentColor"/>
              <circle cx="12" cy="17.5" r="1.4" fill="currentColor"/>
            </svg>
          </button>
        </div>`
            : ''
        }
      </div>
      ${
        showJump
          ? `<div class="world-location-card__body">
        <div class="world-location-card__divider" aria-hidden="true"></div>
        <button type="button" class="world-location-card__jump">
          <span class="world-location-card__jump-icon" aria-hidden="true">${SCENE_CHAT_RAIL_ICON}</span>
          <span class="world-location-card__jump-text">JUMP BACK TO GENESIS CITY</span>
        </button>
      </div>`
          : ''
      }
    `

    this.titleEl = this.root.querySelector('.world-location-card__title')!
    this.coordsEl = this.root.querySelector('.world-location-card__coords-text')!
    this.expandBtn = this.root.querySelector('.world-location-card__expand')

    this.titleEl.textContent = title

    if (showJump && this.expandBtn) {
      this.expandBtn.addEventListener('click', () => this.setCollapsed(!this.collapsed))
      const jumpBtn = this.root.querySelector('.world-location-card__jump') as HTMLButtonElement
      jumpBtn.addEventListener('click', () => onJumpToGenesis!())
    }

    document.body.appendChild(this.root)

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
    if (!this.expandBtn) return
    this.expandBtn.setAttribute('aria-expanded', next ? 'false' : 'true')
    this.expandBtn.setAttribute('aria-label', next ? 'Expand location card' : 'Collapse location card')
  }

  dispose(): void {
    this.disposed = true
    this.root.remove()
  }
}