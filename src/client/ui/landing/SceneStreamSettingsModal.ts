/**
 * Owner "Manage place" modal (landing gear ⚙):
 * - Streams — RTMP keys, watch pointer, live listings
 * - Bans — scaffold (scene ban management)
 * - Multiplayer — authoritative server env / scene / player storage
 */
import type { AuthIdentity } from '@dcl/crypto/dist/types'
import type { RouteTarget } from '../../../dcl/content/route'
import {
  formatTimeLeftMs,
  sceneStreamAccessAdd,
  sceneStreamAccessList,
  sceneStreamAccessRemove,
  sceneStreamAccessReset,
  type SceneStreamCredentials
} from '../../../network/gatekeeper/sceneStreamAccess'
import {
  deleteEnvKey,
  deletePlayerKey,
  deleteSceneKey,
  getPlayerValue,
  getSceneValue,
  listEnvKeys,
  listPlayerKeys,
  listSceneKeys,
  setEnvValue,
  setPlayerValue,
  setSceneValue,
  storageContextFromRoute,
  type StoragePlaceContext
} from '../../../network/storage/worldStorageApi'
import {
  getLiveKitWatchPointer,
  parseLiveKitWatchPointerInput,
  setLiveKitWatchPointer
} from '../../../social/livekitWatchPointer'
import { resolveStreamAccessContext } from '../../../social/streamAccessContext'
import {
  listUserStreams,
  removeUserStream,
  type SceneStreamKind,
  type UserSceneStream
} from '../../../social/sceneStreams'

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export type SceneStreamSettingsModalOptions = {
  route: Extract<RouteTarget, { kind: 'coords' } | { kind: 'world' }>
  pointer: string
  kind: SceneStreamKind
  wallet: string
  identity: AuthIdentity
  onChanged: () => void
  onClose: () => void
}

type MainTab = 'streams' | 'bans' | 'multiplayer'
type MultiTab = 'env' | 'scene' | 'player'

/**
 * Owner place tools — Streams / Bans / Multiplayer (auth-server storage).
 * Import path kept as SceneStreamSettingsModal for landing view compatibility.
 */
export class SceneStreamSettingsModal {
  readonly root: HTMLElement
  private readonly opts: SceneStreamSettingsModalOptions
  private readonly storageCtx: StoragePlaceContext
  private credentials: SceneStreamCredentials | null = null
  private listAttempted = false
  private ctxBusy = false
  private expiryTimer = 0
  private disposed = false
  private multiTab: MultiTab = 'env'
  private envKeys: string[] = []
  private sceneKeys: string[] = []
  private playerKeys: string[] = []
  private playerAddress = ''

  constructor(opts: SceneStreamSettingsModalOptions) {
    this.opts = opts
    this.storageCtx = storageContextFromRoute(opts.route)
    this.root = document.createElement('div')
    this.root.className = 'scene-watch-settings-modal-backdrop'
    this.root.dataset.sceneSettingsModal = ''
    this.root.innerHTML = this.shellHtml()
    this.root.addEventListener('click', (e) => {
      if (e.target === this.root) this.close()
    })
    this.bindShell()
    this.showMainTab('streams')
  }

  mount(parent: HTMLElement): void {
    parent.appendChild(this.root)
  }

  dispose(): void {
    this.disposed = true
    if (this.expiryTimer) window.clearInterval(this.expiryTimer)
    this.root.remove()
  }

  private close(): void {
    this.opts.onClose()
    this.dispose()
  }

  private shellHtml(): string {
    const p = escapeHtml(this.opts.pointer)
    return `
      <div class="scene-watch-settings-modal scene-watch-settings-modal--wide scene-watch-settings-modal--manage" role="dialog" aria-modal="true" aria-label="Manage place">
        <div class="place-manage-header">
          <div>
            <h3 class="scene-watch-settings-modal-title">Manage place</h3>
            <p class="scene-watch-settings-modal-text scene-watch-settings-modal-text--tight">
              Owner tools for <strong>${p}</strong>
            </p>
          </div>
          <button type="button" class="scene-watch-dest-btn scene-watch-dest-btn--secondary" data-settings-close>Close</button>
        </div>

        <nav class="place-manage-tabs" role="tablist" aria-label="Place settings">
          <button type="button" class="place-manage-tab is-active" role="tab" data-main-tab="streams" aria-selected="true">Streams</button>
          <button type="button" class="place-manage-tab" role="tab" data-main-tab="bans" aria-selected="false">Bans</button>
          <button type="button" class="place-manage-tab" role="tab" data-main-tab="multiplayer" aria-selected="false">Multiplayer</button>
        </nav>

        <div class="place-manage-body">
          <div class="place-manage-panel" data-panel="streams" role="tabpanel"></div>
          <div class="place-manage-panel" data-panel="bans" role="tabpanel" hidden></div>
          <div class="place-manage-panel" data-panel="multiplayer" role="tabpanel" hidden></div>
        </div>
      </div>
    `
  }

