/**
 * Leader Tour Options — center modal (~2×), tabs: Users · Locations · Settings.
 */
import type { TourLocationWire } from '../../../social/communityFollowWire'
import { followTargetLabel } from '../../../social/communityFollowWire'

export type TourRosterPerson = {
  address: string
  displayName: string
  faceUrl?: string | null
  isLeader: boolean
}

export type TourLocationRow = TourLocationWire & {
  /** Local photo thumbnail data URL (leader only). */
  photoThumb?: string | null
}

export type TourOptionsPopupState = {
  isLeading: boolean
  flagEnabled: boolean
  focusActive: boolean
  communityName?: string | null
  roster: TourRosterPerson[]
  locations: TourLocationRow[]
  /** Location waiting for next Camera Reel shutter. */
  photoBindLocationId?: string | null
}

export type TourOptionsPopupOptions = {
  getState: () => TourOptionsPopupState
  onEnableFlag: () => void
  onDisableFlag: () => void | Promise<void>
  onToggleFocus?: (on: boolean) => void | Promise<void>
  /** Opens End Tour modal (does not stop immediately). */
  onRequestEndTour?: () => void
  onClose: () => void
  resolveFaceUrl?: (address: string) => Promise<string | null>
  onAddLocation?: () => void | Promise<void>
  onRemoveLocation?: (locationId: string) => void | Promise<void>
  onRenameLocation?: (locationId: string, name: string) => void | Promise<void>
  /** Select row and open photo mode; next shutter binds to this id. */
  onAddPhoto?: (locationId: string) => void | Promise<void>
}

type TabId = 'users' | 'locations' | 'settings'

export class TourOptionsPopup {
  readonly root: HTMLElement
  private readonly opts: TourOptionsPopupOptions
  private disposed = false
  private tab: TabId = 'users'
  private faceCache = new Map<string, string | null>()
  private readonly onDocDown: (e: MouseEvent) => void
  private readonly onKey: (e: KeyboardEvent) => void

