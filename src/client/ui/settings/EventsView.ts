import {
  type DclEvent,
  ROLLING_EVENTS_DAY_COLUMNS,
  eventCreatorFaceUrl,
  eventHeroImageSrc,
  eventJumpRoute,
  eventLocationLabel,
  eventOccurrenceStartMs,
  eventPosterSrc,
  eventRecurrenceLabel,
  eventShareUrl,
  eventsByLocalDay,
  fetchDclActiveEventsWithLive,
  formatEventScheduleRange,
  formatLocalDayHeading,
  groupEventsIntoRollingLocalDays,
  isEventLiveNow,
  isEventRecurring,
  localDayStartAfterOffset,
  localDayStartMs
} from '../../../social/dclEvents'
import type { AuthIdentity } from '@dcl/crypto/dist/types'
import type { RouteTarget } from '../../../dcl/content/route'
import { CreateEventView } from './CreateEventView'

const DOW_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

const COPY_ICON = `<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><rect x="8" y="8" width="11" height="11" rx="1.5" stroke="currentColor" stroke-width="1.5" fill="none"/><path d="M6 16V5.5A1.5 1.5 0 0 1 7.5 4H16" stroke="currentColor" stroke-width="1.5" fill="none"/></svg>`
const CALENDAR_ICON = `<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><rect x="5" y="6" width="14" height="13" rx="1.5" stroke="currentColor" stroke-width="1.5" fill="none"/><path d="M8 4.5V7M16 4.5V7M5 10h14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`

type EventsLayoutMode = 'weekly' | 'calendar'

type MonthCell = {
  dayStartMs: number
  inMonth: boolean
}

export type EventsViewOptions = {
  onJumpIn?: (target: RouteTarget, event: DclEvent) => void
  getAuthIdentity?: () => AuthIdentity | null
  getDefaultCoords?: () => { x: number; y: number } | null
  isWorldScene?: boolean
  worldName?: string | null
}

/** Events tab — calendar grid, highlight panel, rolling day columns. */
export class EventsView {
  readonly root: HTMLElement

  private readonly monthLabel: HTMLElement
  private readonly calendarGrid: HTMLElement
  private readonly highlightPanel: HTMLElement
  private readonly columnsRow: HTMLElement
  private readonly statusEl: HTMLElement
  private readonly toastEl: HTMLElement
  private readonly weekNavPrev: HTMLButtonElement
  private readonly weekNavNext: HTMLButtonElement

  private readonly onJumpIn?: (target: RouteTarget, event: DclEvent) => void
  private readonly getAuthIdentity?: () => AuthIdentity | null
  private readonly getDefaultCoords?: () => { x: number; y: number } | null
  private readonly isWorldScene?: boolean
  private readonly worldName?: string | null

  private createEventView: CreateEventView | null = null
  private readonly listShell: HTMLElement

  private events: DclEvent[] = []
  private eventsPerDay = new Map<number, DclEvent[]>()
  private viewYear: number
  private viewMonth: number
  private selectedDayMs: number
  private selectedEventId: string | null = null
  private dayWindowOffset = 0
  private layoutMode: EventsLayoutMode = 'weekly'
  private loading = false
  private error: string | null = null
  private disposed = false
  private toastTimer = 0

