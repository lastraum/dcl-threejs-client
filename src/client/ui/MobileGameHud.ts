import { SIDEBAR_ICONS } from './shell/ProfileSidebarButton'

const MOBILE_HUD_QUERY = '(max-width: 767px)'

export type MobileGameHudHandlers = {
  onEmote: () => void
  onPrimaryDown: () => void
  onPrimaryUp: () => void
  onSecondaryDown: () => void
  onSecondaryUp: () => void
  onJumpDown: () => void
  onJumpUp: () => void
}

/** Touch controls for emotes, E/F interact, and jump — mobile only. */
export class MobileGameHud {
  private readonly root: HTMLDivElement
  private readonly mobileQuery = window.matchMedia(MOBILE_HUD_QUERY)
  private readonly onLayoutChange = (): void => this.syncVisibility()
  private handlers: MobileGameHudHandlers
  private shellVisible = false

  constructor(handlers: MobileGameHudHandlers) {
    this.handlers = handlers
    this.root = document.createElement('div')
    this.root.className = 'mobile-game-hud'
    this.root.hidden = true
    this.root.innerHTML = `
      <button type="button" class="mobile-game-hud__btn mobile-game-hud__btn--emote" aria-label="Emotes">
        <span class="mobile-game-hud__icon" aria-hidden="true">${SIDEBAR_ICONS.emotes}</span>
      </button>
      <button type="button" class="mobile-game-hud__btn mobile-game-hud__btn--primary" aria-label="Interact (E)">
        <span class="mobile-game-hud__key">E</span>
      </button>
      <button type="button" class="mobile-game-hud__btn mobile-game-hud__btn--secondary" aria-label="Interact (F)">
        <span class="mobile-game-hud__key">F</span>
      </button>
      <button type="button" class="mobile-game-hud__btn mobile-game-hud__btn--jump" aria-label="Jump">
        <span class="mobile-game-hud__icon mobile-game-hud__icon--jump" aria-hidden="true">↑</span>
      </button>
    `

    this.root.querySelector('.mobile-game-hud__btn--emote')?.addEventListener('click', (ev) => {
      ev.stopPropagation()
      this.handlers.onEmote()
    })

    this.bindHoldButton(
      this.root.querySelector('.mobile-game-hud__btn--primary') as HTMLButtonElement,
      () => this.handlers.onPrimaryDown(),
      () => this.handlers.onPrimaryUp()
    )
    this.bindHoldButton(
      this.root.querySelector('.mobile-game-hud__btn--secondary') as HTMLButtonElement,
      () => this.handlers.onSecondaryDown(),
      () => this.handlers.onSecondaryUp()
    )
    this.bindHoldButton(
      this.root.querySelector('.mobile-game-hud__btn--jump') as HTMLButtonElement,
      () => this.handlers.onJumpDown(),
      () => this.handlers.onJumpUp()
    )

    document.body.appendChild(this.root)
    this.mobileQuery.addEventListener('change', this.onLayoutChange)
  }

  setHandlers(handlers: MobileGameHudHandlers): void {
    this.handlers = handlers
  }

  setShellVisible(visible: boolean): void {
    this.shellVisible = visible
    this.syncVisibility()
  }

  setEmoteActive(active: boolean): void {
    this.root.querySelector('.mobile-game-hud__btn--emote')?.classList.toggle('is-active', active)
  }

  private syncVisibility(): void {
    const show = this.mobileQuery.matches && this.shellVisible
    this.root.hidden = !show
  }

  private bindHoldButton(btn: HTMLButtonElement, onDown: () => void, onUp: () => void): void {
    const release = (): void => {
      onUp()
      window.removeEventListener('pointerup', release)
      window.removeEventListener('pointercancel', release)
    }
    btn.addEventListener('pointerdown', (ev) => {
      ev.preventDefault()
      ev.stopPropagation()
      onDown()
      window.addEventListener('pointerup', release)
      window.addEventListener('pointercancel', release)
    })
  }

  dispose(): void {
    this.mobileQuery.removeEventListener('change', this.onLayoutChange)
    this.root.remove()
  }
}