  constructor(opts: TourOptionsPopupOptions) {
    this.opts = opts
    this.root = document.createElement('div')
    this.root.className = 'tour-options-popup-host tour-options-popup-host--v2'
    this.root.innerHTML = this.renderBody()
    document.body.appendChild(this.root)
    this.bind()
    this.onDocDown = (e) => {
      const panel = this.root.querySelector('.tour-options-popup')
      if (panel && !panel.contains(e.target as Node)) this.opts.onClose()
    }
    this.onKey = (e) => {
      if (e.key === 'Escape') this.opts.onClose()
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
    const title = st.communityName?.trim()
      ? `Tour Options · ${escapeHtml(st.communityName.trim())}`
      : 'Tour Options'
    return `
      <div class="tour-options-popup-backdrop" data-tour-opt-close></div>
      <div class="tour-options-popup tour-options-popup--v2" role="dialog" aria-label="Tour Options">
        <div class="tour-options-popup-head">
          <h3 class="tour-options-popup-title">${title}</h3>
          <button type="button" class="tour-options-popup-close" data-tour-opt-close aria-label="Close">&times;</button>
        </div>
        ${
          st.isLeading
            ? `<div class="tour-options-tabs" role="tablist">
                ${this.tabBtn('users', 'Users', st.roster.length)}
                ${this.tabBtn('locations', 'Locations', st.locations.length)}
                ${this.tabBtn('settings', 'Settings')}
              </div>
              <div class="tour-options-tab-body">
                ${
                  this.tab === 'users'
                    ? this.renderUsers(st)
                    : this.tab === 'locations'
                      ? this.renderLocations(st)
                      : this.renderSettings(st)
                }
              </div>`
            : `<p class="tour-options-popup-hint">Start a tour from a community you own (under Voice Stream).</p>`
        }
      </div>
    `
  }

  private tabBtn(id: TabId, label: string, count?: number): string {
    const active = this.tab === id ? ' tour-options-tab--active' : ''
    const badge =
      count != null ? `<span class="tour-options-tab-badge">${count}</span>` : ''
    return `<button type="button" role="tab" class="tour-options-tab${active}" data-tour-tab="${id}">
      ${escapeHtml(label)}${badge}
    </button>`
  }

  private renderUsers(st: TourOptionsPopupState): string {
    if (!st.roster.length) {
      return `<p class="tour-options-popup-hint">No one on the tour yet — share the community chat Follow CTA.</p>`
    }
    const rows = st.roster
      .map((p) => {
        const cached = this.faceCache.get(p.address.toLowerCase())
        const face = cached ?? p.faceUrl
        const initial = (p.displayName.trim().charAt(0) || '?').toUpperCase()
        const badge = p.isLeader
          ? `<span class="tour-options-popup-user-badge">Leader</span>`
          : ''
        return `
          <div class="tour-options-popup-user-row">
            <span class="tour-options-popup-user-avatar">
              ${
                face
                  ? `<img src="${escapeHtml(face)}" alt="" width="36" height="36" />`
                  : `<span class="tour-options-popup-user-fallback" aria-hidden>${escapeHtml(initial)}</span>`
              }
            </span>
            <span class="tour-options-popup-user-meta">
              <span class="tour-options-popup-user-name">${escapeHtml(p.displayName)}${badge}</span>
              <span class="tour-options-popup-user-addr">${escapeHtml(shortAddr(p.address))}</span>
            </span>
            <button type="button" class="tour-options-popup-copy" data-copy-addr="${escapeHtml(p.address)}">Copy</button>
          </div>`
      })
      .join('')
    return `<div class="tour-options-popup-user-list">${rows}</div>`
  }

  private renderLocations(st: TourOptionsPopupState): string {
    const rows =
      st.locations.length === 0
        ? `<p class="tour-options-popup-hint">No stops yet. Pin your current place, then optionally add a photo via Camera Reel.</p>`
        : st.locations
            .map((loc) => {
              const label = loc.name?.trim() || loc.sceneName
              const coords = followTargetLabel(loc.target)
              const dwell =
                loc.dwellSec != null && loc.dwellSec > 0 ? ` · ${loc.dwellSec}s` : ''
              const people = loc.people != null ? ` · ${loc.people} ppl` : ''
              const binding =
                st.photoBindLocationId === loc.id
                  ? `<span class="tour-loc-binding">Waiting for Camera Reel shot…</span>`
                  : ''
              const thumb = loc.photoThumb
                ? `<img class="tour-loc-thumb" src="${escapeHtml(loc.photoThumb)}" alt="" />`
                : `<span class="tour-loc-thumb tour-loc-thumb--empty" aria-hidden></span>`
              return `
                <div class="tour-loc-row" data-loc-id="${escapeHtml(loc.id)}">
                  ${thumb}
                  <div class="tour-loc-meta">
                    <input class="tour-loc-name" data-loc-rename="${escapeHtml(loc.id)}"
                      value="${escapeHtml(label)}" title="Rename stop" />
                    <span class="tour-loc-sub">${escapeHtml(coords)}${dwell}${people}</span>
                    ${binding}
                  </div>
                  <div class="tour-loc-actions">
                    <button type="button" class="tour-options-popup-btn tour-loc-btn" data-loc-photo="${escapeHtml(loc.id)}"
                      title="Open Camera Reel; next shot attaches here">Photo</button>
                    <button type="button" class="tour-loc-trash" data-loc-trash="${escapeHtml(loc.id)}" title="Remove">🗑</button>
                  </div>
                </div>`
            })
            .join('')

    return `
      <div class="tour-loc-toolbar">
        <button type="button" class="tour-options-popup-btn tour-options-popup-btn--primary" data-tour-add-loc>
          Add location
        </button>
      </div>
      <div class="tour-loc-list">${rows}</div>
    `
  }

  private renderSettings(st: TourOptionsPopupState): string {
    return `
      <div class="tour-options-popup-actions">
        ${
          st.flagEnabled
            ? `<button type="button" class="tour-options-popup-btn tour-options-popup-btn--danger" data-tour-opt-disable-flag>
                Disable flag image
              </button>`
            : `<button type="button" class="tour-options-popup-btn tour-options-popup-btn--primary" data-tour-opt-enable-flag>
                Enable flag image
              </button>`
        }
        ${
          st.focusActive
            ? `<button type="button" class="tour-options-popup-btn tour-options-popup-btn--focus-on" data-tour-opt-focus-off>
                Focus camera · ON
              </button>`
            : `<button type="button" class="tour-options-popup-btn" data-tour-opt-focus-on>
                Focus camera
              </button>`
        }
        <button type="button" class="tour-options-popup-btn tour-options-popup-btn--danger" data-tour-opt-stop-tour>
          End tour…
        </button>
      </div>
      <p class="tour-options-popup-hint">Flag appears as a circular badge above your nametag for followers.</p>
    `
  }

  private bind(): void {
    this.root.querySelectorAll('[data-tour-opt-close]').forEach((el) => {
      el.addEventListener('click', () => this.opts.onClose())
    })
    this.root.querySelectorAll<HTMLButtonElement>('[data-tour-tab]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const t = btn.dataset.tourTab as TabId
        if (t === 'users' || t === 'locations' || t === 'settings') {
          this.tab = t
          this.refresh()
        }
      })
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
      this.opts.onRequestEndTour?.()
    })
    this.root.querySelector('[data-tour-add-loc]')?.addEventListener('click', () => {
      void this.opts.onAddLocation?.()
    })
    this.root.querySelectorAll<HTMLButtonElement>('[data-loc-trash]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.locTrash
        if (id) void this.opts.onRemoveLocation?.(id)
      })
    })
    this.root.querySelectorAll<HTMLButtonElement>('[data-loc-photo]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.locPhoto
        if (id) void this.opts.onAddPhoto?.(id)
      })
    })
    this.root.querySelectorAll<HTMLInputElement>('[data-loc-rename]').forEach((input) => {
      const commit = () => {
        const id = input.dataset.locRename
        if (id) void this.opts.onRenameLocation?.(id, input.value)
      }
      input.addEventListener('change', commit)
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          commit()
          input.blur()
        }
      })
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
            /* ignore */
          }
        )
      })
    })
  }

  private async hydrateFaces(): Promise<void> {
    if (!this.opts.resolveFaceUrl || this.disposed || this.tab !== 'users') return
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
    if (changed && !this.disposed && this.tab === 'users') this.refresh()
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
