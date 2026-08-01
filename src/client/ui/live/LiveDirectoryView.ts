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
  /** Wallet session for stream-access mint (DCL world path). */
  getLogin?: () => LoginResult | null
  compact?: boolean
}

type SourceMode = 'm3u8' | 'dcl-world'

type WorldOption = { worldName: string; title: string }

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
  private readonly modal: HTMLElement
  private mode: SourceMode = 'm3u8'
  private worlds: WorldOption[] = []
  private worldsLoaded = false
  private accessBusy = false
  /** Last minted OBS credentials — kept for reliable copy (not re-read from DOM attrs). */
  private credentials: SceneStreamCredentials | null = null

  constructor(private readonly options: LiveDirectoryViewOptions) {
    this.root = document.createElement('div')
    this.root.className = options.compact ? 'live-dir live-dir--compact' : 'live-dir'
    this.root.innerHTML = `
      <section class="live-dir__broadcast" data-broadcast>
        <div class="live-dir__broadcast-row">
          <button type="button" class="live-dir__btn live-dir__btn--primary" data-go>Go Live</button>
          <button type="button" class="live-dir__btn" data-end hidden>End Live</button>
        </div>
        <p class="live-dir__hint live-dir__hint--tight">Keep this client open while live (2D is fine).</p>
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
            <h2 id="live-go-title" class="live-go-modal__title">Go Live</h2>
            <button type="button" class="live-go-modal__x" data-modal-close aria-label="Close">✕</button>
          </header>
          <label class="live-dir__label">Source
            <select class="live-dir__input live-dir__select" data-mode>
              <option value="m3u8">Custom HLS (.m3u8)</option>
              <option value="dcl-world">DCL world (OBS stream keys)</option>
            </select>
          </label>
          <div data-pane-m3u8>
            <label class="live-dir__label">Playback URL
              <input class="live-dir__input" data-url type="url" placeholder="https://…/live.m3u8" autocomplete="off" />
            </label>
            <label class="live-dir__label">Title (optional)
              <input class="live-dir__input" data-title type="text" maxlength="80" placeholder="My stream" />
            </label>
            <button type="button" class="live-dir__btn live-dir__btn--primary" data-confirm-m3u8>Start live</button>
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
            <p class="live-dir__hint">Same as scene owner “Get stream access” — mints RTMP URL + key for OBS. On success you are announced live automatically.</p>
            <button type="button" class="live-dir__btn live-dir__btn--primary" data-ssa-get>Get stream access</button>
            <div class="live-go-modal__creds" data-ssa-creds hidden></div>
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
    this.modal.querySelector('[data-ssa-get]')?.addEventListener('click', () => void this.getStreamAccessAndGoLive())
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
    this.closeModal()
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
    this.statusEl.textContent = sessions.length === 0 ? '' : `${sessions.length} live`
    this.emptyEl.hidden = sessions.length > 0
    for (const s of sessions) {
      const row = document.createElement('button')
      row.type = 'button'
      row.className = 'live-dir__row'
      if (s.isSelf) row.classList.add('is-self')
      const sub =
        s.media.type === 'dcl-cast'
          ? `${s.title} · ${s.media.worldName}`
          : s.isSelf
            ? `${s.title} · you`
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

  private syncBroadcastUi(): void {
    const dir = this.options.getDirectory()
    const live = dir?.isBroadcasting() === true
    this.goLiveBtn.hidden = live
    this.endLiveBtn.hidden = !live
  }

  private openModal(): void {
    this.clearFormError()
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

    // Local favorites first
    for (const f of listCustomWorldFavorites()) {
      const worldName = normalizeWorldName(f.worldName)
      if (!worldName) continue
      byName.set(worldName, {
        worldName,
        title: f.title?.trim() || worldName
      })
    }

    try {
      // Scan active worlds and keep those owned/created by this wallet.
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
      /* network — still show favorites / manual */
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
    const result = await dir.goLive(url, title)
    if (!result.ok) {
      this.showFormError(result.error)
      return
    }
    this.closeModal()
    this.syncBroadcastUi()
  }

  private async getStreamAccessAndGoLive(): Promise<void> {
    this.clearFormError()
    if (this.accessBusy) return
    const login = this.options.getLogin?.() ?? null
    if (!login || login.kind !== 'wallet' || !login.identity) {
      this.showFormError('Wallet required for DCL stream access')
      return
    }
    const worldName = this.selectedWorldName()
    if (!worldName) {
      this.showFormError('Pick or type a world name')
      return
    }
    const dir = this.options.getDirectory()
    if (!dir) {
      this.showFormError('Sign in to go live')
      return
    }

    this.accessBusy = true
    const btn = this.modal.querySelector('[data-ssa-get]') as HTMLButtonElement
    btn.disabled = true
    btn.textContent = 'Getting access…'
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
      this.renderCredentials(credentials)

      const media: GlobalLiveMedia = { type: 'dcl-cast', worldName }
      const result = await dir.goLiveWithMedia(media, worldName)
      if (!result.ok) {
        this.showFormError(result.error)
        return
      }
      // Keep modal open so OBS URL + key stay visible and copyable.
      btn.textContent = 'Live — keys below'
      this.syncBroadcastUi()
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      this.showFormError(
        msg === 'scene_not_found_for_pointer'
          ? 'Could not resolve scene for this world (is it deployed?).'
          : msg
      )
    } finally {
      this.accessBusy = false
      btn.disabled = false
      if (btn.textContent === 'Getting access…') btn.textContent = 'Get stream access'
    }
  }

  private renderCredentials(c: SceneStreamCredentials): void {
    const box = this.modal.querySelector('[data-ssa-creds]') as HTMLElement
    box.hidden = false
    const parts: string[] = [
      `<div class="live-go-modal__creds-head">OBS credentials</div>`,
      `<p class="live-dir__hint live-dir__hint--tight">Copy URL and stream key into OBS. You are already live in the directory.</p>`
    ]
    if (c.streamingUrl) {
      parts.push(`
        <div class="live-go-modal__cred-row">
          <span class="live-go-modal__cred-label">Server URL (RTMP)</span>
          <code class="live-go-modal__cred-value" data-cred-url></code>
          <button type="button" class="live-dir__btn live-go-modal__copy-btn" data-copy-field="url">Copy URL</button>
        </div>`)
    }
    if (c.streamingKey) {
      parts.push(`
        <div class="live-go-modal__cred-row">
          <span class="live-go-modal__cred-label">Stream key</span>
          <code class="live-go-modal__cred-value live-go-modal__cred-value--key" data-cred-key></code>
          <button type="button" class="live-dir__btn live-go-modal__copy-btn" data-copy-field="key">Copy key</button>
        </div>`)
    }
    if (c.ingressId) {
      parts.push(`
        <div class="live-go-modal__cred-row">
          <span class="live-go-modal__cred-label">Ingress id</span>
          <code class="live-go-modal__cred-value" data-cred-ingress></code>
          <button type="button" class="live-dir__btn live-go-modal__copy-btn" data-copy-field="ingress">Copy</button>
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
      el.addEventListener('click', () => void this.copyCredentialField(el))
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
    const prev = btn.textContent
    btn.textContent = ok ? 'Copied!' : 'Copy failed'
    btn.classList.toggle('is-copied', ok)
    window.setTimeout(() => {
      btn.textContent = prev
      btn.classList.remove('is-copied')
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
