/**
 * Shared Live list + Go Live form (2D page content and 3D panel body).
 */

import type { LiveDirectoryController } from '../../../social/LiveDirectoryController'
import type { LiveSession } from '../../../social/globalLiveWire'

export type LiveDirectoryViewOptions = {
  getDirectory: () => LiveDirectoryController | null
  onWatch: (session: LiveSession) => void
  compact?: boolean
}

export class LiveDirectoryView {
  readonly root: HTMLElement
  private unsub: (() => void) | null = null
  private readonly listEl: HTMLElement
  private readonly emptyEl: HTMLElement
  private readonly statusEl: HTMLElement
  private readonly formEl: HTMLFormElement
  private readonly urlInput: HTMLInputElement
  private readonly titleInput: HTMLInputElement
  private readonly goLiveBtn: HTMLButtonElement
  private readonly endLiveBtn: HTMLButtonElement
  private readonly formError: HTMLElement

  constructor(private readonly options: LiveDirectoryViewOptions) {
    this.root = document.createElement('div')
    this.root.className = options.compact ? 'live-dir live-dir--compact' : 'live-dir'
    this.root.innerHTML = `
      <section class="live-dir__broadcast" data-broadcast>
        <h2 class="live-dir__h">Go Live</h2>
        <p class="live-dir__hint">Keep this client open (2D is fine). Paste a <strong>playable</strong> stream URL — HLS (.m3u8) or https video. OBS/publish keys stay private.</p>
        <form class="live-dir__form" data-form>
          <label class="live-dir__label">Playback URL
            <input class="live-dir__input" data-url type="url" required placeholder="https://…/live.m3u8" autocomplete="off" />
          </label>
          <label class="live-dir__label">Title (optional)
            <input class="live-dir__input" data-title type="text" maxlength="80" placeholder="My stream" />
          </label>
          <div class="live-dir__actions">
            <button type="submit" class="live-dir__btn live-dir__btn--primary" data-go>Go Live</button>
            <button type="button" class="live-dir__btn" data-end hidden>End Live</button>
          </div>
          <p class="live-dir__error" data-form-error hidden></p>
        </form>
      </section>
      <section class="live-dir__list-wrap">
        <div class="live-dir__list-head">
          <h2 class="live-dir__h">Live now</h2>
          <p class="live-dir__status" data-status></p>
        </div>
        <div class="live-dir__list" data-list></div>
        <p class="live-dir__empty" data-empty>No one is live yet — be the first.</p>
      </section>
    `
    this.listEl = this.root.querySelector('[data-list]')!
    this.emptyEl = this.root.querySelector('[data-empty]')!
    this.statusEl = this.root.querySelector('[data-status]')!
    this.formEl = this.root.querySelector('[data-form]')!
    this.urlInput = this.root.querySelector('[data-url]')!
    this.titleInput = this.root.querySelector('[data-title]')!
    this.goLiveBtn = this.root.querySelector('[data-go]')!
    this.endLiveBtn = this.root.querySelector('[data-end]')!
    this.formError = this.root.querySelector('[data-form-error]')!

    this.formEl.addEventListener('submit', (ev) => {
      ev.preventDefault()
      void this.onGoLive()
    })
    this.endLiveBtn.addEventListener('click', () => {
      void this.onEndLive()
    })
  }

  mount(): void {
    this.bindDirectory()
  }

  remountDirectory(): void {
    this.bindDirectory()
  }

  dispose(): void {
    this.unsub?.()
    this.unsub = null
    this.root.remove()
  }

  private bindDirectory(): void {
    this.unsub?.()
    this.unsub = null
    const dir = this.options.getDirectory()
    if (!dir) {
      this.render([])
      this.statusEl.textContent = 'Connect with a wallet to see live streams'
      return
    }
    this.unsub = dir.subscribe((sessions) => this.render(sessions))
    this.syncBroadcastUi()
  }

  private render(sessions: readonly LiveSession[]): void {
    this.listEl.innerHTML = ''
    this.statusEl.textContent =
      sessions.length === 0 ? '' : `${sessions.length} live`
    this.emptyEl.hidden = sessions.length > 0
    for (const s of sessions) {
      const row = document.createElement('button')
      row.type = 'button'
      row.className = 'live-dir__row'
      if (s.isSelf) row.classList.add('is-self')
      row.innerHTML = `
        <span class="live-dir__dot" aria-hidden="true"></span>
        <span class="live-dir__meta">
          <span class="live-dir__name"></span>
          <span class="live-dir__sub"></span>
        </span>
        <span class="live-dir__watch">Watch</span>
      `
      row.querySelector('.live-dir__name')!.textContent = s.displayName
      row.querySelector('.live-dir__sub')!.textContent = s.isSelf
        ? `${s.title} · you`
        : s.title
      row.addEventListener('click', () => this.options.onWatch(s))
      this.listEl.appendChild(row)
    }
    this.syncBroadcastUi()
  }

  private syncBroadcastUi(): void {
    const dir = this.options.getDirectory()
    const live = dir?.isBroadcasting() === true
    this.goLiveBtn.hidden = live
    this.endLiveBtn.hidden = !live
    this.urlInput.disabled = live
    this.titleInput.disabled = live
    if (live) {
      this.goLiveBtn.textContent = 'Live…'
    } else {
      this.goLiveBtn.textContent = 'Go Live'
    }
  }

  private async onGoLive(): Promise<void> {
    this.formError.hidden = true
    const dir = this.options.getDirectory()
    if (!dir) {
      this.showFormError('Sign in to go live')
      return
    }
    this.goLiveBtn.disabled = true
    const result = await dir.goLive(this.urlInput.value, this.titleInput.value)
    this.goLiveBtn.disabled = false
    if (!result.ok) {
      this.showFormError(result.error)
      return
    }
    this.syncBroadcastUi()
  }

  private async onEndLive(): Promise<void> {
    const dir = this.options.getDirectory()
    await dir?.endLive()
    this.syncBroadcastUi()
  }

  private showFormError(msg: string): void {
    this.formError.textContent = msg
    this.formError.hidden = false
  }
}