  constructor(opts: EventsViewOptions = {}) {
    this.onJumpIn = opts.onJumpIn
    this.getAuthIdentity = opts.getAuthIdentity
    this.getDefaultCoords = opts.getDefaultCoords
    this.isWorldScene = opts.isWorldScene
    this.worldName = opts.worldName

    const now = new Date()
    this.viewYear = now.getFullYear()
    this.viewMonth = now.getMonth()
    this.selectedDayMs = localDayStartMs(now.getTime())

    this.root = document.createElement('div')
    this.root.className = 'events-view events-view--weekly'
    this.root.innerHTML = `
      <div class="events-view__list-shell" data-list-shell>
      <header class="events-view__header">
        <div class="events-view__header-left">
          <h2 class="events-view__title">Events</h2>
          <span class="events-view__month-label" data-month-label></span>
        </div>
        <div class="events-view__header-actions">
          <div class="events-view__week-nav" data-week-nav>
            <button type="button" class="events-view__week-nav-btn" data-prev-week aria-label="Previous days">‹</button>
            <button type="button" class="events-view__week-nav-btn" data-next-week aria-label="Next days">›</button>
          </div>
          <div class="events-view__view-toggle" role="group" aria-label="Events layout">
            <button type="button" class="events-view__view-btn is-active" data-view-mode="weekly">Weekly</button>
            <button type="button" class="events-view__view-btn" data-view-mode="calendar">Calendar</button>
          </div>
          <button type="button" class="events-view__btn events-view__btn--ghost" data-today>Today</button>
          <button type="button" class="events-view__btn events-view__btn--primary" data-create>Create Event</button>
        </div>
      </header>

      <p class="events-view__status" data-status hidden></p>

      <div class="events-view__dow-row" aria-hidden="true">
        ${DOW_LABELS.map((d) => `<span class="events-view__dow-cell">${d}</span>`).join('')}
      </div>

      <div class="events-view__main">
        <div class="events-view__calendar-pane">
          <div class="events-view__calendar-toolbar">
            <button type="button" class="events-view__cal-nav" data-prev-month aria-label="Previous month">‹</button>
            <button type="button" class="events-view__cal-nav" data-next-month aria-label="Next month">›</button>
          </div>
          <div class="events-view__calendar-grid" data-calendar-grid role="grid" aria-label="Event calendar"></div>
        </div>
        <aside class="events-view__highlight" data-highlight aria-live="polite">
          <p class="events-view__highlight-empty">Select a day or event to see details</p>
        </aside>
      </div>

      <div class="events-view__columns" data-columns aria-label="Upcoming events by day"></div>

      <div class="events-view__toast" data-toast hidden role="status"></div>
      </div>
      <div class="events-view__create-mount" data-create-mount hidden></div>
    `

    this.listShell = this.root.querySelector('[data-list-shell]')!

    this.monthLabel = this.root.querySelector('[data-month-label]')!
    this.calendarGrid = this.root.querySelector('[data-calendar-grid]')!
    this.highlightPanel = this.root.querySelector('[data-highlight]')!
    this.columnsRow = this.root.querySelector('[data-columns]')!
    this.statusEl = this.root.querySelector('[data-status]')!
    this.toastEl = this.root.querySelector('[data-toast]')!
    this.weekNavPrev = this.root.querySelector('[data-prev-week]')!
    this.weekNavNext = this.root.querySelector('[data-next-week]')!

    this.root.querySelectorAll<HTMLButtonElement>('[data-view-mode]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const mode = btn.dataset.viewMode as EventsLayoutMode | undefined
        if (mode === 'weekly' || mode === 'calendar') this.setLayoutMode(mode)
      })
    })
    this.root.querySelector('[data-today]')!.addEventListener('click', () => this.goToToday())
    this.root.querySelector('[data-create]')!.addEventListener('click', () => this.openCreateEvent())
    this.root.querySelector('[data-prev-month]')!.addEventListener('click', () => this.shiftMonth(-1))
    this.root.querySelector('[data-next-month]')!.addEventListener('click', () => this.shiftMonth(1))
    this.weekNavPrev.addEventListener('click', () => this.shiftWeekWindow(-1))
    this.weekNavNext.addEventListener('click', () => this.shiftWeekWindow(1))

    this.calendarGrid.addEventListener('click', (ev) => {
      const btn = (ev.target as HTMLElement).closest<HTMLButtonElement>('[data-day-ms]')
      if (!btn) return
      const ms = Number(btn.dataset.dayMs)
      if (!Number.isFinite(ms)) return
      this.selectDay(ms)
    })

    this.root.addEventListener('click', (ev) => this.handleActionClick(ev))
  }

  mount(): void {
    void this.loadEvents()
    this.renderAll()
  }

  dispose(): void {
    this.disposed = true
    this.closeCreateEvent()
    window.clearTimeout(this.toastTimer)
    this.root.remove()
  }

  private openCreateEvent(): void {
    const identity = this.getAuthIdentity?.()
    if (!identity) {
      this.showToast('Connect your wallet to create a hangout')
      return
    }
    this.closeCreateEvent()
    const mount = this.root.querySelector('[data-create-mount]') as HTMLElement
    mount.hidden = false
    this.listShell.hidden = true
    this.root.classList.add('events-view--creating')

    this.createEventView = new CreateEventView({
      identity,
      defaultCoords: this.getDefaultCoords?.() ?? null,
      isWorldScene: this.isWorldScene,
      worldName: this.worldName,
      onCancel: () => this.closeCreateEvent(),
      onCreated: (event) => {
        this.closeCreateEvent()
        this.selectedEventId = event.id
        const ms = eventOccurrenceStartMs(event)
        if (Number.isFinite(ms)) {
          this.selectedDayMs = localDayStartMs(ms)
        }
        void this.loadEvents()
      },
      onToast: (message) => this.showToast(message)
    })
    mount.appendChild(this.createEventView.root)
  }

  private closeCreateEvent(): void {
    this.createEventView?.dispose()
    this.createEventView = null
    const mount = this.root.querySelector('[data-create-mount]') as HTMLElement
    mount.hidden = true
    mount.innerHTML = ''
    this.listShell.hidden = false
    this.root.classList.remove('events-view--creating')
  }

  private async loadEvents(): Promise<void> {
    this.loading = true
    this.error = null
    this.renderStatus()
    try {
      this.events = await fetchDclActiveEventsWithLive(100)
      this.eventsPerDay = eventsByLocalDay(this.events)
      if (!this.selectedEventId) {
        const todayEvents = this.eventsPerDay.get(this.selectedDayMs)
        if (todayEvents?.[0]) this.selectedEventId = todayEvents[0].id
        else if (this.events[0]) this.selectedEventId = this.events[0].id
      }
    } catch (err) {
      this.events = []
      this.eventsPerDay = new Map()
      this.error = err instanceof Error ? err.message : String(err)
    } finally {
      this.loading = false
      if (!this.disposed) this.renderAll()
    }
  }

  private goToToday(): void {
    const now = new Date()
    this.viewYear = now.getFullYear()
    this.viewMonth = now.getMonth()
    this.selectedDayMs = localDayStartMs(now.getTime())
    this.dayWindowOffset = 0
    const dayEvents = this.eventsPerDay.get(this.selectedDayMs)
    if (dayEvents?.[0]) this.selectedEventId = dayEvents[0].id
    this.renderAll()
    this.scrollColumnIntoView(this.selectedDayMs)
    if (this.layoutMode === 'calendar') {
      const todayBtn = this.calendarGrid.querySelector('.events-view__day--today')
      todayBtn?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    }
  }

  private shiftMonth(delta: number): void {
    const d = new Date(this.viewYear, this.viewMonth + delta, 1)
    this.viewYear = d.getFullYear()
    this.viewMonth = d.getMonth()
    this.renderCalendar()
    this.renderMonthLabel()
  }

  private shiftWeekWindow(deltaDays: number): void {
    this.dayWindowOffset += deltaDays
    const firstColMs = localDayStartAfterOffset(this.dayWindowOffset)
    this.selectedDayMs = firstColMs
    const dayEvents = this.eventsPerDay.get(firstColMs)
    this.selectedEventId = dayEvents?.[0]?.id ?? null
    this.renderColumns()
    this.renderHighlight()
    this.scrollColumnIntoView(firstColMs)
  }

  private selectDay(dayStartMs: number): void {
    this.selectedDayMs = dayStartMs
    const d = new Date(dayStartMs)
    if (d.getFullYear() !== this.viewYear || d.getMonth() !== this.viewMonth) {
      this.viewYear = d.getFullYear()
      this.viewMonth = d.getMonth()
    }
    if (this.layoutMode === 'calendar') {
      this.selectedEventId = null
    } else {
      const dayEvents = this.eventsPerDay.get(dayStartMs)
      if (dayEvents?.[0]) this.selectedEventId = dayEvents[0].id
    }
    this.renderAll()
    this.scrollColumnIntoView(dayStartMs)
  }

  private selectEvent(event: DclEvent): void {
    this.selectedEventId = event.id
    const ms = eventOccurrenceStartMs(event)
    if (Number.isFinite(ms)) {
      this.selectedDayMs = localDayStartMs(ms)
      const d = new Date(ms)
      this.viewYear = d.getFullYear()
      this.viewMonth = d.getMonth()
    }
    this.renderAll()
  }

  private scrollColumnIntoView(dayStartMs: number): void {
    if (this.layoutMode !== 'weekly') return
    const col = this.columnsRow.querySelector<HTMLElement>(`[data-col-day="${dayStartMs}"]`)
    col?.scrollIntoView({ inline: 'nearest', block: 'nearest', behavior: 'smooth' })
  }

  private setLayoutMode(mode: EventsLayoutMode): void {
    if (this.layoutMode === mode) return
    this.layoutMode = mode
    if (mode === 'calendar') {
      this.selectedEventId = null
    } else {
      const dayEvents = this.eventsPerDay.get(this.selectedDayMs)
      if (dayEvents?.[0]) this.selectedEventId = dayEvents[0].id
    }
    this.renderLayoutMode()
    if (mode === 'weekly') this.renderColumns()
    this.renderHighlight()
  }

  private renderLayoutMode(): void {
    this.root.classList.toggle('events-view--calendar', this.layoutMode === 'calendar')
    this.root.classList.toggle('events-view--weekly', this.layoutMode === 'weekly')
    this.root.querySelectorAll<HTMLButtonElement>('[data-view-mode]').forEach((btn) => {
      btn.classList.toggle('is-active', btn.dataset.viewMode === this.layoutMode)
      btn.setAttribute('aria-pressed', String(btn.dataset.viewMode === this.layoutMode))
    })
    const weekNav = this.root.querySelector('[data-week-nav]') as HTMLElement | null
    if (weekNav) weekNav.hidden = this.layoutMode !== 'weekly'
    if (this.layoutMode === 'calendar') {
      this.columnsRow.innerHTML = ''
      this.columnsRow.hidden = true
      this.renderCalendar()
      requestAnimationFrame(() => {
        void this.root.offsetHeight
        this.renderCalendar()
      })
    } else {
      this.columnsRow.hidden = false
    }
  }

  private showToast(message: string): void {
    this.toastEl.textContent = message
    this.toastEl.hidden = false
    this.toastEl.classList.add('is-visible')
    window.clearTimeout(this.toastTimer)
    this.toastTimer = window.setTimeout(() => {
      this.toastEl.classList.remove('is-visible')
      this.toastEl.hidden = true
    }, 2400)
  }

  private async copyEventLink(event: DclEvent): Promise<void> {
    const url = eventShareUrl(event)
    try {
      await navigator.clipboard.writeText(url)
      this.showToast('Event link copied')
    } catch {
      this.showToast('Could not copy link')
    }
  }

  private jumpToEvent(event: DclEvent): void {
    const target = eventJumpRoute(event)
    if (!target) {
      this.showToast('Jump location unavailable')
      return
    }
    this.onJumpIn?.(target, event)
  }

  private handleActionClick(ev: Event): void {
    const target = ev.target as HTMLElement

    const backBtn = target.closest<HTMLButtonElement>('[data-back-day-list]')
    if (backBtn) {
      ev.preventDefault()
      this.selectedEventId = null
      this.renderHighlight()
      return
    }

    const jumpBtn = target.closest<HTMLButtonElement>('[data-jump-event]')
    if (jumpBtn) {
      ev.preventDefault()
      ev.stopPropagation()
      const id = jumpBtn.dataset.jumpEvent
      const event = id ? this.events.find((e) => e.id === id) : null
      if (event) this.jumpToEvent(event)
      return
    }

    const copyBtn = target.closest<HTMLButtonElement>('[data-copy-event]')
    if (copyBtn) {
      ev.preventDefault()
      ev.stopPropagation()
      const id = copyBtn.dataset.copyEvent
      const event = id ? this.events.find((e) => e.id === id) : null
      if (event) void this.copyEventLink(event)
      return
    }

    const eventBtn = target.closest<HTMLButtonElement>('[data-event-id]')
    if (eventBtn && !target.closest('[data-jump-event], [data-copy-event]')) {
      const id = eventBtn.dataset.eventId
      if (!id) return
      const event = this.events.find((e) => e.id === id)
      if (event) this.selectEvent(event)
    }
  }

  private renderAll(): void {
    this.renderStatus()
    this.renderLayoutMode()
    this.renderMonthLabel()
    this.renderCalendar()
    this.renderHighlight()
    if (this.layoutMode === 'weekly') this.renderColumns()
  }

  private renderStatus(): void {
    if (this.loading) {
      this.statusEl.hidden = false
      this.statusEl.textContent = 'Loading events…'
      this.statusEl.className = 'events-view__status events-view__status--loading'
      return
    }
    if (this.error) {
      this.statusEl.hidden = false
      this.statusEl.textContent = this.error
      this.statusEl.className = 'events-view__status events-view__status--error'
      return
    }
    this.statusEl.hidden = true
  }

  private renderMonthLabel(): void {
    const label = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' }).format(
      new Date(this.viewYear, this.viewMonth, 1)
    )
    this.monthLabel.textContent = label
  }

  private renderCalendar(): void {
    const todayMs = localDayStartMs(Date.now())
    const cells = buildMonthCells(this.viewYear, this.viewMonth)

    this.calendarGrid.innerHTML = cells
      .map((cell) => {
        const dayNum = new Date(cell.dayStartMs).getDate()
        const dayEvents = this.eventsPerDay.get(cell.dayStartMs) ?? []
        const count = dayEvents.length
        const isToday = cell.dayStartMs === todayMs
        const isSelected = cell.dayStartMs === this.selectedDayMs
        const classes = [
          'events-view__day',
          cell.inMonth ? 'events-view__day--in-month' : 'events-view__day--muted',
          isToday ? 'events-view__day--today' : '',
          isSelected ? 'events-view__day--selected' : '',
          count > 0 ? 'events-view__day--has-events' : ''
        ]
          .filter(Boolean)
          .join(' ')

        const dots =
          count > 0
            ? `<span class="events-view__day-dots" aria-hidden="true">${'●'.repeat(Math.min(count, 3))}</span>`
            : ''

        return `<button type="button" class="${classes}" data-day-ms="${cell.dayStartMs}" role="gridcell" aria-label="${dayNum}${count ? `, ${count} event${count === 1 ? '' : 's'}` : ''}">
          <span class="events-view__day-num">${dayNum}</span>
          ${dots}
        </button>`
      })
      .join('')
  }

  private renderHighlight(): void {
    if (this.layoutMode === 'calendar') {
      this.renderCalendarDayPanel()
      return
    }

    const event = this.selectedEventId ? this.events.find((e) => e.id === this.selectedEventId) : null
    if (!event) {
      this.highlightPanel.innerHTML = `<p class="events-view__highlight-empty">Select an event to see details</p>`
      return
    }
    this.highlightPanel.innerHTML = this.renderEventDetailHtml(event, { compact: false })
    this.wireHighlightImages()
  }

  private renderCalendarDayPanel(): void {
    const dayEvents = this.eventsPerDay.get(this.selectedDayMs) ?? []
    const dayLabel = formatLocalDayHeading(this.selectedDayMs)
    const selected = this.selectedEventId
      ? this.events.find((e) => e.id === this.selectedEventId)
      : null

    if (dayEvents.length === 0) {
      this.highlightPanel.innerHTML = `
        <div class="events-view__day-panel">
          <h3 class="events-view__day-panel-title">${escapeHtml(dayLabel)}</h3>
          <p class="events-view__highlight-empty">No events on this day</p>
        </div>`
      return
    }

    const detailBlock =
      selected && dayEvents.some((e) => e.id === selected.id)
        ? `
        <div class="events-view__day-panel-detail">
          <button type="button" class="events-view__back-btn" data-back-day-list>← All events</button>
          ${this.renderEventDetailHtml(selected, { compact: true })}
        </div>`
        : ''

    const listItems = dayEvents
      .map((ev) => this.renderDayListItemHtml(ev, ev.id === this.selectedEventId))
      .join('')

    this.highlightPanel.innerHTML = `
      <div class="events-view__day-panel">
        <header class="events-view__day-panel-head">
          <h3 class="events-view__day-panel-title">${escapeHtml(dayLabel)}</h3>
          <span class="events-view__day-panel-count">${dayEvents.length} event${dayEvents.length === 1 ? '' : 's'}</span>
        </header>
        ${detailBlock}
        <div class="events-view__day-list" role="list">${listItems}</div>
      </div>`

    this.wireHighlightImages()
  }

  private renderDayListItemHtml(ev: DclEvent, selected: boolean): string {
    const poster = eventPosterSrc(ev)
    const live = isEventLiveNow(ev)
    return `
      <button type="button" class="events-view__day-item${selected ? ' is-selected' : ''}${live ? ' is-live' : ''}" data-event-id="${escapeHtml(ev.id)}" role="listitem">
        <div class="events-view__day-item-media">
          ${
            poster
              ? `<img class="events-view__day-item-img" src="${escapeHtml(poster)}" alt="" loading="lazy" />`
              : '<div class="events-view__day-item-img events-view__day-item-img--fallback" aria-hidden="true">📅</div>'
          }
          ${live ? '<span class="events-view__day-item-live">Live</span>' : ''}
        </div>
        <div class="events-view__day-item-body">
          <span class="events-view__day-item-name">${escapeHtml(eventDisplayName(ev))}</span>
          <span class="events-view__day-item-meta">${escapeHtml(formatEventTimeShort(ev))} · ${escapeHtml(eventLocationLabel(ev))}</span>
        </div>
      </button>`
  }

  private renderEventDetailHtml(event: DclEvent, opts: { compact: boolean }): string {
    const hero = eventHeroImageSrc(event)
    const live = isEventLiveNow(event)
    const desc = event.description?.trim()
    const face = eventCreatorFaceUrl(event)
    const recurrence = eventRecurrenceLabel(event)
    const scheduleRange = formatEventScheduleRange(event)
    const organizer = event.user_name?.trim()

    const organizerRow =
      organizer || face
        ? `<div class="events-view__organizer">
            ${
              face
                ? `<img class="events-view__organizer-avatar" src="${escapeHtml(face)}" alt="" loading="lazy" />`
                : '<span class="events-view__organizer-avatar events-view__organizer-avatar--fallback" aria-hidden="true">👤</span>'
            }
            <div class="events-view__organizer-text">
              ${organizer ? `<span class="events-view__organizer-name">By ${escapeHtml(organizer)}</span>` : ''}
              <span class="events-view__organizer-location">${escapeHtml(eventLocationLabel(event))}</span>
            </div>
          </div>`
        : ''

    const scheduleBlock =
      isEventRecurring(event) || recurrence
        ? `<section class="events-view__schedule">
            <h4 class="events-view__schedule-title">Schedule</h4>
            <p class="events-view__schedule-line">${escapeHtml(scheduleRange)}</p>
            ${recurrence ? `<p class="events-view__schedule-recur">${CALENDAR_ICON}<span>${escapeHtml(recurrence)}</span></p>` : ''}
          </section>`
        : ''

    const descBlock =
      desc && !opts.compact
        ? `<section class="events-view__what">
            <h4 class="events-view__what-title">What to expect</h4>
            <p class="events-view__highlight-desc">${escapeHtml(desc.replace(/<[^>]+>/g, ''))}</p>
          </section>`
        : ''

    return `
      <article class="events-view__highlight-card${opts.compact ? ' events-view__highlight-card--compact' : ''}">
        <div class="events-view__highlight-hero">
          ${
            hero
              ? `<img class="events-view__highlight-img" src="${escapeHtml(hero)}" alt="" loading="lazy" />`
              : `<div class="events-view__highlight-img events-view__highlight-img--fallback" aria-hidden="true">📅</div>`
          }
          ${live ? '<span class="events-view__live-badge">● Live</span>' : ''}
        </div>
        <h3 class="events-view__highlight-name">${escapeHtml(eventDisplayName(event))}</h3>
        <p class="events-view__highlight-meta">${escapeHtml(formatEventTime(event))}</p>
        ${organizerRow}
        <div class="events-view__highlight-actions">
          <button type="button" class="events-view__jump-btn" data-jump-event="${escapeHtml(event.id)}">Jump In</button>
          <button type="button" class="events-view__icon-btn" data-copy-event="${escapeHtml(event.id)}" aria-label="Copy event link" title="Copy link">${COPY_ICON}</button>
        </div>
        ${scheduleBlock}
        ${descBlock}
      </article>`
  }

  private wireHighlightImages(): void {
    this.highlightPanel.querySelectorAll<HTMLImageElement>('img').forEach((img) => {
      img.addEventListener(
        'error',
        () => {
          if (img.classList.contains('events-view__organizer-avatar')) {
            img.replaceWith(
              Object.assign(document.createElement('span'), {
                className: 'events-view__organizer-avatar events-view__organizer-avatar--fallback',
                textContent: '👤',
                ariaHidden: 'true'
              })
            )
            return
          }
          img.replaceWith(
            Object.assign(document.createElement('div'), {
              className: img.className + ' events-view__highlight-img--fallback',
              textContent: '📅',
              ariaHidden: 'true'
            })
          )
        },
        { once: true }
      )
    })
  }

  private renderColumns(): void {
    if (this.layoutMode !== 'weekly') return
    const columns = groupEventsIntoRollingLocalDays(this.events, {
      windowOffsetDays: this.dayWindowOffset,
      columnCount: ROLLING_EVENTS_DAY_COLUMNS
    })

    this.columnsRow.innerHTML = columns
      .map((col) => {
        const isSelectedCol = col.dayStartMs === this.selectedDayMs
        const cards =
          col.events.length === 0
            ? '<p class="events-view__col-empty">No events</p>'
            : col.events.map((ev) => this.renderWeeklyEventCardHtml(ev)).join('')

        return `<section class="events-view__col${isSelectedCol ? ' is-selected-col' : ''}" data-col-day="${col.dayStartMs}">
          <header class="events-view__col-head">${escapeHtml(col.headingLabel)}</header>
          <div class="events-view__col-list">${cards}</div>
        </section>`
      })
      .join('')

    this.columnsRow.querySelectorAll<HTMLImageElement>('.events-view__event-card-img').forEach((img) => {
      img.addEventListener(
        'error',
        () => {
          img.replaceWith(
            Object.assign(document.createElement('div'), {
              className: 'events-view__event-card-img events-view__event-card-img--fallback',
              textContent: '📅',
              ariaHidden: 'true'
            })
          )
        },
        { once: true }
      )
    })
  }

  private renderWeeklyEventCardHtml(ev: DclEvent): string {
    const poster = eventPosterSrc(ev)
    const live = isEventLiveNow(ev)
    const selected = ev.id === this.selectedEventId
    const face = eventCreatorFaceUrl(ev)
    return `<article class="events-view__event-card${selected ? ' is-selected' : ''}${live ? ' is-live' : ''}">
      <button type="button" class="events-view__event-card-main" data-event-id="${escapeHtml(ev.id)}">
        <div class="events-view__event-card-media">
          ${
            poster
              ? `<img class="events-view__event-card-img" src="${escapeHtml(poster)}" alt="" loading="lazy" />`
              : '<div class="events-view__event-card-img events-view__event-card-img--fallback" aria-hidden="true">📅</div>'
          }
          ${live ? '<span class="events-view__event-card-live">● Live</span>' : ''}
        </div>
        <div class="events-view__event-card-body">
          <div class="events-view__event-card-name">${escapeHtml(eventDisplayName(ev))}</div>
          <div class="events-view__event-card-time">${escapeHtml(formatEventTimeShort(ev))}</div>
          <div class="events-view__event-card-location">${escapeHtml(eventLocationLabel(ev))}</div>
          <div class="events-view__event-card-organizer">
            ${
              face
                ? `<img class="events-view__event-card-avatar" src="${escapeHtml(face)}" alt="" loading="lazy" />`
                : ''
            }
            <span class="events-view__event-card-organizer-name">${escapeHtml(ev.user_name?.trim() || 'Community')}</span>
          </div>
        </div>
      </button>
      <div class="events-view__event-card-actions">
        <button type="button" class="events-view__jump-btn events-view__jump-btn--sm" data-jump-event="${escapeHtml(ev.id)}">Jump In</button>
        <button type="button" class="events-view__icon-btn events-view__icon-btn--sm" data-copy-event="${escapeHtml(ev.id)}" aria-label="Copy event link" title="Copy link">${COPY_ICON}</button>
      </div>
    </article>`
  }
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function eventDisplayName(e: DclEvent): string {
  const name = e.name?.trim()
  return name || 'Untitled event'
}

