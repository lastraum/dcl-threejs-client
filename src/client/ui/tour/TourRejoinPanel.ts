/**
 * Side panel next to the Tour Options (flag) HUD icon — leader resume after disconnect.
 */
import { followTargetLabel, type FollowTarget } from '../../../social/communityFollowWire'

export type TourRejoinPanelState = {
  communityName?: string | null
  lastTarget: FollowTarget | null
}

export type TourRejoinPanelOptions = {
  getState: () => TourRejoinPanelState
  /** Anchor next to the tour-options sidebar button. */
  anchor: () => HTMLElement | undefined
  onRejoin: () => void | Promise<void>
  onCancel: () => void | Promise<void>
  onClose?: () => void
}

export class TourRejoinPanel {
  readonly root: HTMLElement
  private readonly opts: TourRejoinPanelOptions
  private disposed = false
  private busy = false
  private readonly onKey: (e: KeyboardEvent) => void
  private readonly onResize: () => void

  constructor(opts: TourRejoinPanelOptions) {
    this.opts = opts
    this.root = document.createElement('div')
    this.root.className = 'tour-rejoin-panel'
    this.root.setAttribute('role', 'dialog')
    this.root.setAttribute('aria-label', 'Rejoin tour')
    this.root.innerHTML = this.renderBody()
    document.body.appendChild(this.root)
    this.bind()
    this.position()
    this.onKey = (e) => {
      if (e.key === 'Escape' && !this.busy) void this.opts.onCancel()
    }
    this.onResize = () => this.position()
    window.addEventListener('keydown', this.onKey, true)
    window.addEventListener('resize', this.onResize)
    // Re-position after layout settles.
    requestAnimationFrame(() => this.position())
  }

  refresh(): void {
    if (this.disposed) return
    this.root.innerHTML = this.renderBody()
    this.bind()
    this.position()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    window.removeEventListener('keydown', this.onKey, true)
    window.removeEventListener('resize', this.onResize)
    this.root.remove()
    this.opts.onClose?.()
  }

  private renderBody(): string {
    const st = this.opts.getState()
    const place = followTargetLabel(st.lastTarget) || 'last stop'
    const title = st.communityName?.trim()
      ? `Resume tour · ${escapeHtml(st.communityName.trim())}`
      : 'Resume tour'
    return `
      <div class="tour-rejoin-panel__card">
        <div class="tour-rejoin-panel__kicker">Tour leader</div>
        <div class="tour-rejoin-panel__title">${title}</div>
        <p class="tour-rejoin-panel__hint">
          You disconnected while leading. Rejoin to continue and jump to
          <strong>${escapeHtml(place)}</strong>, or cancel to end the tour for everyone.
        </p>
        <div class="tour-rejoin-panel__actions">
          <button type="button" class="tour-rejoin-panel__btn tour-rejoin-panel__btn--primary" data-rejoin>
            Rejoin tour
          </button>
          <button type="button" class="tour-rejoin-panel__btn tour-rejoin-panel__btn--ghost" data-cancel>
            Cancel
          </button>
        </div>
      </div>
    `
  }

  private bind(): void {
    this.root.querySelector('[data-rejoin]')?.addEventListener('click', () => {
      if (this.busy) return
      this.busy = true
      this.setBusyUi(true)
      void Promise.resolve(this.opts.onRejoin()).finally(() => {
        this.busy = false
        this.setBusyUi(false)
      })
    })
    this.root.querySelector('[data-cancel]')?.addEventListener('click', () => {
      if (this.busy) return
      this.busy = true
      this.setBusyUi(true)
      void Promise.resolve(this.opts.onCancel()).finally(() => {
        this.busy = false
        this.setBusyUi(false)
      })
    })
  }

  private setBusyUi(busy: boolean): void {
    this.root.querySelectorAll('button').forEach((b) => {
      ;(b as HTMLButtonElement).disabled = busy
    })
  }

  private position(): void {
    if (this.disposed) return
    const anchor = this.opts.anchor()
    // Hidden tour-options button still has a layout box once setTourOptionsVisible(true).
    const rect = anchor && !anchor.hidden ? anchor.getBoundingClientRect() : null
    if (rect && rect.width > 0 && rect.height > 0) {
      const gap = 10
      const panelW = this.root.offsetWidth || 280
      const panelH = this.root.offsetHeight || 180
      // Prefer to the right of the flag icon; flip left if near viewport edge.
      let left = rect.right + gap
      if (left + panelW > window.innerWidth - 8) {
        left = Math.max(8, rect.left - gap - panelW)
      }
      let top = rect.top
      if (top + panelH > window.innerHeight - 8) {
        top = Math.max(8, window.innerHeight - panelH - 8)
      }
      this.root.style.top = `${top}px`
      this.root.style.left = `${left}px`
      this.root.style.right = 'auto'
      this.root.classList.remove('tour-rejoin-panel--fallback')
      return
    }
    // Fallback: dock just right of the left client rail (same row as tour-options).
    this.root.style.top = 'max(72px, calc(var(--client-safe-top, 12px) + 48px))'
    this.root.style.left = 'calc(var(--client-safe-left, 56px) + 12px)'
    this.root.style.right = 'auto'
    this.root.classList.add('tour-rejoin-panel--fallback')
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
