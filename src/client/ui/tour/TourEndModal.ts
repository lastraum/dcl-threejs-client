/**
 * End Tour modal — optional CSV / ZIP export before stopping.
 */
export type TourEndModalStats = {
  communityName: string
  locationCount: number
  photoCount: number
  rosterCount: number
  durationSec: number
}

export type TourEndModalOptions = {
  getStats: () => TourEndModalStats
  onDownloadCsv: () => void | Promise<void>
  onDownloadZip: () => void | Promise<void>
  onEndWithoutDownload: () => void | Promise<void>
  onCancel: () => void
}

export class TourEndModal {
  readonly root: HTMLElement
  private readonly opts: TourEndModalOptions
  private disposed = false
  private busy = false
  private readonly onKey: (e: KeyboardEvent) => void

  constructor(opts: TourEndModalOptions) {
    this.opts = opts
    this.root = document.createElement('div')
    this.root.className = 'tour-end-modal-host'
    this.root.innerHTML = this.renderBody()
    document.body.appendChild(this.root)
    this.bind()
    this.onKey = (e) => {
      if (e.key === 'Escape' && !this.busy) this.opts.onCancel()
    }
    window.addEventListener('keydown', this.onKey, true)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    window.removeEventListener('keydown', this.onKey, true)
    this.root.remove()
  }

  private renderBody(): string {
    const st = this.opts.getStats()
    const mins = Math.floor(st.durationSec / 60)
    const secs = st.durationSec % 60
    const dur = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`
    return `
      <div class="tour-end-modal-backdrop" data-tour-end-cancel></div>
      <div class="tour-end-modal" role="dialog" aria-label="End tour">
        <div class="tour-end-modal-head">
          <h3 class="tour-end-modal-title">End tour</h3>
          <button type="button" class="tour-end-modal-close" data-tour-end-cancel aria-label="Cancel">&times;</button>
        </div>
        <p class="tour-end-modal-hint">
          ${escapeHtml(st.communityName || 'Tour')} · ${dur} · ${st.locationCount} stop${st.locationCount === 1 ? '' : 's'} ·
          ${st.photoCount} photo${st.photoCount === 1 ? '' : 's'} · ${st.rosterCount} on tour
        </p>
        <div class="tour-end-modal-actions">
          <button type="button" class="tour-options-popup-btn tour-options-popup-btn--primary" data-tour-end-zip>
            Download locations + images (ZIP)
          </button>
          <button type="button" class="tour-options-popup-btn" data-tour-end-csv>
            Download locations (CSV only)
          </button>
          <button type="button" class="tour-options-popup-btn tour-options-popup-btn--danger" data-tour-end-skip>
            End without download
          </button>
          <button type="button" class="tour-options-popup-btn" data-tour-end-cancel>
            Cancel
          </button>
        </div>
        <p class="tour-end-modal-status" data-tour-end-status hidden></p>
      </div>
    `
  }

  private setStatus(text: string | null): void {
    const el = this.root.querySelector<HTMLElement>('[data-tour-end-status]')
    if (!el) return
    if (!text) {
      el.hidden = true
      el.textContent = ''
      return
    }
    el.hidden = false
    el.textContent = text
  }

  private bind(): void {
    const run = async (fn: () => void | Promise<void>, label: string) => {
      if (this.busy || this.disposed) return
      this.busy = true
      this.setStatus(label)
      try {
        await fn()
      } catch (err) {
        console.warn('[tour] export failed', err)
        this.setStatus('Export failed — try again or end without download')
        this.busy = false
        return
      }
      this.busy = false
    }

    this.root.querySelectorAll('[data-tour-end-cancel]').forEach((el) => {
      el.addEventListener('click', () => {
        if (!this.busy) this.opts.onCancel()
      })
    })
    this.root.querySelector('[data-tour-end-csv]')?.addEventListener('click', () => {
      void run(async () => {
        await this.opts.onDownloadCsv()
        await this.opts.onEndWithoutDownload()
      }, 'Building CSV…')
    })
    this.root.querySelector('[data-tour-end-zip]')?.addEventListener('click', () => {
      void run(async () => {
        await this.opts.onDownloadZip()
        await this.opts.onEndWithoutDownload()
      }, 'Building ZIP…')
    })
    this.root.querySelector('[data-tour-end-skip]')?.addEventListener('click', () => {
      void run(() => this.opts.onEndWithoutDownload(), 'Ending tour…')
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
