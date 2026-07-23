/**
 * Sidebar Tour Options popup — flag tools + tour roster (leader view).
 */
export type TourRosterPerson = {
  address: string
  displayName: string
  faceUrl?: string | null
  isLeader: boolean
}

export type TourOptionsPopupState = {
  isLeading: boolean
  flagEnabled: boolean
  /** Leader Tour Focus — take over follower cameras. */
  focusActive: boolean
  communityName?: string | null
  /** Leader + followers (leader first). */
  roster: TourRosterPerson[]
}

export type TourOptionsPopupOptions = {
  getState: () => TourOptionsPopupState
  onEnableFlag: () => void
  onDisableFlag: () => void | Promise<void>
  /** Leader toggle Tour Focus on/off. */
  onToggleFocus?: (on: boolean) => void | Promise<void>
  onStopTour?: () => void | Promise<void>
  onClose: () => void
  /** Optional async face URL resolver after open. */
  resolveFaceUrl?: (address: string) => Promise<string | null>
}

type PanelView = 'main' | 'users'

export class TourOptionsPopup {
  readonly root: HTMLElement
  private readonly opts: TourOptionsPopupOptions
  private disposed = false
  private view: PanelView = 'main'
  private faceCache = new Map<string, string | null>()
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
      if (e.key === 'Escape') {
        if (this.view === 'users') {
          this.view = 'main'
          this.refresh()
          return
        }
        this.opts.onClose()
      }
    }
    queueMicrotask(() => {
      if (this.disposed) return
      document.addEventListener('mousedown', this.onDocDown, true)
      window.addEventListener('keydown', this.onKey, true)
    })
    void this.hydrateFaces()
  }

  refresh(): void {
    if (this.disposed) return
    this.root.innerHTML = this.renderBody()
    this.bind()
    void this.hydrateFaces()
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
    if (this.view === 'users') {
      return this.renderUsersView(st)
    }
    return this.renderMainView(st)
  }

  private renderMainView(st: TourOptionsPopupState): string {
    const title = st.communityName?.trim()
      ? `Tour Options · ${escapeHtml(st.communityName.trim())}`
      : 'Tour Options'
    const count = st.roster.length
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
        ${
          st.isLeading
            ? `<button type="button" class="tour-options-popup-count" data-tour-opt-users title="View people on this tour">
                <span class="tour-options-popup-count-icon" aria-hidden>👥</span>
                <span class="tour-options-popup-count-label">${count} on tour</span>
                <span class="tour-options-popup-count-chevron" aria-hidden>›</span>
              </button>`
            : ''
        }
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
              ? st.focusActive
                ? `<button type="button" class="tour-options-popup-btn tour-options-popup-btn--focus-on" data-tour-opt-focus-off
                    title="Release follower cameras">
                    Focus camera · ON
                  </button>`
                : `<button type="button" class="tour-options-popup-btn" data-tour-opt-focus-on
                    title="Take over followers' cameras with your POV (incl. FOV)">
                    Focus camera
                  </button>`
              : ''
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

  private renderUsersView(st: TourOptionsPopupState): string {
    const rows =
      st.roster.length === 0
        ? `<p class="tour-options-popup-hint">No one on the tour yet.</p>`
        : st.roster
            .map((p) => {
              const cached = this.faceCache.get(p.address.toLowerCase())
              const face = cached ?? p.faceUrl
              const initial = (p.displayName.trim().charAt(0) || '?').toUpperCase()
              const badge = p.isLeader
                ? `<span class="tour-options-popup-user-badge">Leader</span>`
                : ''
              return `
                <div class="tour-options-popup-user-row" data-user-addr="${escapeHtml(p.address)}">
                  <span class="tour-options-popup-user-avatar">
                    ${
                      face
                        ? `<img src="${escapeHtml(face)}" alt="" width="32" height="32" />`
                        : `<span class="tour-options-popup-user-fallback" aria-hidden>${escapeHtml(initial)}</span>`
                    }
                  </span>
                  <span class="tour-options-popup-user-meta">
                    <span class="tour-options-popup-user-name">${escapeHtml(p.displayName)}${badge}</span>
                    <span class="tour-options-popup-user-addr">${escapeHtml(shortAddr(p.address))}</span>
                  </span>
                  <button type="button" class="tour-options-popup-copy" data-copy-addr="${escapeHtml(p.address)}" title="Copy wallet">
                    Copy
                  </button>
                </div>`
            })
            .join('')

    return `
      <div class="tour-options-popup tour-options-popup--users" role="dialog" aria-label="Tour users">
        <div class="tour-options-popup-head">
          <button type="button" class="tour-options-popup-back" data-tour-opt-back aria-label="Back">‹</button>
          <h3 class="tour-options-popup-title">On tour · ${st.roster.length}</h3>
          <button type="button" class="tour-options-popup-close" data-tour-opt-close aria-label="Close">&times;</button>
        </div>
        <div class="tour-options-popup-user-list">
          ${rows}
        </div>
      </div>
    `
  }

  private bind(): void {
    this.root.querySelector('[data-tour-opt-close]')?.addEventListener('click', () => {
      this.opts.onClose()
    })
    this.root.querySelector('[data-tour-opt-back]')?.addEventListener('click', () => {
      this.view = 'main'
      this.refresh()
    })
    this.root.querySelector('[data-tour-opt-users]')?.addEventListener('click', () => {
      this.view = 'users'
      this.refresh()
    })
    this.root.querySelector('[data-tour-opt-enable-flag]')?.addEventListener('click', () => {
      this.opts.onEnableFlag()
    })
    this.root.querySelector('[data-tour-opt-disable-flag]')?.addEventListener('click', () => {
      void this.opts.onDisableFlag()
    })
    this.root.querySelector('[data-tour-opt-focus-on]')?.addEventListener('click', () => {
      void this.opts.onToggleFocus?.(true)
    })
    this.root.querySelector('[data-tour-opt-focus-off]')?.addEventListener('click', () => {
      void this.opts.onToggleFocus?.(false)
    })
    this.root.querySelector('[data-tour-opt-stop-tour]')?.addEventListener('click', () => {
      void this.opts.onStopTour?.()
    })
    this.root.querySelectorAll<HTMLButtonElement>('[data-copy-addr]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const addr = btn.dataset.copyAddr
        if (!addr) return
        void navigator.clipboard?.writeText(addr).then(
          () => {
            const prev = btn.textContent
            btn.textContent = 'Copied'
            window.setTimeout(() => {
              btn.textContent = prev
            }, 1200)
          },
          () => {
            btn.textContent = 'Fail'
            window.setTimeout(() => {
              btn.textContent = 'Copy'
            }, 1200)
          }
        )
      })
    })
  }

  private async hydrateFaces(): Promise<void> {
    if (!this.opts.resolveFaceUrl || this.disposed) return
    const st = this.opts.getState()
    let changed = false
    await Promise.all(
      st.roster.map(async (p) => {
        const key = p.address.toLowerCase()
        if (this.faceCache.has(key) || p.faceUrl) {
          if (p.faceUrl && !this.faceCache.has(key)) this.faceCache.set(key, p.faceUrl)
          return
        }
        try {
          const url = await this.opts.resolveFaceUrl!(p.address)
          this.faceCache.set(key, url)
          if (url) changed = true
        } catch {
          this.faceCache.set(key, null)
        }
      })
    )
    if (changed && !this.disposed && this.view === 'users') {
      this.refresh()
    }
  }
}

function shortAddr(address: string): string {
  const a = address.trim()
  if (a.length < 12) return a
  return `${a.slice(0, 6)}…${a.slice(-4)}`
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
