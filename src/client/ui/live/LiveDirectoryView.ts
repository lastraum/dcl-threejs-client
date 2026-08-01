/**
 * Shared Live list + Go Live (single CTA → modal with m3u8 / DCL world).
 */

import type { AuthIdentity } from '@dcl/crypto/dist/types'
import type { LoginResult } from '../../../auth/AuthClient'
import {
  sceneStreamAccessAdd,
  sceneStreamAccessList,
  type SceneStreamCredentials
} from '../../../network/gatekeeper/sceneStreamAccess'
import { listCustomWorldFavorites } from '../../../network/worlds/customWorldFavorites'
import type { LiveDirectoryController } from '../../../social/LiveDirectoryController'
import { fetchDclPlacesWorlds, type DclPlacesWorld } from '../../../social/dclPlaces'
import type { GlobalLiveMedia, LiveSession } from '../../../social/globalLiveWire'
import { resolveStreamAccessContext } from '../../../social/streamAccessContext'

export type LiveDirectoryViewOptions = {
  getDirectory: () => LiveDirectoryController | null
  onWatch: (session: LiveSession) => void
  getLogin?: () => LoginResult | null
  compact?: boolean
}

type SourceMode = 'm3u8' | 'dcl-world'
type WorldOption = { worldName: string; title: string }

/** Duplicate / copy icon (16px). */
const COPY_ICON = `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="5.5" y="5.5" width="8" height="8" rx="1.2"/><path d="M10.5 5.5V3.8A1.3 1.3 0 0 0 9.2 2.5H3.8A1.3 1.3 0 0 0 2.5 3.8v5.4A1.3 1.3 0 0 0 3.8 10.5H5.5"/></svg>`

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function normalizeWorldName(raw: string): string {
  const t = raw.trim()
  if (!t) return ''
  if (/^-?\d+\s*,\s*-?\d+$/.test(t)) return t.replace(/\s+/g, '')
  return (t.includes('.') ? t : `${t}.dcl.eth`).toLowerCase()
}

