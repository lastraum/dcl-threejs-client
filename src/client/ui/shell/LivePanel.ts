import type { LoginResult } from '../../../auth/AuthClient'
import type { LiveDirectoryController } from '../../../social/LiveDirectoryController'
import type { LiveSession } from '../../../social/globalLiveWire'
import { LiveDirectoryView } from '../live/LiveDirectoryView'

export type LivePanelOptions = {
  anchor: () => HTMLElement | undefined
  getDirectory: () => LiveDirectoryController | null
  getLogin?: () => LoginResult | null
  onWatch: (session: LiveSession) => void
  onClose?: () => void
}

/** 3D HUD Live popover — directory + Go Live. */
export class LivePanel {
  readonly element: HTMLDivElement
  private readonly view: LiveDirectoryView
  private visible = false

  constructor(private readonly options: LivePanelOptions) {
    this.element = document.createElement('div')
    this.element.className = 'live-panel'
    this.element.hidden = true
    this.element.innerHTML = `
      <header class="live-panel__header">LIVE</header>
      <div class="live-panel__body" data-body></div>
    `
    this.view = new LiveDirectoryView({
      getDirectory: () => this.options.getDirectory(),
      getLogin: () => this.options.getLogin?.() ?? null,
      onWatch: (s) => {
        this.options.onWatch(s)
        // Keep panel open so user can open another stream or end live.
      },
      compact: true
    })
    this.element.querySelector('[data-body]')!.appendChild(this.view.root)
    document.body.appendChild(this.element)
  }

  toggle(): void {
    if (this.visible) this.hide()
    else this.show()
  }

  show(): void {
    this.visible = true
    this.element.hidden = false
    this.view.remountDirectory()
    this.position()
  }

  hide(): void {
    this.visible = false
    this.element.hidden = true
    this.options.onClose?.()
  }

  isVisible(): boolean {
    return this.visible
  }

  private position(): void {
    const anchor = this.options.anchor()
    if (!anchor) return
    const rect = anchor.getBoundingClientRect()
    const panelW = this.element.offsetWidth || 320
    const left = Math.min(window.innerWidth - panelW - 12, rect.right + 10)
    const top = Math.max(12, rect.top)
    this.element.style.left = `${left}px`
    this.element.style.top = `${top}px`
  }

  dispose(): void {
    this.view.dispose()
    this.element.remove()
  }
}
