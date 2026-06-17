import { SIDEBAR_ICONS } from './icons'

/** Profile button — circular avatar face from Catalyst profile snapshot. */
export class ProfileSidebarButton {
  readonly element: HTMLButtonElement
  private readonly img: HTMLImageElement

  constructor(label: string, onClick?: () => void) {
    this.element = document.createElement('button')
    this.element.type = 'button'
    this.element.className = 'client-sidebar__btn client-sidebar__btn--profile'
    this.element.dataset.action = 'profile'
    this.element.title = label
    this.element.setAttribute('aria-label', label)

    this.img = document.createElement('img')
    this.img.className = 'client-sidebar__avatar'
    this.img.alt = ''
    this.img.decoding = 'async'
    this.img.src = this.placeholderDataUrl()

    this.element.appendChild(this.img)
    this.element.addEventListener('click', () => onClick?.())
  }

  setFaceUrl(url: string | null): void {
    this.img.src = url ?? this.placeholderDataUrl()
  }

  private placeholderDataUrl(): string {
    return `data:image/svg+xml,${encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect fill="#2a2a34" width="32" height="32"/><circle cx="16" cy="13" r="5" fill="#666"/><path d="M8 27c1.5-5 5-7 8-7s6.5 2 8 7" fill="#666"/></svg>`
    )}`
  }
}

export function createSidebarDivider(): HTMLDivElement {
  const el = document.createElement('div')
  el.className = 'client-sidebar__divider'
  el.setAttribute('aria-hidden', 'true')
  return el
}

export { SIDEBAR_ICONS }