export class LiveDirectoryView {
  readonly root: HTMLElement
  private unsub: (() => void) | null = null
  private readonly listEl: HTMLElement
  private readonly emptyEl: HTMLElement
  private readonly statusEl: HTMLElement
  private readonly goLiveBtn: HTMLButtonElement
  private readonly endLiveBtn: HTMLButtonElement
  private readonly selfCard: HTMLElement
  private readonly modal: HTMLElement
  private mode: SourceMode = 'm3u8'
  private worlds: WorldOption[] = []
  private worldsLoaded = false
  private accessBusy = false
  private credentials: SceneStreamCredentials | null = null
  private bindRetryTimer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly options: LiveDirectoryViewOptions) {
    this.root = document.createElement('div')
    this.root.className = options.compact ? 'live-dir live-dir--compact' : 'live-dir'
    this.root.innerHTML = `
      <section class="live-dir__broadcast" data-broadcast>
        <button type="button" class="live-dir__go-live" data-go>
          <span class="live-dir__go-live-dot" aria-hidden="true"></span>
          GO LIVE
        </button>
        <button type="button" class="live-dir__btn live-dir__btn--end" data-end hidden>End Live</button>
      </section>

      <section class="live-dir__self-card" data-self-card hidden>
        <header class="live-dir__self-card-head">
          <span class="live-dir__self-card-badge">YOU</span>
          <span class="live-dir__self-card-status" data-self-status>Waiting for stream…</span>
        </header>
        <p class="live-dir__self-card-title" data-self-title></p>
        <div class="live-go-modal__creds live-dir__self-creds" data-self-creds hidden></div>
      </section>

      <section class="live-dir__list-wrap">
        <div class="live-dir__list-head">
          <h2 class="live-dir__h">Live now</h2>
          <p class="live-dir__status" data-status></p>
        </div>
        <div class="live-dir__list" data-list></div>
        <p class="live-dir__empty" data-empty>No one is live yet — be the first.</p>
      </section>

      <div class="live-go-modal" data-modal hidden>
        <div class="live-go-modal__backdrop" data-modal-backdrop></div>
        <div class="live-go-modal__sheet" role="dialog" aria-labelledby="live-go-title">
          <header class="live-go-modal__head">
            <h2 id="live-go-title" class="live-go-modal__title">GO LIVE</h2>
            <button type="button" class="live-go-modal__x" data-modal-close aria-label="Close">✕</button>
          </header>
          <label class="live-dir__label">Source
            <select class="live-dir__input live-dir__select" data-mode>
              <option value="m3u8">Custom HLS (.m3u8)</option>
              <option value="dcl-world">DCL world</option>
            </select>
          </label>
          <div data-pane-m3u8>
            <label class="live-dir__label">Playback URL
              <input class="live-dir__input" data-url type="url" placeholder="https://…/live.m3u8" autocomplete="off" />
            </label>
            <label class="live-dir__label">Title (optional)
              <input class="live-dir__input" data-title type="text" maxlength="80" placeholder="My stream" />
            </label>
            <button type="button" class="live-dir__go-live live-dir__go-live--modal" data-confirm-m3u8>GO LIVE</button>
          </div>
          <div data-pane-dcl hidden>
            <label class="live-dir__label">Your world
              <select class="live-dir__input live-dir__select" data-world-select>
                <option value="">Loading worlds…</option>
              </select>
            </label>
            <label class="live-dir__label">Or type world name
              <input class="live-dir__input" data-world-manual type="text" placeholder="myworld.dcl.eth" autocomplete="off" />
            </label>
            <button type="button" class="live-dir__btn live-dir__btn--secondary live-dir__get-keys" data-get-keys>Get keys</button>
            <div class="live-go-modal__creds" data-ssa-creds hidden></div>
            <button type="button" class="live-dir__go-live live-dir__go-live--modal" data-dcl-go-live disabled>GO LIVE</button>
          </div>
          <p class="live-dir__error" data-form-error hidden></p>
        </div>
      </div>
    `
    this.listEl = this.root.querySelector('[data-list]')!
    this.emptyEl = this.root.querySelector('[data-empty]')!
    this.statusEl = this.root.querySelector('[data-status]')!
    this.goLiveBtn = this.root.querySelector('[data-go]')!
    this.endLiveBtn = this.root.querySelector('[data-end]')!
    this.selfCard = this.root.querySelector('[data-self-card]')!
    this.modal = this.root.querySelector('[data-modal]')!

    this.goLiveBtn.addEventListener('click', () => this.openModal())
    this.endLiveBtn.addEventListener('click', () => void this.onEndLive())
    this.modal.querySelector('[data-modal-backdrop]')?.addEventListener('click', () => this.closeModal())
    this.modal.querySelector('[data-modal-close]')?.addEventListener('click', () => this.closeModal())
    this.modal.querySelector('[data-mode]')?.addEventListener('change', (ev) => {
      const v = (ev.target as HTMLSelectElement).value
      this.mode = v === 'dcl-world' ? 'dcl-world' : 'm3u8'
      this.syncModePanes()
      if (this.mode === 'dcl-world' && !this.worldsLoaded) void this.loadWorlds()
    })
    this.modal.querySelector('[data-confirm-m3u8]')?.addEventListener('click', () => void this.confirmM3u8())
    this.modal.querySelector('[data-get-keys]')?.addEventListener('click', () => void this.getKeys())
    this.modal.querySelector('[data-dcl-go-live]')?.addEventListener('click', () => void this.goLiveDcl())
    // Changing world invalidates keys until Get keys again.
    this.modal.querySelector('[data-world-select]')?.addEventListener('change', () => this.resetDclKeysUi())
    this.modal.querySelector('[data-world-manual]')?.addEventListener('input', () => this.resetDclKeysUi())
  }

  mount(): void {
    this.bindDirectory()
  }

  remountDirectory(): void {
    this.bindDirectory()
  }

  dispose(): void {
    if (this.bindRetryTimer) {
      clearTimeout(this.bindRetryTimer)
      this.bindRetryTimer = null
    }
    this.unsub?.()
    this.unsub = null
    this.closeModal()
    this.root.remove()
  }

  private bindDirectory(): void {
    this.unsub?.()
    this.unsub = null
    if (this.bindRetryTimer) {
      clearTimeout(this.bindRetryTimer)
      this.bindRetryTimer = null
    }
    const dir = this.options.getDirectory()
    if (!dir) {
      this.render([])
      this.statusEl.textContent = 'Connect with a wallet to see live streams'
      // Directory is created when PM/social warms — retry so we don't miss go-live emits.
      this.bindRetryTimer = setTimeout(() => this.bindDirectory(), 500)
      return
    }
    this.unsub = dir.subscribe((sessions) => this.render(sessions))
    this.syncBroadcastUi()
  }

  /** Force UI from controller state (after GO LIVE if subscribe raced). */
  private refreshFromDirectory(): void {
    const dir = this.options.getDirectory()
    if (!dir) {
      this.render([])
      return
    }
    if (!this.unsub) {
      this.unsub = dir.subscribe((sessions) => this.render(sessions))
    } else {
      this.render(dir.list())
    }
    this.syncBroadcastUi()
  }

  private render(sessions: readonly LiveSession[]): void {
    this.listEl.innerHTML = ''
    const dir = this.options.getDirectory()
    // Prefer explicit isSelf; fall back to local broadcasting session (subscribe race).
    const self =
      sessions.find((s) => s.isSelf) ??
      dir?.getBroadcasting() ??
      null
    const others = sessions.filter((s) => !s.isSelf && s.sessionId !== self?.sessionId)

    const total = others.length + (self ? 1 : 0)
    this.statusEl.textContent = total === 0 ? '' : `${total} live`
    this.emptyEl.hidden = total > 0

    this.renderSelfCard(self)

    for (const s of others) {
      const row = document.createElement('button')
      row.type = 'button'
      row.className = 'live-dir__row'
      const sub =
        s.media.type === 'dcl-cast'
          ? `${s.title} · ${s.media.worldName}`
          : s.title
      row.innerHTML = `
        <span class="live-dir__dot" aria-hidden="true"></span>
        <span class="live-dir__meta">
          <span class="live-dir__name"></span>
          <span class="live-dir__sub"></span>
        </span>
        <span class="live-dir__watch">Watch</span>
      `
      row.querySelector('.live-dir__name')!.textContent = s.displayName
      row.querySelector('.live-dir__sub')!.textContent = sub
      row.addEventListener('click', () => this.options.onWatch(s))
      this.listEl.appendChild(row)
    }
    this.syncBroadcastUi()
  }

  private renderSelfCard(self: LiveSession | null): void {
    if (!self) {
      this.selfCard.hidden = true
      this.selfCard.setAttribute('hidden', '')
      return
    }
    this.selfCard.hidden = false
    this.selfCard.removeAttribute('hidden')
    const statusEl = this.selfCard.querySelector('[data-self-status]') as HTMLElement
    statusEl.textContent = 'Waiting for stream…'
    const titleEl = this.selfCard.querySelector('[data-self-title]') as HTMLElement
    titleEl.textContent =
      self.media.type === 'dcl-cast'
        ? self.media.worldName
        : self.title || self.displayName

    const credsBox = this.selfCard.querySelector('[data-self-creds]') as HTMLElement
    if (this.credentials && (this.credentials.streamingUrl || this.credentials.streamingKey)) {
      this.fillCredentialsBox(credsBox, this.credentials)
      credsBox.hidden = false
      credsBox.removeAttribute('hidden')
    } else {
      credsBox.hidden = true
      credsBox.setAttribute('hidden', '')
      credsBox.innerHTML = ''
    }
  }

  private syncBroadcastUi(): void {
    const dir = this.options.getDirectory()
    const live = dir?.isBroadcasting() === true || !!dir?.getBroadcasting()
    this.goLiveBtn.hidden = live
    this.endLiveBtn.hidden = !live
    if (live && this.goLiveBtn.hidden) {
      // Ensure self card is on screen even if list emit was missed.
      const self = dir?.getBroadcasting() ?? null
      if (self && this.selfCard.hidden) this.renderSelfCard(self)
    }
  }

  private openModal(): void {
    this.clearFormError()
    // Reset modal creds (self card keeps them after go-live).
    const modalCreds = this.modal.querySelector('[data-ssa-creds]') as HTMLElement
    modalCreds.hidden = true
    modalCreds.innerHTML = ''
    this.modal.hidden = false
    this.syncModePanes()
    if (this.mode === 'dcl-world' && !this.worldsLoaded) void this.loadWorlds()
  }

  private closeModal(): void {
    this.modal.hidden = true
  }

  private syncModePanes(): void {
    const m3u8 = this.modal.querySelector('[data-pane-m3u8]') as HTMLElement
    const dcl = this.modal.querySelector('[data-pane-dcl]') as HTMLElement
    m3u8.hidden = this.mode !== 'm3u8'
    dcl.hidden = this.mode !== 'dcl-world'
    const sel = this.modal.querySelector('[data-mode]') as HTMLSelectElement
    sel.value = this.mode
  }

  private async loadWorlds(): Promise<void> {
    const select = this.modal.querySelector('[data-world-select]') as HTMLSelectElement
    select.innerHTML = `<option value="">Loading…</option>`
    const login = this.options.getLogin?.() ?? null
    const wallet =
      login?.kind === 'wallet' ? login.address.trim().toLowerCase() : ''

    const byName = new Map<string, WorldOption>()

    for (const f of listCustomWorldFavorites()) {
      const worldName = normalizeWorldName(f.worldName)
      if (!worldName) continue
      byName.set(worldName, {
        worldName,
        title: f.title?.trim() || worldName
      })
    }

    try {
      const pages: DclPlacesWorld[] = []
      for (let offset = 0; offset < 300; offset += 100) {
        const batch = await fetchDclPlacesWorlds({
          orderBy: 'most_active',
          limit: 100,
          offset
        })
        pages.push(...batch)
        if (batch.length < 100) break
      }
      if (wallet) {
        for (const w of pages) {
          const owner = (w.owner ?? '').toLowerCase()
          const creator = (w.creatorAddress ?? '').toLowerCase()
          if (owner !== wallet && creator !== wallet) continue
          const worldName = normalizeWorldName(w.worldName)
          if (!worldName) continue
          byName.set(worldName, {
            worldName,
            title: w.title?.trim() || worldName
          })
        }
      }
    } catch {
      /* network */
    }

    this.worlds = [...byName.values()].sort((a, b) => a.title.localeCompare(b.title))
    this.worldsLoaded = true

    if (!this.worlds.length) {
      select.innerHTML = `<option value="">Type a world name below</option>`
      return
    }
    select.innerHTML =
      `<option value="">Select a world…</option>` +
      this.worlds
        .map(
          (w) =>
            `<option value="${escapeHtml(w.worldName)}">${escapeHtml(w.title)} (${escapeHtml(w.worldName)})</option>`
        )
        .join('')
  }

  private selectedWorldName(): string {
    const select = this.modal.querySelector('[data-world-select]') as HTMLSelectElement
    const manual = this.modal.querySelector('[data-world-manual]') as HTMLInputElement
    return normalizeWorldName(manual.value || select.value)
  }

  private async confirmM3u8(): Promise<void> {
    this.clearFormError()
    const dir = this.options.getDirectory()
    if (!dir) {
      this.showFormError('Sign in to go live')
      return
    }
    const url = (this.modal.querySelector('[data-url]') as HTMLInputElement).value
    const title = (this.modal.querySelector('[data-title]') as HTMLInputElement).value
    this.credentials = null
    const result = await dir.goLive(url, title)
    if (!result.ok) {
      this.showFormError(result.error)
      return
    }
    this.closeModal()
    this.refreshFromDirectory()
  }

  private resetDclKeysUi(): void {
    // Keep credentials if user is already broadcasting; only clear pre-go-live mint UI.
    if (this.options.getDirectory()?.isBroadcasting()) return
    this.credentials = null
    const modalCreds = this.modal.querySelector('[data-ssa-creds]') as HTMLElement
    modalCreds.hidden = true
    modalCreds.innerHTML = ''
    const go = this.modal.querySelector('[data-dcl-go-live]') as HTMLButtonElement
    go.disabled = true
  }

  /** Mint / list OBS URL + key and show them — does NOT start heartbeat yet. */
  private async getKeys(): Promise<void> {
    this.clearFormError()
    if (this.accessBusy) return
    const login = this.options.getLogin?.() ?? null
    if (!login || login.kind !== 'wallet' || !login.identity) {
      this.showFormError('Wallet required for stream keys')
      return
    }
    const worldName = this.selectedWorldName()
    if (!worldName) {
      this.showFormError('Pick or type a world name')
      return
    }

    this.accessBusy = true
    const btn = this.modal.querySelector('[data-get-keys]') as HTMLButtonElement
    const goBtn = this.modal.querySelector('[data-dcl-go-live]') as HTMLButtonElement
    btn.disabled = true
    goBtn.disabled = true
    const prevLabel = btn.textContent
    btn.textContent = 'Getting keys…'
    try {
      const route = {
        kind: 'world' as const,
        worldName,
        segment: worldName
      }
      const params = await resolveStreamAccessContext(route, { isGuest: false })
      const identity = login.identity as AuthIdentity
      let credentials: SceneStreamCredentials | null = null
      const listed = await sceneStreamAccessList(identity, params)
      if (listed.ok && listed.credentials) {
        credentials = listed.credentials
      } else {
        const minted = await sceneStreamAccessAdd(identity, params, {})
        if (!minted.ok) {
          this.showFormError(minted.error || 'Could not mint stream access')
          return
        }
        credentials = minted.credentials
      }
      if (!credentials || (!credentials.streamingUrl && !credentials.streamingKey)) {
        this.showFormError('No stream credentials returned (are you the world owner?)')
        return
      }
      this.credentials = credentials
      const modalCreds = this.modal.querySelector('[data-ssa-creds]') as HTMLElement
      this.fillCredentialsBox(modalCreds, credentials)
      modalCreds.hidden = false
      goBtn.disabled = false
      btn.textContent = 'Refresh keys'
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      this.showFormError(
        msg === 'scene_not_found_for_pointer'
          ? 'Could not resolve scene for this world (is it deployed?).'
          : msg
      )
      btn.textContent = prevLabel || 'Get keys'
    } finally {
      this.accessBusy = false
      btn.disabled = false
      if (btn.textContent === 'Getting keys…') btn.textContent = prevLabel || 'Get keys'
    }
  }

  /** Start heartbeat + Live now tile after keys are shown. */
  private async goLiveDcl(): Promise<void> {
    this.clearFormError()
    const dir = this.options.getDirectory()
    if (!dir) {
      this.showFormError('Sign in to go live')
      return
    }
    const worldName = this.selectedWorldName()
    if (!worldName) {
      this.showFormError('Pick or type a world name')
      return
    }
    if (!this.credentials) {
      this.showFormError('Get keys first')
      return
    }
    const goBtn = this.modal.querySelector('[data-dcl-go-live]') as HTMLButtonElement
    goBtn.disabled = true
    goBtn.textContent = 'Starting…'
    try {
      const media: GlobalLiveMedia = { type: 'dcl-cast', worldName }
      const result = await dir.goLiveWithMedia(media, worldName)
      if (!result.ok) {
        this.showFormError(result.error)
        goBtn.disabled = false
        goBtn.textContent = 'GO LIVE'
        return
      }
      this.closeModal()
      // Force self card even if subscribe raced (directory created after first mount).
      this.refreshFromDirectory()
    } finally {
      goBtn.disabled = !this.credentials || !!this.options.getDirectory()?.isBroadcasting()
      goBtn.textContent = 'GO LIVE'
    }
  }

  private fillCredentialsBox(box: HTMLElement, c: SceneStreamCredentials): void {
    const parts: string[] = []
    if (c.streamingUrl) {
      parts.push(`
        <div class="live-cred-line">
          <span class="live-cred-line__label">URL</span>
          <code class="live-cred-line__value" data-cred-url></code>
          <button type="button" class="live-cred-line__copy" data-copy-field="url" title="Copy URL" aria-label="Copy URL">${COPY_ICON}</button>
        </div>`)
    }
    if (c.streamingKey) {
      parts.push(`
        <div class="live-cred-line">
          <span class="live-cred-line__label">Key</span>
          <code class="live-cred-line__value live-cred-line__value--key" data-cred-key></code>
          <button type="button" class="live-cred-line__copy" data-copy-field="key" title="Copy stream key" aria-label="Copy stream key">${COPY_ICON}</button>
        </div>`)
    }
    if (c.ingressId) {
      parts.push(`
        <div class="live-cred-line">
          <span class="live-cred-line__label">Ingress</span>
          <code class="live-cred-line__value" data-cred-ingress></code>
          <button type="button" class="live-cred-line__copy" data-copy-field="ingress" title="Copy ingress id" aria-label="Copy ingress id">${COPY_ICON}</button>
        </div>`)
    }
    box.innerHTML = parts.join('')
    const urlEl = box.querySelector('[data-cred-url]') as HTMLElement | null
    const keyEl = box.querySelector('[data-cred-key]') as HTMLElement | null
    const ingressEl = box.querySelector('[data-cred-ingress]') as HTMLElement | null
    if (urlEl) urlEl.textContent = c.streamingUrl
    if (keyEl) keyEl.textContent = c.streamingKey
    if (ingressEl) ingressEl.textContent = c.ingressId
    box.querySelectorAll<HTMLButtonElement>('[data-copy-field]').forEach((el) => {
      el.addEventListener('click', (ev) => {
        ev.stopPropagation()
        void this.copyCredentialField(el)
      })
    })
  }

  private async copyCredentialField(btn: HTMLButtonElement): Promise<void> {
    const field = btn.dataset.copyField
    const c = this.credentials
    if (!c || !field) return
    const value =
      field === 'url'
        ? c.streamingUrl
        : field === 'key'
          ? c.streamingKey
          : field === 'ingress'
            ? c.ingressId
            : ''
    if (!value) return
    const ok = await this.copyText(value)
    btn.classList.toggle('is-copied', ok)
    btn.title = ok ? 'Copied!' : 'Copy failed'
    window.setTimeout(() => {
      btn.classList.remove('is-copied')
      btn.title =
        field === 'url' ? 'Copy URL' : field === 'key' ? 'Copy stream key' : 'Copy ingress id'
    }, 1200)
  }

  private async copyText(text: string): Promise<boolean> {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text)
        return true
      }
    } catch {
      /* fall through */
    }
    try {
      const ta = document.createElement('textarea')
      ta.value = text
      ta.setAttribute('readonly', '')
      ta.style.position = 'fixed'
      ta.style.left = '-9999px'
      document.body.appendChild(ta)
      ta.select()
      const ok = document.execCommand('copy')
      ta.remove()
      return ok
    } catch {
      return false
    }
  }

  private async onEndLive(): Promise<void> {
    const dir = this.options.getDirectory()
    await dir?.endLive()
    this.credentials = null
    this.selfCard.hidden = true
    this.syncBroadcastUi()
    this.closeModal()
  }

  private showFormError(msg: string): void {
    const el = this.modal.querySelector('[data-form-error]') as HTMLElement
    el.textContent = msg
    el.hidden = false
  }

  private clearFormError(): void {
    const el = this.modal.querySelector('[data-form-error]') as HTMLElement
    el.textContent = ''
    el.hidden = true
  }
}