function formatEventTime(e: DclEvent): string {
  const ms = eventOccurrenceStartMs(e)
  if (!Number.isFinite(ms)) return 'Schedule TBC'
  return new Intl.DateTimeFormat(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  }).format(new Date(ms))
}

function formatEventTimeShort(e: DclEvent): string {
  const ms = eventOccurrenceStartMs(e)
  if (!Number.isFinite(ms)) return 'TBC'
  return new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: '2-digit'
  }).format(new Date(ms))
}

function buildMonthCells(year: number, month: number): MonthCell[] {
  const first = new Date(year, month, 1)
  const lastDay = new Date(year, month + 1, 0).getDate()
  const startOffset = (first.getDay() + 6) % 7
  const cells: MonthCell[] = []

  for (let i = startOffset - 1; i >= 0; i--) {
    const d = new Date(year, month, -i)
    cells.push({ dayStartMs: localDayStartMs(d.getTime()), inMonth: false })
  }
  for (let day = 1; day <= lastDay; day++) {
    cells.push({ dayStartMs: localDayStartMs(new Date(year, month, day).getTime()), inMonth: true })
  }
  while (cells.length < 42) {
    const nextDay = cells.length - (startOffset + lastDay) + 1
    const d = new Date(year, month + 1, nextDay)
    cells.push({ dayStartMs: localDayStartMs(d.getTime()), inMonth: false })
  }
  return cells.slice(0, 42)
}