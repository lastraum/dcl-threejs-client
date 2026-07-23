/**
 * Sidebar Tour Options popup — enable/disable flag and related tour tools.
 */
export type TourOptionsPopupState = {
  isLeading: boolean
  flagEnabled: boolean
  communityName?: string | null
}

export type TourOptionsPopupOptions = {
  getState: () => TourOptionsPopupState
  onEnableFlag: () => void
  onDisableFlag: () => void | Promise<void>
  onStopTour?: () => void | Promise<void>
  onClose: () => void
}

export class TourOptionsPopup {
  readonly root: HTMLElement
  private readonly opts: TourOptionsPopupOptions
  private disposed = false
  private readonly onDocDown: (e: MouseEvent) => void
  private readonly onKey: (e: KeyboardEvent) => void

  constructor(opts: TourOptionsPopupOptions) {
    this.opts = opts
    this.root = document.createElement('div')
    this.root.className = 'tour-options-popup-host'
    this.root.innerHTML = this.renderBody()
    document.body.appendChild(this.root)
    this.bind()
    this.onDocDown = (e) => {
      if (!this.root.contains(e.target as Node)) this.opts.onClose()
    }
    this.onKey = (e) => {
      if (e.key === 'Escape') this.opts.onClose()
    }
    // Next tick so the open click doesn't immediately close.
    queueMicrotask(() => {
      if (this.disposed) return
      document.addEventListener('mousedown', this.onDocDown, true)
      window.addEventListener('keydown', this.onKey, true)
    })
  }

  refresh(): void {
    if (this.disposed) return
    const body = this.root.querySelector('.tour-options-popup')
    if (!body) return
    this.root.innerHTML = this.renderBody()
    this.bind()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    document.removeEventListener('mousedown', this.onDocDown, true)
    window.removeEventListener('keydown', this.onKey, true)
    this.root.remove()
  }

  private renderBody(): string {
    const st = this.opts.getState()
    const title = st.communityName?.trim()
      ? `Tour Options · ${escapeHtml(st.communityName.trim())}`
      : 'Tour Options'
    const leadingHint = st.isLeading
      ? 'You are leading a tour.'
      : 'Start a tour from a community you own (under Voice Stream).'
    return `
      <div class="tour-options-popup" role="dialog" aria-label="Tour Options">
        <div class="tour-options-popup-head">
          <h3 class="tour-options-popup-title">${title}</h3>
          <button type="button" class="tour-options-popup-close" data-tour-opt-close aria-label="Close">&times;</button>
        </div>
        <p class="tour-options-popup-hint">${leadingHint}</p>
        <div class="tour-options-popup-actions">
          ${
            st.flagEnabled
              ? `<button type="button" class="tour-options-popup-btn tour-options-popup-btn--danger" data-tour-opt-disable-flag>
                  Disable flag
                </button>`
              : `<button type="button" class="tour-options-popup-btn tour-options-popup-btn--primary" data-tour-opt-enable-flag
                  ${st.isLeading ? '' : 'disabled'}
                  title="${st.isLeading ? 'Upload a banner for your spine flag' : 'Start a tour first'}">
                  Enable flag
                </button>`
          }
          ${
            st.isLeading
              ? `<button type="button" class="tour-options-popup-btn" data-tour-opt-stop-tour>Stop tour</button>`
              : ''
          }
        </div>
      </div>
    `
  }

  private bind(): void {
    this.root.querySelector('[data-tour-opt-close]')?.addEventListener('click', () => {
      this.opts.onClose()
    })
    this.root.querySelector('[data-tour-opt-enable-flag]')?.addEventListener('click', () => {
      this.opts.onEnableFlag()
    })
    this.root.querySelector('[data-tour-opt-disable-flag]')?.addEventListener('click', () => {
      void this.opts.onDisableFlag()
    })
    this.root.querySelector('[data-tour-opt-stop-tour]')?.addEventListener('click', () => {
      void this.opts.onStopTour?.()
    })
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
