/**
 * Owner Scene & stream settings:
 * - Gatekeeper RTMP / stream keys (OBS → Cast for this world/parcel)
 * - LiveKit watch pointer (optional different Cast target)
 * - Moderate “I’m live” listings for this place
 *
 * Scene chat and in-scene video/HLS stay in scene.json / scene code (deploy).
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

export class SceneStreamSettingsModal {
  readonly root: HTMLElement
  private readonly opts: SceneStreamSettingsModalOptions
  private credentials: SceneStreamCredentials | null = null
  private listAttempted = false
  private ctxBusy = false
  private expiryTimer = 0
  private disposed = false

  constructor(opts: SceneStreamSettingsModalOptions) {
    this.opts = opts
    this.root = document.createElement('div')
    this.root.className = 'scene-watch-settings-modal-backdrop'
    this.root.dataset.sceneSettingsModal = ''
    this.root.innerHTML = this.shellHtml()
    this.root.addEventListener('click', (e) => {
      if (e.target === this.root) this.close()
    })
    this.bindStatic()
    this.refreshWatchPointerField()
    this.refreshListedStreams()
    this.renderCredentials()
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
      <div class="scene-watch-settings-modal scene-watch-settings-modal--wide" role="dialog" aria-modal="true" aria-label="Scene and stream settings">
        <h3 class="scene-watch-settings-modal-title">Scene &amp; stream settings</h3>
        <p class="scene-watch-settings-modal-text">
          Owner tools for <strong>${p}</strong> — RTMP stream keys for Cast/OBS, optional LiveKit watch target,
          and live listings. In-scene video and browser chat are controlled by the deployed scene.
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

        <div class="scene-watch-settings-modal-actions" style="margin-top:16px">
          <button type="button" class="scene-watch-dest-btn scene-watch-dest-btn--secondary" data-settings-close>Close</button>
        </div>
      </div>
    `
  }

  private bindStatic(): void {
    this.root.querySelector('[data-settings-close]')?.addEventListener('click', () => this.close())
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
    const el = this.root.querySelector('[data-ssa-error]') as HTMLElement
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
    const box = this.root.querySelector('[data-ssa-creds]') as HTMLElement
    const addBtn = this.root.querySelector('[data-ssa-add]') as HTMLButtonElement
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
      // Fallback for non-secure contexts
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
    const input = this.root.querySelector('[data-watch-pointer]') as HTMLInputElement
    input.value = getLiveKitWatchPointer(this.opts.wallet) ?? ''
  }

  private refreshListedStreams(): void {
    const host = this.root.querySelector('[data-listed-streams]') as HTMLElement
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
}
