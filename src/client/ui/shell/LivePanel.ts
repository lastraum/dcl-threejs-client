import type { LoginResult } from '../../../auth/AuthClient'
import type { LiveDirectoryController } from '../../../social/LiveDirectoryController'
import type { LiveSession } from '../../../social/globalLiveWire'
import { LiveDirectoryView } from '../live/LiveDirectoryView'

export type LivePanelOptions = {
  getDirectory: () => LiveDirectoryController | null
  getLogin?: () => LoginResult | null
  onWatch: (session: LiveSession) => void
  onClose?: () => void
}

/**
 * Full-screen Live directory over 3D (same layout as `/live` page).
 * Cards are static tiles — stream video only plays in PiP via onWatch.
 */
export class LivePanel {
  readonly element: HTMLDivElement
  private readonly view: LiveDirectoryView
  private visible = false
  private bindRetryTimer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly options: LivePanelOptions) {
    this.element = document.createElement('div')
    this.element.className = 'live-panel live-panel--fullscreen'
    this.element.hidden = true
    this.element.setAttribute('role', 'dialog')
    this.element.setAttribute('aria-modal', 'true')
    this.element.setAttribute('aria-label', 'Live')
    this.element.innerHTML = `
      <div class="live-panel__shell">
        <header class="live-panel__header">
          <div class="live-panel__header-left">
            <span class="live-panel__live-dot" aria-hidden="true"></span>
            <h1 class="live-panel__title">Live</h1>
          </div>
          <button type="button" class="live-panel__close" data-close aria-label="Close">✕</button>
        </header>
        <div class="live-panel__body" data-body></div>
      </div>
    `
    this.view = new LiveDirectoryView({
      getDirectory: () => this.options.getDirectory(),
      getLogin: () => this.options.getLogin?.() ?? null,
      onWatch: (s) => {
        this.options.onWatch(s)
        // Keep directory open so user can open another stream or end live.
      },
      compact: false
    })
    this.element.querySelector('[data-body]')!.appendChild(this.view.root)
    this.element.querySelector('[data-close]')!.addEventListener('click', () => this.hide())
    // Backdrop click outside shell closes (shell is centered max-width).
    this.element.addEventListener('click', (ev) => {
      if (ev.target === this.element) this.hide()
    })
    document.body.appendChild(this.element)
  }

  toggle(): void {
    if (this.visible) this.hide()
    else this.show()
  }

  show(): void {
    this.visible = true
    this.element.hidden = false
    this.element.removeAttribute('hidden')
    document.body.classList.add('live-panel-open')
    this.view.remountDirectory()
    if (this.bindRetryTimer) clearTimeout(this.bindRetryTimer)
    // Re-bind shortly after open so a late getLiveDirectory() still attaches.
    this.bindRetryTimer = setTimeout(() => {
      this.bindRetryTimer = null
      if (this.visible) this.view.remountDirectory()
    }, 400)
  }

  hide(): void {
    this.visible = false
    this.element.hidden = true
    this.element.setAttribute('hidden', '')
    document.body.classList.remove('live-panel-open')
    if (this.bindRetryTimer) {
      clearTimeout(this.bindRetryTimer)
      this.bindRetryTimer = null
    }
    this.options.onClose?.()
  }

  isVisible(): boolean {
    return this.visible
  }

  dispose(): void {
    if (this.bindRetryTimer) {
      clearTimeout(this.bindRetryTimer)
      this.bindRetryTimer = null
    }
    document.body.classList.remove('live-panel-open')
    this.view.dispose()
    this.element.remove()
  }
}
