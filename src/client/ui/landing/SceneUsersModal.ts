import type { RouteTarget } from '../../../dcl/content/route'
import {
  fetchSceneParticipantRows,
  type SceneParticipantRow
} from '../../../social/sceneParticipants'

const USERS_ICON = `<svg class="scene-users-modal-pill-svg" width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden><circle cx="9" cy="8" r="2.5" stroke="currentColor" stroke-width="1.5"/><path d="M4.5 17c0-2.2 2-4 4.5-4s4.5 1.8 4.5 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><circle cx="16.5" cy="9" r="2" stroke="currentColor" stroke-width="1.3"/><path d="M13.5 17c.4-1.6 1.7-2.8 3.3-2.8 1 0 1.9.4 2.5 1" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>`

export type SceneUsersModalOptions = {
  onOpenProfile?: (address: string) => void
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** Scene landing — roster of wallets currently in this place (gatekeeper scene-participants). */
export class SceneUsersModal {
  readonly root: HTMLElement

  private readonly onOpenProfile?: SceneUsersModalOptions['onOpenProfile']
  private readonly onKeyDown: (ev: KeyboardEvent) => void
  private openGen = 0
  private disposed = false

  constructor(opts: SceneUsersModalOptions = {}) {
    this.onOpenProfile = opts.onOpenProfile

    this.root = document.createElement('div')
    this.root.className = 'scene-users-modal-host'
    this.root.hidden = true

    this.onKeyDown = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') this.close()
    }
  }

  mount(): void {
    document.body.appendChild(this.root)
  }

  open(
    route: Extract<RouteTarget, { kind: 'coords' } | { kind: 'world' }>,
    sceneTitle: string,
    expectedCount: number
  ): void {
    if (this.disposed) return
    const gen = ++this.openGen
    this.root.hidden = false
    this.root.innerHTML = this.renderShell(sceneTitle, expectedCount, { loading: true })
    this.wire()
    document.addEventListener('keydown', this.onKeyDown)
    document.body.classList.add('scene-users-modal-open')
    this.root.querySelector<HTMLButtonElement>('.scene-users-modal-close')?.focus()
    void this.loadParticipants(route, sceneTitle, expectedCount, gen)
  }

  close(): void {
    this.openGen++
    this.root.hidden = true
    this.root.innerHTML = ''
    document.removeEventListener('keydown', this.onKeyDown)
    document.body.classList.remove('scene-users-modal-open')
  }

  dispose(): void {
    this.disposed = true
    this.close()
    this.root.remove()
  }

  private async loadParticipants(
    route: Extract<RouteTarget, { kind: 'coords' } | { kind: 'world' }>,
    sceneTitle: string,
    expectedCount: number,
    gen: number
  ): Promise<void> {
    try {
      const rows = await fetchSceneParticipantRows(route)
      if (this.disposed || gen !== this.openGen || this.root.hidden) return
      this.root.innerHTML = this.renderShell(sceneTitle, expectedCount, { loading: false, rows })
      this.wire()
    } catch {
      if (this.disposed || gen !== this.openGen || this.root.hidden) return
      this.root.innerHTML = this.renderShell(sceneTitle, expectedCount, {
        loading: false,
        error: 'Could not load the player list. Try again in a moment.'
      })
      this.wire()
    }
  }

  private wire(): void {
    this.root.querySelector('.scene-users-modal-backdrop')?.addEventListener('click', () => this.close())
    this.root.querySelector('.scene-users-modal-panel')?.addEventListener('click', (e) => e.stopPropagation())
    this.root.querySelector('.scene-users-modal-close')?.addEventListener('click', () => this.close())

    for (const btn of this.root.querySelectorAll<HTMLButtonElement>('[data-scene-user]')) {
      btn.addEventListener('click', () => {
        const address = btn.dataset.sceneUser?.trim()
        if (!address || !this.onOpenProfile) return
        this.close()
        this.onOpenProfile(address)
      })
    }
  }

  private renderShell(
    sceneTitle: string,
    expectedCount: number,
    state:
      | { loading: true }
      | { loading: false; rows: SceneParticipantRow[] }
      | { loading: false; error: string }
  ): string {
    const title = sceneTitle.trim() || 'This place'
    const countLabel = `${expectedCount} here now`

    let body = ''
    if ('loading' in state && state.loading) {
      body = `
        <div class="scene-users-modal-loading" aria-busy="true">
          <span class="scene-users-modal-spinner" aria-hidden></span>
          <p>Loading players…</p>
        </div>
      `
    } else if ('error' in state) {
      body = `<p class="scene-users-modal-empty">${escapeHtml(state.error)}</p>`
    } else if (state.rows.length === 0) {
      body =
        '<p class="scene-users-modal-empty">No one is listed in this scene right now. Player counts can lag behind the live roster.</p>'
    } else {
      const list = state.rows
        .map((row) => {
          const initial = row.displayName.trim().charAt(0).toUpperCase() || '?'
          const avatar = row.faceUrl
            ? `<img class="scene-users-modal-row-avatar" src="${escapeHtml(row.faceUrl)}" alt="" width="40" height="40" loading="lazy" />`
            : `<span class="scene-users-modal-row-fallback" aria-hidden>${escapeHtml(initial)}</span>`
          const profileBtn = this.onOpenProfile
            ? `<button type="button" class="scene-users-modal-row" data-scene-user="${escapeHtml(row.address)}">${avatar}<span class="scene-users-modal-row-name">${escapeHtml(row.displayName)}</span></button>`
            : `<div class="scene-users-modal-row scene-users-modal-row--static">${avatar}<span class="scene-users-modal-row-name">${escapeHtml(row.displayName)}</span></div>`
          return `<li>${profileBtn}</li>`
        })
        .join('')
      body = `<ul class="scene-users-modal-list">${list}</ul>`
    }

    return `
      <div class="scene-users-modal-backdrop" role="presentation">
        <div
          class="scene-users-modal-panel"
          role="dialog"
          aria-modal="true"
          aria-labelledby="scene-users-modal-title"
        >
          <button type="button" class="scene-users-modal-close" aria-label="Close">&times;</button>
          <header class="scene-users-modal-header">
            <h2 id="scene-users-modal-title" class="scene-users-modal-title">${escapeHtml(title)}</h2>
            <p class="scene-users-modal-subtitle">
              ${USERS_ICON}
              <span>${escapeHtml(countLabel)}</span>
            </p>
          </header>
          <div class="scene-users-modal-body">${body}</div>
        </div>
      </div>
    `
  }
}