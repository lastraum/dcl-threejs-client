import { fetchProfileFaceUrl } from '../../../avatar/peerApi'
import type { RouteTarget } from '../../../dcl/content/route'
import {
  type DclEvent,
  eventCreatorFaceUrl,
  eventHeroImageSrc,
  eventJumpRoute,
  eventLocationLabel,
  eventShareUrl,
  formatEventScheduleRange,
  isEventLiveNow
} from '../../../social/dclEvents'

const CLOCK_ICON = `<svg class="events-modal-pill-svg" width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.5"/><path d="M12 7v5l3 2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`
const PIN_ICON = `<svg class="events-modal-pill-svg" width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden><path d="M12 21s6-5.2 6-10a6 6 0 1 0-12 0c0 4.8 6 10 6 10z" stroke="currentColor" stroke-width="1.5"/><circle cx="12" cy="11" r="2" stroke="currentColor" stroke-width="1.5"/></svg>`
const JUMP_ARROW = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden><path d="M5 12h12M13 6l6 6-6 6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`

export type EventModalOptions = {
  onJumpIn?: (target: RouteTarget, event: DclEvent) => void
  onViewScene?: (target: RouteTarget, event: DclEvent) => void
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function eventDisplayName(e: DclEvent): string {
  const name = e.name?.trim()
  return name || 'Untitled event'
}

function organizerLabel(e: DclEvent): string {
  const name = e.user_name?.trim()
  if (name) return name
  const addr = e.user?.trim()
  if (addr && addr.length >= 10) return `${addr.slice(0, 6)}…${addr.slice(-4)}`
  return 'Organizer'
}

function descriptionParagraphs(raw: string | null | undefined): string[] {
  const text = raw?.trim()
  if (!text) return []
  return text
    .replace(/<[^>]+>/g, '')
    .split(/\n\n+/)
    .map((p) => p.trim())
    .filter(Boolean)
}

/** Companion-style event detail dialog — hero, schedule, description, scene + jump actions. */
export class EventModal {
  readonly root: HTMLElement

  private readonly onJumpIn?: EventModalOptions['onJumpIn']
  private readonly onViewScene?: EventModalOptions['onViewScene']
  private readonly onKeyDown: (ev: KeyboardEvent) => void
  private disposed = false

  constructor(opts: EventModalOptions = {}) {
    this.onJumpIn = opts.onJumpIn
    this.onViewScene = opts.onViewScene

    this.root = document.createElement('div')
    this.root.className = 'events-modal-host'
    this.root.hidden = true

    this.onKeyDown = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') this.close()
    }
  }

  mount(): void {
    document.body.appendChild(this.root)
  }

  open(event: DclEvent): void {
    if (this.disposed) return
    this.root.hidden = false
    this.root.innerHTML = this.render(event)
    this.wire(event)
    document.addEventListener('keydown', this.onKeyDown)
    document.body.classList.add('events-modal-open')
    this.root.querySelector<HTMLButtonElement>('.events-modal-close')?.focus()
    void this.hydrateOrganizerAvatar(event)
  }

  close(): void {
    this.root.hidden = true
    this.root.innerHTML = ''
    document.removeEventListener('keydown', this.onKeyDown)
    document.body.classList.remove('events-modal-open')
  }

  dispose(): void {
    this.disposed = true
    this.close()
    this.root.remove()
  }

  private wire(event: DclEvent): void {
    const backdrop = this.root.querySelector('.events-modal-backdrop')
    backdrop?.addEventListener('click', () => this.close())
    this.root.querySelector('.events-modal-panel')?.addEventListener('click', (e) => e.stopPropagation())
    this.root.querySelector('.events-modal-close')?.addEventListener('click', () => this.close())

    const jumpTarget = eventJumpRoute(event)
    this.root.querySelector('[data-event-jump]')?.addEventListener('click', () => {
      if (!jumpTarget) return
      this.close()
      this.onJumpIn?.(jumpTarget, event)
    })
    this.root.querySelector('[data-event-view-scene]')?.addEventListener('click', () => {
      if (!jumpTarget) return
      this.close()
      this.onViewScene?.(jumpTarget, event)
    })
    this.root.querySelector('[data-event-copy]')?.addEventListener('click', () => {
      void navigator.clipboard?.writeText(eventShareUrl(event))
    })

    const hero = this.root.querySelector<HTMLImageElement>('.events-modal-hero-img')
    hero?.addEventListener(
      'error',
      () => {
        hero.replaceWith(
          Object.assign(document.createElement('div'), {
            className: 'events-modal-hero-placeholder',
            ariaHidden: 'true'
          })
        )
      },
      { once: true }
    )
  }

  private async hydrateOrganizerAvatar(event: DclEvent): Promise<void> {
    const slot = this.root.querySelector<HTMLElement>('[data-organizer-avatar]')
    if (!slot) return

    const face = eventCreatorFaceUrl(event)
    if (face) {
      slot.innerHTML = `<img class="events-modal-by-avatar" src="${escapeHtml(face)}" alt="" width="32" height="32" />`
      return
    }

    const addr = event.user?.trim()
    if (!addr || !/^0x[a-fA-F0-9]{40}$/.test(addr)) return
    const profileFace = await fetchProfileFaceUrl(addr)
    if (this.disposed || this.root.hidden || !profileFace) return
    slot.innerHTML = `<img class="events-modal-by-avatar" src="${escapeHtml(profileFace)}" alt="" width="32" height="32" />`
  }

  private render(event: DclEvent): string {
    const hero = eventHeroImageSrc(event)
    const live = isEventLiveNow(event)
    const timing = formatEventScheduleRange(event)
    const location = eventLocationLabel(event)
    const creator = organizerLabel(event)
    const creatorInitial = creator.charAt(0).toUpperCase() || '?'
    const jumpTarget = eventJumpRoute(event)
    const paragraphs = descriptionParagraphs(event.description)
    const attending =
      typeof event.total_attendees === 'number' && event.total_attendees >= 0
        ? event.total_attendees
        : null

    const actions =
      jumpTarget && this.onViewScene && this.onJumpIn
        ? `<div class="events-modal-actions-pair">
            <button type="button" class="events-modal-chat" data-event-view-scene>View scene</button>
            <button type="button" class="events-modal-jump" data-event-jump>JUMP IN ${JUMP_ARROW}</button>
          </div>`
        : jumpTarget && this.onJumpIn
          ? `<button type="button" class="events-modal-jump" data-event-jump>JUMP IN ${JUMP_ARROW}</button>`
          : `<p class="events-modal-no-jump">No jump-in link for this event.</p>`

    const descBlock =
      paragraphs.length > 0
        ? `<div class="events-modal-desc">${paragraphs.map((p) => `<p class="events-modal-desc-p">${escapeHtml(p)}</p>`).join('')}</div>`
        : ''

    return `
      <div class="events-modal-backdrop" role="presentation">
        <div
          class="events-modal-panel"
          role="dialog"
          aria-modal="true"
          aria-labelledby="events-modal-title"
        >
          <button type="button" class="events-modal-close" aria-label="Close">&times;</button>
          <div class="events-modal-split">
            <div class="events-modal-media">
              ${
                hero
                  ? `<img class="events-modal-hero-img" src="${escapeHtml(hero)}" alt="" decoding="async" />`
                  : '<div class="events-modal-hero-placeholder" aria-hidden></div>'
              }
              ${
                live
                  ? `<span class="events-modal-live-badge" aria-label="Live now">
                      <span class="events-modal-live-dot" aria-hidden></span>
                      LIVE${attending !== null ? ` +${attending}` : ''}
                    </span>`
                  : ''
              }
            </div>
            <div class="events-modal-detail">
              <h2 id="events-modal-title" class="events-modal-title">${escapeHtml(eventDisplayName(event))}</h2>
              <div class="events-modal-meta-row">
                <div class="events-modal-meta-main">
                  <div class="events-modal-by">
                    <span data-organizer-avatar>
                      <span class="events-modal-by-fallback" aria-hidden>${escapeHtml(creatorInitial)}</span>
                    </span>
                    <span class="events-modal-by-text">
                      By <span class="events-modal-by-name">${escapeHtml(creator)}</span>
                    </span>
                  </div>
                  <div class="events-modal-pills">
                    <span class="events-modal-pill">${CLOCK_ICON}${escapeHtml(timing)}</span>
                    ${
                      location
                        ? `<span class="events-modal-pill">${PIN_ICON}${escapeHtml(location)}</span>`
                        : ''
                    }
                  </div>
                </div>
                <div class="events-modal-actions events-modal-actions--in-meta${
                  jumpTarget ? '' : ' events-modal-actions--in-meta-no-jump'
                }">
                  ${actions}
                </div>
              </div>
              ${descBlock}
              <button type="button" class="events-modal-copy-link" data-event-copy>Copy event link</button>
            </div>
          </div>
        </div>
      </div>
    `
  }
}