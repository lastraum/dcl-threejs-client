/**
 * Shared Live list + Go Live (single CTA → modal with m3u8 / DCL world).
 * Cards mirror Explorer live tiles (places-view__card--live-tile).
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
  /**
   * Attach OBS/LiveKit video for a dcl-cast world into a host (self preview + reliability).
   * Returns cleanup. Called when self card mounts after GO LIVE.
   */
  onCastPreview?: (
    host: HTMLElement,
    worldName: string,
    onUpdate: (attached: boolean) => void
  ) => Promise<() => void>
}

type SourceMode = 'm3u8' | 'dcl-world'
type WorldOption = { worldName: string; title: string }

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

function shortAddr(a: string): string {
  return a.length >= 10 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a
}

export class LiveDirectoryView {
  readonly root: HTMLElement
  private unsub: (() => void) | null = null
  private readonly listEl: HTMLElement
  private readonly emptyEl: HTMLElement
  private readonly statusEl: HTMLElement
  private readonly goLiveBtn: HTMLButtonElement
  private readonly endLiveBtn: HTMLButtonElement
  private readonly modal: HTMLElement
  private mode: SourceMode = 'm3u8'
  private worlds: WorldOption[] = []
  private worldsLoaded = false
  private accessBusy = false
  private credentials: SceneStreamCredentials | null = null
  private bindRetryTimer: ReturnType<typeof setTimeout> | null = null
  private previewCleanup: (() => void) | null = null
  private previewWorld: string | null = null
  private previewAttached = false
  /** Stable self-card node so heartbeat re-renders don't tear down LiveKit preview. */
  private selfCardEl: HTMLElement | null = null
  private selfCardSessionId: string | null = null

