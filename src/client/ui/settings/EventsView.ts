import {
  type DclEvent,
  ROLLING_EVENTS_DAY_COLUMNS,
  eventHeroImageSrc,
  eventLocationLabel,
  eventOccurrenceStartMs,
  eventPosterSrc,
  eventsByLocalDay,
  fetchDclActiveEventsWithLive,
  groupEventsIntoRollingLocalDays,
  isEventLiveNow,
  localDayStartMs
} from '../../../social/dclEvents'

const DOW_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

type EventsLayoutMode = 'weekly' | 'calendar'

type MonthCell = {
  dayStartMs: number
  inMonth: boolean
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
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

function eventDisplayName(e: DclEvent): string {
  const name = e.name?.trim()
  return name || 'Untitled event'
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

  constructor() {
    const now = new Date()
    this.viewYear = now.getFullYear()
    this.viewMonth = now.getMonth()
    this.selectedDayMs = localDayStartMs(now.getTime())

    this.root = document.createElement('div')
    this.root.className = 'events-view events-view--weekly'
    this.root.innerHTML = `
      <header class="events-view__header">
        <div class="events-view__header-left">
          <h2 class="events-view__title">Events</h2>
          <span class="events-view__month-label" data-month-label></span>
        </div>
        <div class="events-view__header-actions">
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
          <p class="events-view__highlight-empty">Select an event to see details</p>
        </aside>
      </div>

      <div class="events-view__columns" data-columns aria-label="Upcoming events by day"></div>

      <div class="events-view__toast" data-toast hidden role="status"></div>
    `

    this.monthLabel = this.root.querySelector('[data-month-label]')!
    this.calendarGrid = this.root.querySelector('[data-calendar-grid]')!
    this.highlightPanel = this.root.querySelector('[data-highlight]')!
    this.columnsRow = this.root.querySelector('[data-columns]')!
    this.statusEl = this.root.querySelector('[data-status]')!
    this.toastEl = this.root.querySelector('[data-toast]')!

    this.root.querySelectorAll<HTMLButtonElement>('[data-view-mode]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const mode = btn.dataset.viewMode as EventsLayoutMode | undefined
        if (mode === 'weekly' || mode === 'calendar') this.setLayoutMode(mode)
      })
    })
    this.root.querySelector('[data-today]')!.addEventListener('click', () => this.goToToday())
    this.root.querySelector('[data-create]')!.addEventListener('click', () => this.showToast('Create Event — coming soon'))
    this.root.querySelector('[data-prev-month]')!.addEventListener('click', () => this.shiftMonth(-1))
    this.root.querySelector('[data-next-month]')!.addEventListener('click', () => this.shiftMonth(1))

    this.calendarGrid.addEventListener('click', (ev) => {
      const btn = (ev.target as HTMLElement).closest<HTMLButtonElement>('[data-day-ms]')
      if (!btn) return
      const ms = Number(btn.dataset.dayMs)
      if (!Number.isFinite(ms)) return
      this.selectDay(ms)
    })

    this.columnsRow.addEventListener('click', (ev) => {
      const btn = (ev.target as HTMLElement).closest<HTMLButtonElement>('[data-event-id]')
      if (!btn) return
      const id = btn.dataset.eventId
      if (!id) return
      const event = this.events.find((e) => e.id === id)
      if (event) this.selectEvent(event)
    })
  }

  mount(): void {
    void this.loadEvents()
    this.renderAll()
  }

  dispose(): void {
    this.disposed = true
    window.clearTimeout(this.toastTimer)
    this.root.remove()
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

  private selectDay(dayStartMs: number): void {
    this.selectedDayMs = dayStartMs
    const d = new Date(dayStartMs)
    if (d.getFullYear() !== this.viewYear || d.getMonth() !== this.viewMonth) {
      this.viewYear = d.getFullYear()
      this.viewMonth = d.getMonth()
    }
    const dayEvents = this.eventsPerDay.get(dayStartMs)
    if (dayEvents?.[0]) this.selectedEventId = dayEvents[0].id
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
    this.renderLayoutMode()
    if (mode === 'weekly') this.renderColumns()
  }

  private renderLayoutMode(): void {
    this.root.classList.toggle('events-view--calendar', this.layoutMode === 'calendar')
    this.root.classList.toggle('events-view--weekly', this.layoutMode === 'weekly')
    this.root.querySelectorAll<HTMLButtonElement>('[data-view-mode]').forEach((btn) => {
      btn.classList.toggle('is-active', btn.dataset.viewMode === this.layoutMode)
      btn.setAttribute('aria-pressed', String(btn.dataset.viewMode === this.layoutMode))
    })
    if (this.layoutMode === 'calendar') {
      this.columnsRow.innerHTML = ''
      this.columnsRow.hidden = true
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
    const event = this.selectedEventId ? this.events.find((e) => e.id === this.selectedEventId) : null
    if (!event) {
      this.highlightPanel.innerHTML = `<p class="events-view__highlight-empty">Select an event to see details</p>`
      return
    }

    const hero = eventHeroImageSrc(event)
    const live = isEventLiveNow(event)
    const desc = event.description?.trim()

    this.highlightPanel.innerHTML = `
      <article class="events-view__highlight-card">
        ${
          hero
            ? `<img class="events-view__highlight-img" src="${escapeHtml(hero)}" alt="" loading="lazy" />`
            : `<div class="events-view__highlight-img events-view__highlight-img--fallback" aria-hidden="true">📅</div>`
        }
        ${live ? '<span class="events-view__live-badge">Live now</span>' : ''}
        <h3 class="events-view__highlight-name">${escapeHtml(eventDisplayName(event))}</h3>
        <p class="events-view__highlight-meta">${escapeHtml(formatEventTime(event))}</p>
        <p class="events-view__highlight-meta">${escapeHtml(eventLocationLabel(event))}</p>
        ${
          event.user_name
            ? `<p class="events-view__highlight-organizer">By ${escapeHtml(event.user_name)}</p>`
            : ''
        }
        ${
          desc
            ? `<p class="events-view__highlight-desc">${escapeHtml(desc.replace(/<[^>]+>/g, ''))}</p>`
            : ''
        }
      </article>
    `

    const img = this.highlightPanel.querySelector<HTMLImageElement>('.events-view__highlight-img')
    img?.addEventListener('error', () => {
      img.replaceWith(Object.assign(document.createElement('div'), {
        className: 'events-view__highlight-img events-view__highlight-img--fallback',
        textContent: '📅',
        ariaHidden: 'true'
      }))
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
            : col.events
                .map((ev) => {
                  const poster = eventPosterSrc(ev)
                  const live = isEventLiveNow(ev)
                  const selected = ev.id === this.selectedEventId
                  return `<button type="button" class="events-view__event-card${selected ? ' is-selected' : ''}${live ? ' is-live' : ''}" data-event-id="${escapeHtml(ev.id)}">
                    <div class="events-view__event-card-media">
                      ${
                        poster
                          ? `<img class="events-view__event-card-img" src="${escapeHtml(poster)}" alt="" loading="lazy" />`
                          : '<div class="events-view__event-card-img events-view__event-card-img--fallback" aria-hidden="true">📅</div>'
                      }
                      ${live ? '<span class="events-view__event-card-live">Live</span>' : ''}
                    </div>
                    <span class="events-view__event-card-body">
                      <span class="events-view__event-card-name">${escapeHtml(eventDisplayName(ev))}</span>
                      <span class="events-view__event-card-meta">
                        <span class="events-view__event-card-time">${escapeHtml(formatEventTimeShort(ev))}</span>
                        <span class="events-view__event-card-location">${escapeHtml(eventLocationLabel(ev))}</span>
                      </span>
                    </span>
                  </button>`
                })
                .join('')

        return `<section class="events-view__col${isSelectedCol ? ' is-selected-col' : ''}" data-col-day="${col.dayStartMs}">
          <header class="events-view__col-head">${escapeHtml(col.headingLabel)}</header>
          <div class="events-view__col-list">${cards}</div>
        </section>`
      })
      .join('')
  }
}
