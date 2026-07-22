import type { AuthIdentity } from '@dcl/crypto/dist/types'
import type { SessionIdentity } from '../../../network/SessionIdentity'
import {
  fetchNotifications,
  formatNotificationRelativeTime,
  formatNotificationTime,
  markNotificationsRead,
  notificationActorAddress,
  notificationBody,
  notificationImageUrl,
  notificationLink,
  notificationTitle,
  notificationTitleAccent,
  notificationTypeKind,
  type DclNotification,
  type NotificationTypeKind
} from '../../../social/notificationsApi'
import { resolveFaceSnapshotUrl } from '../../../map/catalystProfiles'
import { catalystProfilesEndpoint } from '../../../map/mapConfig'

export type NotificationsPanelOptions = {
  getSession: () => SessionIdentity
  onUnreadChange?: (count: number) => void
  onClose?: () => void
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** Compact type glyph (Explorer row badge). */
function typeIconSvg(kind: NotificationTypeKind): string {
  switch (kind) {
    case 'friendship':
      // heart
      return `<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M12 21s-6.7-4.35-9.33-8.1C.9 10.4 1.2 6.9 4 5.2c2.1-1.25 4.5-.5 5.9 1.15C11.3 4.7 13.7 3.95 15.8 5.2c2.8 1.7 3.1 5.2 1.33 7.7C18.7 16.65 12 21 12 21z"/></svg>`
    case 'campaign':
      // megaphone
      return `<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M3 10v4h2l5 3V7L5 10H3zm12.5 2a2.5 2.5 0 0 0-1.5-2.3v4.6a2.5 2.5 0 0 0 1.5-2.3zm-1.5-6.1v1.55A5 5 0 0 1 18 12a5 5 0 0 1-4 4.55v1.55A6.5 6.5 0 0 0 19.5 12 6.5 6.5 0 0 0 14 5.9z"/></svg>`
    case 'event':
      // calendar
      return `<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M7 2h2v2h6V2h2v2h3v18H4V4h3V2zm13 8H6v10h14V10z"/></svg>`
    case 'reward':
      // gift
      return `<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M20 7h-2.2a3 3 0 0 0-5.3-2.4A3 3 0 0 0 6.2 7H4v4h16V7zM4 13v8h7v-8H4zm9 0v8h7v-8h-7z"/></svg>`
    case 'marketplace':
      // tag
      return `<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M21.4 11.6 12.4 2.6A2 2 0 0 0 11 2H4a2 2 0 0 0-2 2v7a2 2 0 0 0 .6 1.4l9 9a2 2 0 0 0 2.8 0l7-7a2 2 0 0 0 0-2.8zM7 8a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3z"/></svg>`
    case 'governance':
      return `<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M12 2 3 7v2h18V7L12 2zm-7 9v7H3v2h18v-2h-2v-7h-2v7h-4v-7H9v7H5v-7H5z"/></svg>`
    case 'world':
      return `<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 2c1.7 0 3.3.5 4.6 1.4L12 10 7.4 5.4A8 8 0 0 1 12 4zm-8 8c0-1.4.4-2.7 1-3.8L10 13v5.9A8 8 0 0 1 4 12zm8 8c-1.1 0-2.1-.2-3-.6V14l3 3 3-3v5.4c-.9.4-1.9.6-3 .6zm4-2.1V13l5-5.8c.6 1.1 1 2.4 1 3.8a8 8 0 0 1-6 7.9z"/></svg>`
    default:
      return `<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M12 22a2 2 0 0 0 2-2h-4a2 2 0 0 0 2 2zm6-6V11a6 6 0 1 0-12 0v5l-2 2v1h16v-1l-2-2z"/></svg>`
  }
}

/**
 * Sidebar Notifications inbox — Explorer-style list popup
 * (GET/PUT notifications.decentraland.org via signed fetch).
 */
export class NotificationsPanel {
  readonly element: HTMLDivElement
  private visible = false
  private items: DclNotification[] = []
  /** address → face URL (lazy profile fill for friendship rows). */
  private readonly faceByAddress = new Map<string, string | null>()
  private faceFetchGen = 0
  private readonly listEl: HTMLElement
  private readonly statusEl: HTMLElement
  private readonly refreshBtn: HTMLButtonElement
  private readonly markAllBtn: HTMLButtonElement
  private readonly onKeyDown: (ev: KeyboardEvent) => void
  private readonly onDocClick: (ev: MouseEvent) => void

  constructor(private readonly options: NotificationsPanelOptions) {
    this.element = document.createElement('div')
    this.element.className = 'notifications-panel'
    this.element.hidden = true
    this.element.setAttribute('role', 'dialog')
    this.element.setAttribute('aria-label', 'Notifications')
    this.element.innerHTML = `
      <header class="notifications-panel__header">
        <h2 class="notifications-panel__title">Notifications</h2>
        <div class="notifications-panel__actions">
          <button type="button" class="notifications-panel__text-btn" data-mark-all hidden>Mark all read</button>
          <button type="button" class="notifications-panel__icon-btn" data-refresh aria-label="Refresh">↻</button>
          <button type="button" class="notifications-panel__icon-btn" data-close aria-label="Close">×</button>
        </div>
      </header>
      <p class="notifications-panel__status" data-status hidden></p>
      <div class="notifications-panel__list" data-list></div>
    `

    this.listEl = this.element.querySelector('[data-list]')!
    this.statusEl = this.element.querySelector('[data-status]')!
    this.refreshBtn = this.element.querySelector('[data-refresh]')!
    this.markAllBtn = this.element.querySelector('[data-mark-all]')!

    this.element.querySelector('[data-close]')!.addEventListener('click', () => this.hide())
    this.refreshBtn.addEventListener('click', () => void this.reload())
    this.markAllBtn.addEventListener('click', () => void this.markAllRead())

    this.onKeyDown = (ev) => {
      if (ev.key === 'Escape' && this.visible) this.hide()
    }
    this.onDocClick = (ev) => {
      if (!this.visible) return
      const t = ev.target
      if (!(t instanceof Node)) return
      if (this.element.contains(t)) return
      if (t instanceof Element && t.closest('[data-action="notifications"]')) return
      this.hide()
    }

    document.body.appendChild(this.element)
  }

  isVisible(): boolean {
    return this.visible
  }

  toggle(): void {
    if (this.visible) this.hide()
    else void this.show()
  }

  async show(): Promise<void> {
    this.visible = true
    this.element.hidden = false
    document.addEventListener('keydown', this.onKeyDown)
    // Next tick so the opening click does not immediately close.
    window.setTimeout(() => document.addEventListener('click', this.onDocClick), 0)
    await this.reload()
  }

  hide(): void {
    if (!this.visible) return
    this.visible = false
    this.element.hidden = true
    document.removeEventListener('keydown', this.onKeyDown)
    document.removeEventListener('click', this.onDocClick)
    this.options.onClose?.()
  }

  dispose(): void {
    this.hide()
    this.element.remove()
  }

  /** Quiet unread poll for sidebar badge (no panel open). */
  async refreshUnreadBadge(): Promise<void> {
    const identity = this.authIdentity()
    if (!identity) {
      this.options.onUnreadChange?.(0)
      return
    }
    const result = await fetchNotifications(identity, { limit: 50, onlyUnread: true })
    if (!result.ok) return
    this.options.onUnreadChange?.(result.notifications.length)
  }

  private authIdentity(): AuthIdentity | null {
    return this.options.getSession().getAuthIdentity()
  }

  private async reload(): Promise<void> {
    const identity = this.authIdentity()
    if (!identity) {
      this.items = []
      this.renderList('Sign in with a wallet to view notifications.')
      this.markAllBtn.hidden = true
      this.options.onUnreadChange?.(0)
      return
    }

    this.refreshBtn.disabled = true
    this.statusEl.textContent = 'Loading…'
    this.statusEl.hidden = false

    const result = await fetchNotifications(identity, { limit: 40 })
    this.refreshBtn.disabled = false

    if (!result.ok) {
      this.items = []
      this.renderList(
        result.status === 401 || result.status === 403
          ? 'Could not authorize notifications. Try signing in again.'
          : `Could not load notifications (${result.status}).`
      )
      this.markAllBtn.hidden = true
      return
    }

    this.items = result.notifications
    const unread = this.items.filter((n) => !n.read).length
    this.options.onUnreadChange?.(unread)
    this.markAllBtn.hidden = unread === 0
    this.statusEl.hidden = true
    this.statusEl.textContent = ''
    this.renderList(this.items.length ? null : 'No notifications yet.')
    void this.hydrateFaces()
  }

  private renderList(emptyMessage: string | null): void {
    if (emptyMessage) {
      this.listEl.innerHTML = `<p class="notifications-panel__empty">${escapeHtml(emptyMessage)}</p>`
      return
    }

    this.listEl.innerHTML = this.items.map((n) => this.rowHtml(n)).join('')

    this.listEl.querySelectorAll<HTMLElement>('[data-id]').forEach((row) => {
      row.addEventListener('click', (ev) => {
        const t = ev.target
        if (t instanceof Element && t.closest('a,button')) return
        const id = row.dataset.id
        if (!id) return
        const item = this.items.find((x) => x.id === id)
        if (!item) return
        if (!item.read) void this.markRead([id])
        const link = notificationLink(item)
        if (link) window.open(link, '_blank', 'noopener,noreferrer')
      })
    })
  }

  private rowHtml(n: DclNotification): string {
    const title = escapeHtml(notificationTitle(n))
    const body = escapeHtml(notificationBody(n))
    const rel = escapeHtml(formatNotificationRelativeTime(n))
    const abs = escapeHtml(formatNotificationTime(n))
    const unread = !n.read
    const accent = notificationTitleAccent(n)
    const kind = notificationTypeKind(n.type)
    const link = notificationLink(n)
    const image = this.resolveRowImage(n)
    const initial = (notificationTitle(n).trim().charAt(0) || '?').toUpperCase()

    const avatar = image
      ? `<img class="notifications-panel__avatar-img" src="${escapeHtml(image)}" alt="" width="44" height="44" loading="lazy" decoding="async" data-face-for="${escapeHtml(n.id)}" onerror="this.style.display='none';this.nextElementSibling&&(this.nextElementSibling.hidden=false)" />
         <span class="notifications-panel__avatar-fallback" hidden aria-hidden="true">${escapeHtml(initial)}</span>`
      : `<span class="notifications-panel__avatar-fallback" aria-hidden="true" data-face-for="${escapeHtml(n.id)}">${escapeHtml(initial)}</span>`

    return `
      <article
        class="notifications-panel__item${unread ? ' is-unread' : ''}${link ? ' is-clickable' : ''}"
        data-id="${escapeHtml(n.id)}"
        ${link ? `data-link="${escapeHtml(link)}"` : ''}
      >
        <div class="notifications-panel__avatar">${avatar}</div>
        <div class="notifications-panel__content">
          <div class="notifications-panel__row-top">
            <span class="notifications-panel__item-title${accent === 'person' ? ' is-person' : ''}">${title}</span>
            ${rel ? `<time class="notifications-panel__item-time" datetime="${abs}" title="${abs}">${rel}</time>` : ''}
          </div>
          ${body ? `<p class="notifications-panel__item-body">${body}</p>` : ''}
          <div class="notifications-panel__row-foot">
            <span class="notifications-panel__type-badge notifications-panel__type-badge--${kind}" title="${escapeHtml(n.type)}">
              ${typeIconSvg(kind)}
            </span>
          </div>
        </div>
      </article>
    `
  }

  private resolveRowImage(n: DclNotification): string | null {
    const direct = notificationImageUrl(n)
    if (direct) return direct
    const addr = notificationActorAddress(n)
    if (addr && this.faceByAddress.has(addr)) return this.faceByAddress.get(addr) ?? null
    return null
  }

  /** Lazy-load catalyst face snapshots for social rows missing images. */
  private async hydrateFaces(): Promise<void> {
    const gen = ++this.faceFetchGen
    const need = new Set<string>()
    for (const n of this.items) {
      if (notificationImageUrl(n)) continue
      const addr = notificationActorAddress(n)
      if (addr && !this.faceByAddress.has(addr)) need.add(addr)
    }
    if (!need.size) return

    const base = catalystProfilesEndpoint()
    await Promise.all(
      [...need].map(async (wallet) => {
        try {
          const res = await fetch(`${base}/${encodeURIComponent(wallet)}`, {
            headers: { Accept: 'application/json' }
          })
          if (!res.ok) {
            this.faceByAddress.set(wallet, null)
            return
          }
          const data: unknown = await res.json()
          const profiles = Array.isArray(data) ? data : data ? [data] : []
          const avatars = (profiles[0] as { avatars?: unknown[] } | undefined)?.avatars
          const entry = Array.isArray(avatars) ? (avatars[0] as { avatar?: { snapshots?: { face256?: unknown } } }) : null
          const face = resolveFaceSnapshotUrl(entry?.avatar?.snapshots?.face256)
          this.faceByAddress.set(wallet, face)
        } catch {
          this.faceByAddress.set(wallet, null)
        }
      })
    )

    if (gen !== this.faceFetchGen || !this.visible) return
    // Patch avatars in-place without full re-render (preserves scroll).
    for (const n of this.items) {
      if (notificationImageUrl(n)) continue
      const addr = notificationActorAddress(n)
      if (!addr) continue
      const face = this.faceByAddress.get(addr)
      if (!face) continue
      const slot = this.listEl.querySelector(`[data-face-for="${CSS.escape(n.id)}"]`)
      if (!slot) continue
      const parent = slot.closest('.notifications-panel__avatar')
      if (!parent) continue
      parent.innerHTML = `<img class="notifications-panel__avatar-img" src="${escapeHtml(face)}" alt="" width="44" height="44" loading="lazy" decoding="async" />`
    }
  }

  private async markAllRead(): Promise<void> {
    const unreadIds = this.items.filter((n) => !n.read).map((n) => n.id)
    if (!unreadIds.length) return
    await this.markRead(unreadIds)
  }

  private async markRead(ids: string[]): Promise<void> {
    const identity = this.authIdentity()
    if (!identity || !ids.length) return
    this.markAllBtn.disabled = true
    const result = await markNotificationsRead(identity, ids)
    this.markAllBtn.disabled = false
    if (!result.ok) {
      this.statusEl.hidden = false
      this.statusEl.textContent = `Mark read failed: ${result.error}`
      return
    }
    const idSet = new Set(ids)
    this.items = this.items.map((n) => (idSet.has(n.id) ? { ...n, read: true } : n))
    const unread = this.items.filter((n) => !n.read).length
    this.options.onUnreadChange?.(unread)
    this.markAllBtn.hidden = unread === 0
    this.renderList(this.items.length ? null : 'No notifications yet.')
    void this.hydrateFaces()
  }
}