  constructor(private readonly options: LiveDirectoryViewOptions) {
    this.root = document.createElement('div')
    this.root.className = options.compact
      ? 'live-dir live-dir--compact places-view places-view--explorer'
      : 'live-dir places-view places-view--explorer'
    this.root.innerHTML = `
      <section class="live-dir__broadcast" data-broadcast>
        <button type="button" class="live-dir__go-live" data-go>
          <span class="live-dir__go-live-dot" aria-hidden="true"></span>
          GO LIVE
        </button>
        <button type="button" class="live-dir__btn live-dir__btn--end" data-end hidden>End Live</button>
      </section>

      <section class="live-dir__list-wrap">
        <div class="live-dir__list-head">
          <h2 class="live-dir__h places-view__spotlight-title places-view__spotlight-title--live">Live now</h2>
          <p class="live-dir__status" data-status></p>
        </div>
        <div class="live-dir__grid places-view__carousel places-view__carousel--live" data-list role="list"></div>
        <p class="live-dir__empty places-view__spotlight-muted" data-empty>No one is live yet — be the first.</p>
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
    this.stopSelfPreview()
    this.unsub?.()
    this.unsub = null
    this.closeModal()
    this.root.remove()
  }

  private stopSelfPreview(): void {
    try {
      this.previewCleanup?.()
    } catch {
      /* ignore */
    }
    this.previewCleanup = null
    this.previewWorld = null
    this.previewAttached = false
    this.selfCardEl = null
    this.selfCardSessionId = null
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
      this.bindRetryTimer = setTimeout(() => this.bindDirectory(), 500)
      return
    }
    this.unsub = dir.subscribe((sessions) => this.render(sessions))
    this.syncBroadcastUi()
  }

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
    const dir = this.options.getDirectory()
    const self =
      sessions.find((s) => s.isSelf) ?? dir?.getBroadcasting() ?? null
    const others = sessions.filter((s) => !s.isSelf && s.sessionId !== self?.sessionId)

    const total = others.length + (self ? 1 : 0)
    this.statusEl.textContent = total === 0 ? '' : `${total} live`
    this.emptyEl.hidden = total > 0

    // Keep self card DOM stable so LiveKit preview is not torn down every heartbeat.
    if (!self) {
      this.stopSelfPreview()
      this.listEl.innerHTML = ''
    } else if (
      this.selfCardEl &&
      this.selfCardSessionId === self.sessionId &&
      this.selfCardEl.isConnected
    ) {
      // Only rebuild others
      this.listEl.querySelectorAll('[data-other-session]').forEach((n) => n.remove())
      if (this.selfCardEl.parentElement !== this.listEl) {
        this.listEl.prepend(this.selfCardEl)
      }
      this.updateSelfCardChrome(self)
    } else {
      this.stopSelfPreview()
      this.listEl.innerHTML = ''
      this.selfCardEl = this.buildSessionCard(self, true)
      this.selfCardSessionId = self.sessionId
      this.listEl.appendChild(this.selfCardEl)
      if (self.media.type === 'dcl-cast' && this.options.onCastPreview) {
        void this.ensureSelfPreview(self.media.worldName)
      }
    }

    for (const s of others) {
      this.listEl.appendChild(this.buildSessionCard(s, false))
    }
    this.syncBroadcastUi()
  }

  private updateSelfCardChrome(session: LiveSession): void {
    if (!this.selfCardEl) return
    const wait = this.selfCardEl.querySelector('[data-self-wait]') as HTMLElement | null
    if (wait && !this.previewAttached) {
      wait.textContent = 'Waiting for stream…'
    }
    const loc = this.selfCardEl.querySelector('.places-view__card-location') as HTMLElement | null
    if (loc && session.media.type === 'dcl-cast') {
      loc.textContent = session.media.worldName
    }
    const credsBox = this.selfCardEl.querySelector('[data-card-creds]') as HTMLElement | null
    if (
      credsBox &&
      this.credentials &&
      (this.credentials.streamingUrl || this.credentials.streamingKey) &&
      !credsBox.querySelector('.live-cred-line')
    ) {
      this.fillCredentialsBox(credsBox, this.credentials)
      credsBox.hidden = false
      credsBox.removeAttribute('hidden')
    }
  }

  private async ensureSelfPreview(worldName: string): Promise<void> {
    if (!this.options.onCastPreview || !this.selfCardEl) return
    // Dedicated host so LiveKit reattach replaceChildren() does not wipe badges.
    const videoHost = this.selfCardEl.querySelector(
      '[data-video-host]'
    ) as HTMLElement | null
    const waitBadge = this.selfCardEl.querySelector('[data-self-wait]') as HTMLElement | null
    if (!videoHost) return
    if (this.previewWorld === worldName && this.previewCleanup) return

    try {
      this.previewCleanup?.()
    } catch {
      /* ignore */
    }
    this.previewCleanup = null
    this.previewAttached = false
    this.previewWorld = worldName
    try {
      const ph = this.selfCardEl.querySelector('.live-session-card__placeholder')
      this.previewCleanup = await this.options.onCastPreview(videoHost, worldName, (attached) => {
        this.previewAttached = attached
        if (waitBadge) {
          waitBadge.textContent = attached ? 'LIVE' : 'Waiting for stream…'
          waitBadge.classList.toggle('live-session-card__badge--live', attached)
          waitBadge.classList.toggle('live-session-card__badge--wait', !attached)
        }
        if (attached) {
          ph?.classList.add('is-hidden')
        } else {
          ph?.classList.remove('is-hidden')
        }
      })
    } catch (e) {
      if (waitBadge) {
        waitBadge.textContent =
          e instanceof Error ? e.message.slice(0, 48) : 'Preview failed'
      }
    }
  }

  private buildSessionCard(session: LiveSession, isSelf: boolean): HTMLElement {
    const article = document.createElement('article')
    article.className = 'places-view__card places-view__card--live-tile live-session-card'
    if (isSelf) article.classList.add('live-session-card--self')
    else article.dataset.otherSession = session.sessionId
    article.setAttribute('role', 'listitem')

    const placeLabel =
      session.media.type === 'dcl-cast'
        ? session.media.worldName
        : session.media.type === 'hls' || session.media.type === 'http'
          ? 'Custom stream'
          : 'Live'

    const title = isSelf
      ? session.displayName || 'You'
      : session.displayName || shortAddr(session.hostAddress)

    const statusLine = isSelf
      ? this.previewAttached
        ? 'LIVE'
        : 'Waiting for stream…'
      : 'LIVE'

    article.innerHTML = `
      <div class="places-view__card-media live-session-card__media">
        <div class="live-session-card__video-host" data-video-host></div>
        <div class="places-view__card-placeholder live-session-card__placeholder" aria-hidden></div>
        <div class="live-session-card__media-badges">
          ${
            isSelf
              ? `<span class="live-session-card__badge live-session-card__badge--you">YOU</span>
                 <span class="live-session-card__badge ${this.previewAttached ? 'live-session-card__badge--live' : 'live-session-card__badge--wait'}" data-self-wait>${escapeHtml(statusLine)}</span>`
              : `<span class="live-session-card__badge live-session-card__badge--live">LIVE</span>`
          }
        </div>
      </div>
      <div class="places-view__card-body places-view__card-body--live">
        <div class="places-view__card-action">
          <div class="places-view__card-info places-view__card-info--live">
            <h3 class="places-view__card-title"></h3>
            <span class="places-view__card-location"></span>
          </div>
          ${
            isSelf
              ? `<button type="button" class="places-view__card-visit live-session-card__end" data-end-card>End</button>`
              : `<button type="button" class="places-view__card-visit" data-watch>Watch</button>`
          }
        </div>
      </div>
      ${
        isSelf
          ? `<div class="live-session-card__creds" data-card-creds hidden></div>`
          : ''
      }
    `

    article.querySelector('.places-view__card-title')!.textContent = title
    const loc = article.querySelector('.places-view__card-location') as HTMLElement
    loc.textContent = placeLabel
    loc.title = placeLabel

    if (isSelf) {
      const credsBox = article.querySelector('[data-card-creds]') as HTMLElement
      if (this.credentials && (this.credentials.streamingUrl || this.credentials.streamingKey)) {
        this.fillCredentialsBox(credsBox, this.credentials)
        credsBox.hidden = false
        credsBox.removeAttribute('hidden')
      }
      article.querySelector('[data-end-card]')?.addEventListener('click', (ev) => {
        ev.stopPropagation()
        void this.onEndLive()
      })
      // Click media / card → PiP for self preview full size
      article.querySelector('.live-session-card__media')?.addEventListener('click', () => {
        this.options.onWatch(session)
      })
    } else {
      article.querySelector('[data-watch]')?.addEventListener('click', (ev) => {
        ev.stopPropagation()
        this.options.onWatch(session)
      })
      article.addEventListener('click', () => this.options.onWatch(session))
    }

    return article
  }

  private syncBroadcastUi(): void {
    const dir = this.options.getDirectory()
    const live = dir?.isBroadcasting() === true || !!dir?.getBroadcasting()
    this.goLiveBtn.hidden = live
    this.endLiveBtn.hidden = !live
    if (live) {
      this.goLiveBtn.setAttribute('hidden', '')
      this.endLiveBtn.removeAttribute('hidden')
    } else {
      this.goLiveBtn.removeAttribute('hidden')
      this.endLiveBtn.setAttribute('hidden', '')
    }
  }

  private openModal(): void {
    this.clearFormError()
    const modalCreds = this.modal.querySelector('[data-ssa-creds]') as HTMLElement
    modalCreds.hidden = true
    modalCreds.innerHTML = ''
    this.modal.hidden = false
    this.modal.removeAttribute('hidden')
    this.syncModePanes()
    if (this.mode === 'dcl-world' && !this.worldsLoaded) void this.loadWorlds()
  }

  private closeModal(): void {
    this.modal.hidden = true
    this.modal.setAttribute('hidden', '')
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
    if (this.options.getDirectory()?.isBroadcasting()) return
    this.credentials = null
    const modalCreds = this.modal.querySelector('[data-ssa-creds]') as HTMLElement
    modalCreds.hidden = true
    modalCreds.innerHTML = ''
    const go = this.modal.querySelector('[data-dcl-go-live]') as HTMLButtonElement
    go.disabled = true
  }

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
    this.stopSelfPreview()
    this.refreshFromDirectory()
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