  private bindShell(): void {
    this.root.querySelector('[data-settings-close]')?.addEventListener('click', () => this.close())
    this.root.querySelectorAll<HTMLButtonElement>('[data-main-tab]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const tab = btn.dataset.mainTab as MainTab
        if (tab) this.showMainTab(tab)
      })
    })
  }

  private showMainTab(tab: MainTab): void {
    this.root.querySelectorAll<HTMLButtonElement>('[data-main-tab]').forEach((btn) => {
      const on = btn.dataset.mainTab === tab
      btn.classList.toggle('is-active', on)
      btn.setAttribute('aria-selected', on ? 'true' : 'false')
    })
    this.root.querySelectorAll<HTMLElement>('[data-panel]').forEach((panel) => {
      panel.hidden = panel.dataset.panel !== tab
    })
    if (tab === 'streams') this.renderStreamsPanel()
    else if (tab === 'bans') this.renderBansPanel()
    else this.renderMultiplayerPanel()
  }

  // ── Streams (existing) ───────────────────────────────────────────────────

  private renderStreamsPanel(): void {
    const panel = this.root.querySelector('[data-panel="streams"]') as HTMLElement
    const p = escapeHtml(this.opts.pointer)
    panel.innerHTML = `
      <p class="scene-watch-settings-modal-text">
        RTMP stream keys for Cast/OBS, optional LiveKit watch target, and live listings.
        In-scene video and browser chat are controlled by the deployed scene.
      </p>

      <section class="scene-stream-settings-section" aria-labelledby="ssa-rtmp-title">
        <h4 id="ssa-rtmp-title" class="scene-watch-settings-modal-label scene-stream-access-embedded-heading">RTMP / LiveKit (OBS / Cast)</h4>
        <p class="scene-watch-settings-modal-text scene-watch-settings-modal-text--tight">
          Mint Decentraland stream credentials for this world/parcel (same as Explorer / companion).
          Use the URL + key in OBS to publish Cast into this place.
        </p>
        <div class="scene-stream-access-btn-row">
          <button type="button" class="scene-stream-access-modal-btn" data-ssa-list>Get stream access</button>
          <button type="button" class="scene-stream-access-modal-btn scene-stream-access-modal-btn--primary" data-ssa-add hidden>Add stream access</button>
          <button type="button" class="scene-stream-access-modal-btn scene-stream-access-modal-btn--danger" data-ssa-remove>Remove access</button>
          <button type="button" class="scene-stream-access-modal-btn scene-stream-access-modal-btn--danger" data-ssa-reset>Reset keys</button>
        </div>
        <div class="scene-stream-access-modal-credentials" data-ssa-creds hidden></div>
        <p class="scene-watch-settings-modal-error" data-ssa-error hidden></p>
      </section>

      <hr class="scene-watch-settings-modal-divider" />

      <section class="scene-stream-settings-section">
        <label class="scene-watch-settings-modal-label" for="livekit-watch-pointer-input">LiveKit watch scene</label>
        <p class="scene-watch-settings-modal-text scene-watch-settings-modal-text--tight">
          Optional: use a different world/parcel for Cast / LiveKit than this URL (e.g. <code>myworld.dcl.eth</code> or <code>12,-34</code>).
          Stream keys above still apply to <strong>${p}</strong>.
        </p>
        <input id="livekit-watch-pointer-input" class="scene-watch-settings-modal-input" type="text"
          placeholder="e.g. myworld.dcl.eth or 0,0" autocomplete="off" data-watch-pointer />
        <div class="scene-watch-settings-modal-actions scene-watch-settings-modal-actions--inline">
          <button type="button" class="scene-watch-dest-btn scene-watch-dest-btn--secondary" data-watch-clear>Clear</button>
          <button type="button" class="scene-watch-dest-btn" data-watch-save>Save watch target</button>
        </div>
      </section>

      <hr class="scene-watch-settings-modal-divider" />

      <section class="scene-stream-settings-section">
        <p class="scene-watch-settings-modal-label">Listed live streams</p>
        <p class="scene-watch-settings-modal-text scene-watch-settings-modal-text--tight">
          “I’m live” listings for this place (this origin). Owners can remove any row.
        </p>
        <div class="scene-stream-listed" data-listed-streams></div>
      </section>
    `
    this.bindStreams()
    this.refreshWatchPointerField()
    this.refreshListedStreams()
    this.renderCredentials()
  }

  private bindStreams(): void {
    this.root.querySelector('[data-ssa-list]')?.addEventListener('click', () => void this.runAccess('list'))
    this.root.querySelector('[data-ssa-add]')?.addEventListener('click', () => void this.runAccess('add'))
    this.root.querySelector('[data-ssa-remove]')?.addEventListener('click', () => void this.runAccess('remove'))
    this.root.querySelector('[data-ssa-reset]')?.addEventListener('click', () => void this.runAccess('reset'))

    this.root.querySelector('[data-watch-save]')?.addEventListener('click', () => {
      const input = this.root.querySelector('[data-watch-pointer]') as HTMLInputElement
      const parsed = parseLiveKitWatchPointerInput(input.value)
      setLiveKitWatchPointer(this.opts.wallet, parsed)
      input.value = parsed ?? ''
      this.opts.onChanged()
    })
    this.root.querySelector('[data-watch-clear]')?.addEventListener('click', () => {
      setLiveKitWatchPointer(this.opts.wallet, null)
      const input = this.root.querySelector('[data-watch-pointer]') as HTMLInputElement
      input.value = ''
      this.opts.onChanged()
    })
  }

  private setSsaError(msg: string | null): void {
    const el = this.root.querySelector('[data-ssa-error]') as HTMLElement | null
    if (!el) return
    if (!msg) {
      el.hidden = true
      el.textContent = ''
      return
    }
    el.hidden = false
    el.textContent = msg
  }

  private setLoading(on: boolean): void {
    this.root
      .querySelectorAll<HTMLButtonElement>('[data-ssa-list],[data-ssa-add],[data-ssa-remove],[data-ssa-reset]')
      .forEach((b) => {
        b.disabled = on || this.ctxBusy
      })
  }

  private async withAccessParams<T>(
    fn: (params: Awaited<ReturnType<typeof resolveStreamAccessContext>>) => Promise<T>
  ): Promise<T | null> {
    this.ctxBusy = true
    this.setLoading(true)
    try {
      const params = await resolveStreamAccessContext(this.opts.route, { isGuest: false })
      if (this.disposed) return null
      return await fn(params)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      this.setSsaError(
        msg === 'scene_not_found_for_pointer'
          ? 'Could not resolve scene deployment for this place (is it deployed?).'
          : msg
      )
      return null
    } finally {
      this.ctxBusy = false
      this.setLoading(false)
    }
  }

  private async runAccess(path: 'list' | 'add' | 'remove' | 'reset'): Promise<void> {
    this.setSsaError(null)
    await this.withAccessParams(async (params) => {
      const identity = this.opts.identity
      if (path === 'list') {
        this.listAttempted = true
        const r = await sceneStreamAccessList(identity, params)
        if (!r.ok) {
          if (r.status === 404) {
            const mint = await sceneStreamAccessAdd(identity, params, {})
            if (!mint.ok) {
              this.setSsaError(mint.error)
              this.credentials = null
            } else {
              this.credentials = mint.credentials
            }
          } else {
            this.setSsaError(r.error)
            this.credentials = null
          }
        } else if (!r.credentials) {
          const mint = await sceneStreamAccessAdd(identity, params, {})
          if (!mint.ok) {
            this.setSsaError(mint.error)
            this.credentials = null
          } else {
            this.credentials = mint.credentials
          }
        } else {
          this.credentials = r.credentials
        }
        this.renderCredentials()
        return
      }
      if (path === 'add') {
        this.listAttempted = true
        const r = await sceneStreamAccessAdd(identity, params, {})
        if (!r.ok) {
          this.setSsaError(r.error)
          this.credentials = null
        } else {
          this.credentials = r.credentials
        }
        this.renderCredentials()
        return
      }
      if (path === 'remove') {
        const r = await sceneStreamAccessRemove(identity, params)
        if (!r.ok) this.setSsaError(r.error)
        else this.credentials = null
        this.renderCredentials()
        return
      }
      const r = await sceneStreamAccessReset(identity, params)
      if (!r.ok) this.setSsaError(r.error)
      else this.credentials = null
      this.renderCredentials()
    })
  }

  private renderCredentials(): void {
    const box = this.root.querySelector('[data-ssa-creds]') as HTMLElement | null
    const addBtn = this.root.querySelector('[data-ssa-add]') as HTMLButtonElement | null
    if (!box || !addBtn) return
    const c = this.credentials
    const empty = !c || (!c.streamingUrl && !c.streamingKey && !c.ingressId)
    addBtn.hidden = !(this.listAttempted && empty)

    if (this.expiryTimer) {
      window.clearInterval(this.expiryTimer)
      this.expiryTimer = 0
    }

    if (empty) {
      if (this.listAttempted) {
        box.hidden = false
        box.innerHTML =
          '<p class="scene-stream-access-credentials-placeholder">No RTMP credentials yet. Use <strong>Add stream access</strong> to mint URL + key.</p>'
      } else {
        box.hidden = true
        box.innerHTML = ''
      }
      return
    }

    box.hidden = false
    const lines: string[] = [
      '<div class="scene-stream-access-credentials-head">OBS credentials (server URL + stream key)</div>',
      '<p class="scene-stream-access-copy-hint">Click URL or key to copy</p>'
    ]
    if (c!.streamingUrl) {
      lines.push(
        `<p class="scene-stream-access-modal-cred-line"><span class="scene-stream-access-modal-cred-label">URL</span><button type="button" class="scene-stream-access-modal-cred-value scene-stream-access-copy-btn" data-copy="${escapeHtml(c!.streamingUrl)}" title="Click to copy URL">${escapeHtml(c!.streamingUrl)}</button></p>`
      )
    }
    if (c!.streamingKey) {
      lines.push(
        `<p class="scene-stream-access-modal-cred-line"><span class="scene-stream-access-modal-cred-label">Key</span><button type="button" class="scene-stream-access-modal-cred-value scene-stream-access-modal-cred-value--key scene-stream-access-copy-btn" data-copy="${escapeHtml(c!.streamingKey)}" title="Click to copy stream key">${escapeHtml(c!.streamingKey)}</button></p>`
      )
    }
    if (c!.ingressId) {
      lines.push(
        `<p class="scene-stream-access-modal-cred-line"><span class="scene-stream-access-modal-cred-label">Ingress id</span><button type="button" class="scene-stream-access-modal-cred-value scene-stream-access-copy-btn" data-copy="${escapeHtml(c!.ingressId)}" title="Click to copy ingress id">${escapeHtml(c!.ingressId)}</button></p>`
      )
    }
    if (c!.expiresAtMs != null) {
      lines.push(
        `<p class="scene-stream-access-modal-expiry" data-ssa-expiry>Stream key <strong data-ssa-expiry-left>${escapeHtml(formatTimeLeftMs(c!.expiresAtMs, Date.now()))}</strong> remaining · expires ${escapeHtml(new Date(c!.expiresAtMs).toLocaleString())}</p>`
      )
      this.expiryTimer = window.setInterval(() => {
        const left = this.root.querySelector('[data-ssa-expiry-left]')
        if (!left || !this.credentials?.expiresAtMs) return
        left.textContent = formatTimeLeftMs(this.credentials.expiresAtMs, Date.now())
      }, 1000)
    }
    box.innerHTML = lines.join('')
    box.querySelectorAll<HTMLButtonElement>('[data-copy]').forEach((btn) => {
      btn.addEventListener('click', () => void this.copyCredential(btn))
    })
  }

  private async copyCredential(btn: HTMLButtonElement): Promise<void> {
    const text = btn.dataset.copy ?? btn.textContent ?? ''
    if (!text) return
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      const ta = document.createElement('textarea')
      ta.value = text
      ta.style.position = 'fixed'
      ta.style.left = '-9999px'
      document.body.appendChild(ta)
      ta.select()
      try {
        document.execCommand('copy')
      } finally {
        ta.remove()
      }
    }
    const prev = btn.textContent
    btn.classList.add('scene-stream-access-copy-btn--copied')
    btn.textContent = 'Copied!'
    window.setTimeout(() => {
      btn.classList.remove('scene-stream-access-copy-btn--copied')
      btn.textContent = prev
    }, 1200)
  }

  private refreshWatchPointerField(): void {
    const input = this.root.querySelector('[data-watch-pointer]') as HTMLInputElement | null
    if (!input) return
    input.value = getLiveKitWatchPointer(this.opts.wallet) ?? ''
  }

  private refreshListedStreams(): void {
    const host = this.root.querySelector('[data-listed-streams]') as HTMLElement | null
    if (!host) return
    const streams = listUserStreams(this.opts.pointer, this.opts.kind)
    if (streams.length === 0) {
      host.innerHTML = '<p class="scene-watch-join-live-empty">No user listings for this place yet.</p>'
      return
    }
    host.innerHTML = streams.map((s) => this.listedStreamRow(s)).join('')
    host.querySelectorAll<HTMLButtonElement>('[data-remove-stream]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.removeStream
        if (!id) return
        removeUserStream(id)
        this.refreshListedStreams()
        this.opts.onChanged()
      })
    })
  }

  private listedStreamRow(s: UserSceneStream): string {
    const detail =
      s.source === 'm3u8'
        ? escapeHtml(s.m3u8Url ?? '')
        : `Cast → ${escapeHtml(s.castPointer ?? '')}`
    return `
      <div class="scene-stream-listed-row">
        <div class="scene-stream-listed-meta">
          <strong>${escapeHtml(s.displayName)}</strong>
          <span class="scene-stream-listed-detail">${detail}</span>
        </div>
        <button type="button" class="scene-stream-access-modal-btn scene-stream-access-modal-btn--danger" data-remove-stream="${escapeHtml(s.id)}">Remove</button>
      </div>
    `
  }

  // ── Bans ─────────────────────────────────────────────────────────────────

  private renderBansPanel(): void {
    const panel = this.root.querySelector('[data-panel="bans"]') as HTMLElement
    panel.innerHTML = `
      <h4 class="scene-watch-settings-modal-label">Scene bans</h4>
      <p class="scene-watch-settings-modal-text">
        Manage wallets blocked from joining chat / comms in this place.
        Full ban list management is coming soon — mid-session bans already work via gatekeeper when players are denied entry.
      </p>
      <div class="place-manage-empty">
        Ban list tools will appear here (list · unban · notes).
      </div>
    `
  }

  // ── Multiplayer / storage ────────────────────────────────────────────────

  private renderMultiplayerPanel(): void {
    const panel = this.root.querySelector('[data-panel="multiplayer"]') as HTMLElement
    const place =
      this.storageCtx.realm?.trim() ||
      this.storageCtx.position?.trim() ||
      this.opts.pointer
    panel.innerHTML = `
      <p class="scene-watch-settings-modal-text">
        Authoritative server data for <strong>${escapeHtml(place)}</strong>
        (signed storage API). Env vars hold secrets; scene/player storage holds JSON game state.
      </p>
      <nav class="place-manage-subtabs" role="tablist" aria-label="Multiplayer storage">
        <button type="button" class="place-manage-subtab is-active" data-multi-tab="env">Environment</button>
        <button type="button" class="place-manage-subtab" data-multi-tab="scene">Scene</button>
        <button type="button" class="place-manage-subtab" data-multi-tab="player">Player</button>
      </nav>
      <div class="place-manage-multi-body" data-multi-body></div>
      <p class="scene-watch-settings-modal-error" data-storage-error hidden></p>
    `
    panel.querySelectorAll<HTMLButtonElement>('[data-multi-tab]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const t = btn.dataset.multiTab as MultiTab
        if (t) this.showMultiTab(t)
      })
    })
    this.showMultiTab(this.multiTab)
  }

  private showMultiTab(tab: MultiTab): void {
    this.multiTab = tab
    const panel = this.root.querySelector('[data-panel="multiplayer"]')
    panel?.querySelectorAll<HTMLButtonElement>('[data-multi-tab]').forEach((btn) => {
      btn.classList.toggle('is-active', btn.dataset.multiTab === tab)
    })
    if (tab === 'env') void this.renderEnvBody()
    else if (tab === 'scene') void this.renderSceneBody()
    else void this.renderPlayerBody()
  }

  private multiBody(): HTMLElement | null {
    return this.root.querySelector('[data-multi-body]')
  }

  private setStorageError(msg: string | null): void {
    const el = this.root.querySelector('[data-storage-error]') as HTMLElement | null
    if (!el) return
    if (!msg) {
      el.hidden = true
      el.textContent = ''
      return
    }
    el.hidden = false
    el.textContent = msg
  }

  private async renderEnvBody(): Promise<void> {
    const body = this.multiBody()
    if (!body) return
    body.innerHTML = `<p class="place-manage-loading">Loading environment keys…</p>`
    this.setStorageError(null)
    const r = await listEnvKeys(this.opts.identity, this.storageCtx)
    if (this.disposed || this.multiTab !== 'env') return
    if (!r.ok) {
      body.innerHTML = `<div class="place-manage-empty">Could not load env keys.</div>`
      this.setStorageError(r.error)
      return
    }
    this.envKeys = r.data
    body.innerHTML = `
      <div class="place-manage-toolbar">
        <h4 class="scene-watch-settings-modal-label">Environment variables</h4>
        <button type="button" class="scene-stream-access-modal-btn scene-stream-access-modal-btn--primary" data-env-add>+ Add</button>
      </div>
      <p class="scene-watch-settings-modal-text scene-watch-settings-modal-text--tight">
        Server-only secrets and config. Values may be write-only (encrypted); set/overwrite or delete.
      </p>
      <div class="place-manage-kv-list" data-env-list></div>
    `
    const list = body.querySelector('[data-env-list]') as HTMLElement
    if (this.envKeys.length === 0) {
      list.innerHTML = `<div class="place-manage-empty">No environment variables found</div>`
    } else {
      list.innerHTML = this.envKeys
        .map(
          (key) => `
        <div class="place-manage-kv-row" data-env-key="${escapeHtml(key)}">
          <span class="place-manage-kv-key">${escapeHtml(key)}</span>
          <span class="place-manage-kv-actions">
            <button type="button" class="scene-stream-access-modal-btn" data-env-edit="${escapeHtml(key)}">Edit</button>
            <button type="button" class="scene-stream-access-modal-btn scene-stream-access-modal-btn--danger" data-env-del="${escapeHtml(key)}">Delete</button>
          </span>
        </div>`
        )
        .join('')
    }
    body.querySelector('[data-env-add]')?.addEventListener('click', () => void this.promptSetEnv())
    list.querySelectorAll<HTMLButtonElement>('[data-env-edit]').forEach((btn) => {
      btn.addEventListener('click', () => void this.promptSetEnv(btn.dataset.envEdit))
    })
    list.querySelectorAll<HTMLButtonElement>('[data-env-del]').forEach((btn) => {
      btn.addEventListener('click', () => void this.confirmDeleteEnv(btn.dataset.envDel ?? ''))
    })
  }

  private async promptSetEnv(existingKey?: string): Promise<void> {
    const key =
      existingKey?.trim() ||
      window.prompt('Environment variable key (e.g. API_KEY, MAX_PLAYERS):')?.trim()
    if (!key) return
    const value = window.prompt(
      existingKey
        ? `New value for ${key} (overwrites; previous value is not shown if encrypted):`
        : `Value for ${key}:`,
      ''
    )
    if (value === null) return
    const r = await setEnvValue(this.opts.identity, this.storageCtx, key, value)
    if (!r.ok) {
      this.setStorageError(r.error)
      return
    }
    void this.renderEnvBody()
  }

  private async confirmDeleteEnv(key: string): Promise<void> {
    if (!key || !window.confirm(`Delete environment variable “${key}”?`)) return
    const r = await deleteEnvKey(this.opts.identity, this.storageCtx, key)
    if (!r.ok) {
      this.setStorageError(r.error)
      return
    }
    void this.renderEnvBody()
  }

  private async renderSceneBody(): Promise<void> {
    const body = this.multiBody()
    if (!body) return
    body.innerHTML = `<p class="place-manage-loading">Loading scene storage…</p>`
    this.setStorageError(null)
    const r = await listSceneKeys(this.opts.identity, this.storageCtx)
    if (this.disposed || this.multiTab !== 'scene') return
    if (!r.ok) {
      body.innerHTML = `<div class="place-manage-empty">Could not load scene storage.</div>`
      this.setStorageError(r.error)
      return
    }
    this.sceneKeys = r.data
    body.innerHTML = `
      <div class="place-manage-toolbar">
        <h4 class="scene-watch-settings-modal-label">Scene storage</h4>
        <button type="button" class="scene-stream-access-modal-btn scene-stream-access-modal-btn--primary" data-scene-add>+ Add</button>
      </div>
      <p class="scene-watch-settings-modal-text scene-watch-settings-modal-text--tight">
        Shared world/scene key-value data (leaderboards, doors, etc.). Values are JSON.
      </p>
      <div class="place-manage-kv-list" data-scene-list></div>
    `
    const list = body.querySelector('[data-scene-list]') as HTMLElement
    if (this.sceneKeys.length === 0) {
      list.innerHTML = `<div class="place-manage-empty">No scene values found</div>`
    } else {
      list.innerHTML = this.sceneKeys
        .map(
          (key) => `
        <div class="place-manage-kv-row">
          <span class="place-manage-kv-key">${escapeHtml(key)}</span>
          <span class="place-manage-kv-actions">
            <button type="button" class="scene-stream-access-modal-btn" data-scene-edit="${escapeHtml(key)}">Edit</button>
            <button type="button" class="scene-stream-access-modal-btn scene-stream-access-modal-btn--danger" data-scene-del="${escapeHtml(key)}">Delete</button>
          </span>
        </div>`
        )
        .join('')
    }
    body.querySelector('[data-scene-add]')?.addEventListener('click', () => void this.promptSetScene())
    list.querySelectorAll<HTMLButtonElement>('[data-scene-edit]').forEach((btn) => {
      btn.addEventListener('click', () => void this.promptSetScene(btn.dataset.sceneEdit))
    })
    list.querySelectorAll<HTMLButtonElement>('[data-scene-del]').forEach((btn) => {
      btn.addEventListener('click', () => void this.confirmDeleteScene(btn.dataset.sceneDel ?? ''))
    })
  }

  private async promptSetScene(existingKey?: string): Promise<void> {
    const key =
      existingKey?.trim() || window.prompt('Scene storage key (e.g. leaderboard):')?.trim()
    if (!key) return
    let initial = ''
    if (existingKey) {
      const got = await getSceneValue(this.opts.identity, this.storageCtx, key)
      if (got.ok) {
        initial =
          typeof got.data === 'string' ? got.data : JSON.stringify(got.data ?? null, null, 2)
      }
    }
    const raw = window.prompt(`JSON value for “${key}”:`, initial || '""')
    if (raw === null) return
    let value: unknown
    try {
      value = JSON.parse(raw)
    } catch {
      this.setStorageError('Value must be valid JSON (use quotes for plain strings).')
      return
    }
    const r = await setSceneValue(this.opts.identity, this.storageCtx, key, value)
    if (!r.ok) {
      this.setStorageError(r.error)
      return
    }
    void this.renderSceneBody()
  }

  private async confirmDeleteScene(key: string): Promise<void> {
    if (!key || !window.confirm(`Delete scene key “${key}”?`)) return
    const r = await deleteSceneKey(this.opts.identity, this.storageCtx, key)
    if (!r.ok) {
      this.setStorageError(r.error)
      return
    }
    void this.renderSceneBody()
  }

  private async renderPlayerBody(): Promise<void> {
    const body = this.multiBody()
    if (!body) return
    body.innerHTML = `
      <h4 class="scene-watch-settings-modal-label">Player storage</h4>
      <p class="scene-watch-settings-modal-text scene-watch-settings-modal-text--tight">
        Browse data stored per wallet for this place. Enter a full address (0x…).
      </p>
      <div class="place-manage-player-search">
        <input class="scene-watch-settings-modal-input" type="text" data-player-addr
          placeholder="Search by address 0x…" autocomplete="off" value="${escapeHtml(this.playerAddress)}" />
        <button type="button" class="scene-stream-access-modal-btn scene-stream-access-modal-btn--primary" data-player-load>Load</button>
      </div>
      <div class="place-manage-toolbar" style="margin-top:12px" ${this.playerAddress ? '' : 'hidden'} data-player-tools>
        <span class="place-manage-kv-key" data-player-label></span>
        <button type="button" class="scene-stream-access-modal-btn scene-stream-access-modal-btn--primary" data-player-add>+ Add</button>
      </div>
      <div class="place-manage-kv-list" data-player-list>
        <div class="place-manage-empty">No players loaded — enter an address above.</div>
      </div>
    `
    body.querySelector('[data-player-load]')?.addEventListener('click', () => {
      const input = body.querySelector('[data-player-addr]') as HTMLInputElement
      void this.loadPlayerKeys(input.value.trim())
    })
    body.querySelector('[data-player-add]')?.addEventListener('click', () => void this.promptSetPlayer())
    if (this.playerAddress) void this.loadPlayerKeys(this.playerAddress)
  }

  private async loadPlayerKeys(address: string): Promise<void> {
    const list = this.root.querySelector('[data-player-list]') as HTMLElement | null
    const tools = this.root.querySelector('[data-player-tools]') as HTMLElement | null
    const label = this.root.querySelector('[data-player-label]') as HTMLElement | null
    if (!list) return
    if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
      this.setStorageError('Enter a valid 0x wallet address (40 hex chars).')
      return
    }
    this.playerAddress = address.toLowerCase()
    this.setStorageError(null)
    list.innerHTML = `<p class="place-manage-loading">Loading player keys…</p>`
    const r = await listPlayerKeys(this.opts.identity, this.storageCtx, this.playerAddress)
    if (this.disposed || this.multiTab !== 'player') return
    if (!r.ok) {
      list.innerHTML = `<div class="place-manage-empty">Could not load player storage.</div>`
      this.setStorageError(r.error)
      return
    }
    this.playerKeys = r.data
    if (tools) tools.hidden = false
    if (label) label.textContent = this.playerAddress
    if (this.playerKeys.length === 0) {
      list.innerHTML = `<div class="place-manage-empty">No keys for this player</div>`
      return
    }
    list.innerHTML = this.playerKeys
      .map(
        (key) => `
      <div class="place-manage-kv-row">
        <span class="place-manage-kv-key">${escapeHtml(key)}</span>
        <span class="place-manage-kv-actions">
          <button type="button" class="scene-stream-access-modal-btn" data-player-edit="${escapeHtml(key)}">Edit</button>
          <button type="button" class="scene-stream-access-modal-btn scene-stream-access-modal-btn--danger" data-player-del="${escapeHtml(key)}">Delete</button>
        </span>
      </div>`
      )
      .join('')
    list.querySelectorAll<HTMLButtonElement>('[data-player-edit]').forEach((btn) => {
      btn.addEventListener('click', () => void this.promptSetPlayer(btn.dataset.playerEdit))
    })
    list.querySelectorAll<HTMLButtonElement>('[data-player-del]').forEach((btn) => {
      btn.addEventListener('click', () => void this.confirmDeletePlayer(btn.dataset.playerDel ?? ''))
    })
  }

  private async promptSetPlayer(existingKey?: string): Promise<void> {
    if (!this.playerAddress) return
    const key =
      existingKey?.trim() || window.prompt('Player storage key (e.g. progress):')?.trim()
    if (!key) return
    let initial = ''
    if (existingKey) {
      const got = await getPlayerValue(
        this.opts.identity,
        this.storageCtx,
        this.playerAddress,
        key
      )
      if (got.ok) {
        initial =
          typeof got.data === 'string' ? got.data : JSON.stringify(got.data ?? null, null, 2)
      }
    }
    const raw = window.prompt(`JSON value for “${key}”:`, initial || '""')
    if (raw === null) return
    let value: unknown
    try {
      value = JSON.parse(raw)
    } catch {
      this.setStorageError('Value must be valid JSON.')
      return
    }
    const r = await setPlayerValue(
      this.opts.identity,
      this.storageCtx,
      this.playerAddress,
      key,
      value
    )
    if (!r.ok) {
      this.setStorageError(r.error)
      return
    }
    void this.loadPlayerKeys(this.playerAddress)
  }

  private async confirmDeletePlayer(key: string): Promise<void> {
    if (!key || !this.playerAddress) return
    if (!window.confirm(`Delete player key “${key}” for ${this.playerAddress}?`)) return
    const r = await deletePlayerKey(
      this.opts.identity,
      this.storageCtx,
      this.playerAddress,
      key
    )
    if (!r.ok) {
      this.setStorageError(r.error)
      return
    }
    void this.loadPlayerKeys(this.playerAddress)
  }
}
