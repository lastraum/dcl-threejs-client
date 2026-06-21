import { SIDEBAR_ICONS } from './shell/icons'

export type MobileHudHandlers = {
  onProfile: () => void
  onChat: () => void
}

/** Minimal mobile portrait chrome — profile (settings) top-left, chat bottom-left. */
export class MobileHud {
  readonly root: HTMLElement
  private readonly profileBtn: HTMLButtonElement
  private readonly profileImg: HTMLImageElement
  private readonly chatBtn: HTMLButtonElement
  private readonly chatBadge: HTMLSpanElement

  constructor(handlers: MobileHudHandlers) {
    this.root = document.createElement('nav')
    this.root.className = 'mobile-hud'
    this.root.setAttribute('aria-label', 'Mobile controls')
    this.root.innerHTML = `
      <button type="button" class="mobile-hud__btn mobile-hud__btn--profile" aria-label="Settings">
        <img class="mobile-hud__avatar" alt="" decoding="async" />
      </button>
      <button type="button" class="mobile-hud__btn mobile-hud__btn--chat" aria-label="Chat">
        <span class="mobile-hud__icon" aria-hidden="true"></span>
        <span class="mobile-hud__badge" hidden></span>
      </button>
    `

    this.profileBtn = this.root.querySelector('.mobile-hud__btn--profile') as HTMLButtonElement
    this.profileImg = this.root.querySelector('.mobile-hud__avatar') as HTMLImageElement
    this.chatBtn = this.root.querySelector('.mobile-hud__btn--chat') as HTMLButtonElement
    this.chatBadge = this.root.querySelector('.mobile-hud__badge') as HTMLSpanElement

    const chatIcon = this.chatBtn.querySelector('.mobile-hud__icon') as HTMLSpanElement
    chatIcon.innerHTML = SIDEBAR_ICONS.chat

    this.profileImg.src = this.placeholderAvatar()

    this.profileBtn.addEventListener('click', (ev) => {
      ev.stopPropagation()
      handlers.onProfile()
    })
    this.chatBtn.addEventListener('click', (ev) => {
      ev.stopPropagation()
      handlers.onChat()
    })

    document.body.appendChild(this.root)
    this.root.hidden = true
  }

  show(): void {
    this.root.hidden = false
  }

  hide(): void {
    this.root.hidden = true
  }

  setProfileActive(active: boolean): void {
    this.profileBtn.classList.toggle('is-active', active)
  }

  setChatActive(active: boolean): void {
    this.chatBtn.classList.toggle('is-active', active)
  }

  setFaceUrl(url: string | null): void {
    this.profileImg.src = url ?? this.placeholderAvatar()
  }

  setChatBadge(count: number | null): void {
    if (!count || count <= 0) {
      this.chatBadge.hidden = true
      this.chatBadge.textContent = ''
      return
    }
    this.chatBadge.hidden = false
    this.chatBadge.textContent = count > 99 ? '99+' : String(count)
  }

  dispose(): void {
    this.root.remove()
  }

  private placeholderAvatar(): string {
    return `data:image/svg+xml,${encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect fill="#2a2a34" width="32" height="32"/><circle cx="16" cy="13" r="5" fill="#666"/><path d="M8 27c1.5-5 5-7 8-7s6.5 2 8 7" fill="#666"/></svg>`
    )}`
  }
}