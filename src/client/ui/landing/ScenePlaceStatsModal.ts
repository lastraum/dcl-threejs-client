import type { RouteTarget } from '../../../dcl/content/route'
import { fetchPlaceSummary, type PlaceSummary } from '../../../analytics/fetchPlaceSummary'
import { formatPlaceKeyLabel, placeFieldsFromRoute } from '../../../analytics/placeKey'
import { track } from '../../../analytics/track'

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function formatDwell(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return '—'
  const sec = Math.round(ms / 1000)
  if (sec < 60) return `${sec}s`
  const min = Math.floor(sec / 60)
  if (min < 60) {
    const r = sec % 60
    return r > 0 ? `${min}m ${r}s` : `${min}m`
  }
  const hr = Math.floor(min / 60)
  const rm = min % 60
  return rm > 0 ? `${hr}h ${rm}m` : `${hr}h`
}

function formatPct(rate: number): string {
  if (!Number.isFinite(rate) || rate <= 0) return '0%'
  return `${Math.round(rate * 100)}%`
}

function formatInt(n: number): string {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(n || 0)
}

const CHART_ICON = `<svg class="scene-place-stats-modal-pill-svg" width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
  <path d="M4 19V9M10 19V5M16 19v-7M22 19H2" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`

export type ScenePlaceStatsModalOptions = {
  onOpen?: () => void
  onClose?: () => void
}

/** Public place stats on scene landing — anyone can open. */
export class ScenePlaceStatsModal {
  readonly root: HTMLElement

  private readonly onOpenCb?: () => void
  private readonly onCloseCb?: () => void
  private readonly onKeyDown: (ev: KeyboardEvent) => void
  private openGen = 0
  private disposed = false
  private placeKey: string | null = null

  constructor(opts: ScenePlaceStatsModalOptions = {}) {
    this.onOpenCb = opts.onOpen
    this.onCloseCb = opts.onClose

    this.root = document.createElement('div')
    this.root.className = 'scene-place-stats-modal-host'
    this.root.hidden = true

    this.onKeyDown = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') this.close()
    }
  }

  mount(): void {
    document.body.appendChild(this.root)
  }

  open(
    route: Extract<RouteTarget, { kind: 'coords' } | { kind: 'world' }>,
    sceneTitle: string,
    pointerLabel: string
  ): void {
    if (this.disposed) return
    const fields = placeFieldsFromRoute(route)
    const placeKey = fields?.place_key
    if (!placeKey) return

    this.placeKey = placeKey
    const gen = ++this.openGen
    this.root.hidden = false
    this.root.innerHTML = this.renderShell(sceneTitle, pointerLabel, { loading: true })
    this.wire()
    document.addEventListener('keydown', this.onKeyDown)
    document.body.classList.add('scene-place-stats-modal-open')
    this.root.querySelector<HTMLButtonElement>('.scene-place-stats-modal-close')?.focus()
    this.onOpenCb?.()
    track('stats_panel_open', { route, props: { place_key: placeKey } })
    void this.load(placeKey, sceneTitle, pointerLabel, gen)
  }

  close(): void {
    if (!this.root.hidden && this.placeKey) {
      track('stats_panel_close', { props: { place_key: this.placeKey } })
    }
    this.openGen++
    this.root.hidden = true
    this.root.innerHTML = ''
    this.placeKey = null
    document.removeEventListener('keydown', this.onKeyDown)
    document.body.classList.remove('scene-place-stats-modal-open')
    this.onCloseCb?.()
  }

  dispose(): void {
    this.disposed = true
    this.close()
    this.root.remove()
  }

  private async load(
    placeKey: string,
    sceneTitle: string,
    pointerLabel: string,
    gen: number
  ): Promise<void> {
    try {
      const summary = await fetchPlaceSummary(placeKey, '7d')
      if (this.disposed || gen !== this.openGen || this.root.hidden) return
      this.root.innerHTML = this.renderShell(sceneTitle, pointerLabel, { loading: false, summary })
      this.wire()
    } catch {
      if (this.disposed || gen !== this.openGen || this.root.hidden) return
      this.root.innerHTML = this.renderShell(sceneTitle, pointerLabel, {
        loading: false,
        error: 'Could not load place stats. Try again in a moment.'
      })
      this.wire()
    }
  }

  private wire(): void {
    this.root
      .querySelector('.scene-place-stats-modal-backdrop')
      ?.addEventListener('click', () => this.close())
    this.root
      .querySelector('.scene-place-stats-modal-panel')
      ?.addEventListener('click', (e) => e.stopPropagation())
    this.root
      .querySelector('.scene-place-stats-modal-close')
      ?.addEventListener('click', () => this.close())
  }

  private renderBars(summary: PlaceSummary): string {
    const series = summary.series
    if (series.length === 0) {
      return '<p class="scene-place-stats-modal-empty">No visits in the last 7 days yet.</p>'
    }
    const max = Math.max(
      1,
      ...series.map((d) => Math.max(d.scene_enters, d.landing_views))
    )
    const bars = series
      .map((d) => {
        const hEnter = Math.round((d.scene_enters / max) * 100)
        const hLand = Math.round((d.landing_views / max) * 100)
        const label = d.day.slice(5) // MM-DD
        const landN = formatInt(d.landing_views)
        const enterN = formatInt(d.scene_enters)
        const tipAria = `${d.day}: ${landN} landings, ${enterN} jump-ins`
        return `
          <div
            class="scene-place-stats-bar"
            tabindex="0"
            role="group"
            aria-label="${escapeHtml(tipAria)}"
          >
            <div class="scene-place-stats-bar-tip" role="tooltip">
              <strong>${escapeHtml(label)}</strong>
              <span><i class="land" aria-hidden></i> ${landN} landing${d.landing_views === 1 ? '' : 's'}</span>
              <span><i class="enter" aria-hidden></i> ${enterN} jump-in${d.scene_enters === 1 ? '' : 's'}</span>
            </div>
            <div class="scene-place-stats-bar-pair">
              <div class="scene-place-stats-bar-fill scene-place-stats-bar-fill--landings" style="height:${hLand}%"></div>
              <div class="scene-place-stats-bar-fill scene-place-stats-bar-fill--enters" style="height:${hEnter}%"></div>
            </div>
            <span class="scene-place-stats-bar-label">${escapeHtml(label)}</span>
          </div>
        `
      })
      .join('')
    return `
      <div class="scene-place-stats-chart-block">
        <div class="scene-place-stats-chart" role="list" aria-label="Landings and jump-ins by day, last 7 days">
          ${bars}
        </div>
        <p class="scene-place-stats-chart-legend">
          <span><i class="land" aria-hidden></i> Landings</span>
          <span><i class="enter" aria-hidden></i> Jump-ins</span>
          <span>· last 7 days</span>
        </p>
      </div>
    `
  }

  private renderOutbound(summary: PlaceSummary): string {
    if (!summary.top_outbound.length) return ''
    const items = summary.top_outbound
      .map(
        (o) =>
          `<li><span>${escapeHtml(formatPlaceKeyLabel(o.place_key))}</span><strong>${formatInt(o.count)}</strong></li>`
      )
      .join('')
    return `
      <div class="scene-place-stats-outbound">
        <h3 class="scene-place-stats-section-title">Top destinations from here</h3>
        <ul class="scene-place-stats-outbound-list">${items}</ul>
      </div>
    `
  }

  private renderMetrics(summary: PlaceSummary): string {
    const guest =
      summary.guest_share === null || summary.guest_share === undefined
        ? '—'
        : formatPct(summary.guest_share)
    return `
      <div class="scene-place-stats-grid">
        <div class="scene-place-stats-metric">
          <span class="scene-place-stats-metric-value">${formatInt(summary.landing_views)}</span>
          <span class="scene-place-stats-metric-label">Landing views</span>
        </div>
        <div class="scene-place-stats-metric">
          <span class="scene-place-stats-metric-value">${formatInt(summary.unique_visitors)}</span>
          <span class="scene-place-stats-metric-label">Unique visitors</span>
        </div>
        <div class="scene-place-stats-metric">
          <span class="scene-place-stats-metric-value">${formatInt(summary.scene_enters)}</span>
          <span class="scene-place-stats-metric-label">Jump-ins</span>
        </div>
        <div class="scene-place-stats-metric">
          <span class="scene-place-stats-metric-value">${formatPct(summary.jump_in_rate)}</span>
          <span class="scene-place-stats-metric-label">Jump-in rate</span>
        </div>
        <div class="scene-place-stats-metric">
          <span class="scene-place-stats-metric-value">${formatDwell(summary.median_landing_dwell_ms)}</span>
          <span class="scene-place-stats-metric-label">Median on landing</span>
        </div>
        <div class="scene-place-stats-metric">
          <span class="scene-place-stats-metric-value">${formatDwell(summary.median_dwell_ms)}</span>
          <span class="scene-place-stats-metric-label">Median in world</span>
        </div>
        <div class="scene-place-stats-metric">
          <span class="scene-place-stats-metric-value">${formatPct(summary.multi_visit_rate)}</span>
          <span class="scene-place-stats-metric-label">Multi-visit</span>
        </div>
      </div>
      <p class="scene-place-stats-footnote">
        ${formatInt(summary.unique_players)} unique players · Guest share ${escapeHtml(guest)} · Last 7 days · Public aggregates
      </p>
    `
  }

  private renderShell(
    sceneTitle: string,
    pointerLabel: string,
    state:
      | { loading: true }
      | { loading: false; summary: PlaceSummary }
      | { loading: false; error: string }
  ): string {
    const title = sceneTitle.trim() || 'This place'
    const sub = pointerLabel.trim() || 'Place stats'

    let body = ''
    if ('loading' in state && state.loading) {
      body = `
        <div class="scene-place-stats-modal-loading" aria-busy="true">
          <span class="scene-place-stats-modal-spinner" aria-hidden></span>
          <p>Loading stats…</p>
        </div>
      `
    } else if ('error' in state) {
      body = `<p class="scene-place-stats-modal-empty">${escapeHtml(state.error)}</p>`
    } else {
      const empty =
        state.summary.landing_views === 0 &&
        state.summary.scene_enters === 0 &&
        state.summary.unique_visitors === 0
      if (empty) {
        body = `
          <p class="scene-place-stats-modal-empty">
            No public stats yet for this place. Visit, jump in, and check back — aggregates appear for everyone.
          </p>
          ${this.renderMetrics(state.summary)}
        `
      } else {
        body = `
          ${this.renderMetrics(state.summary)}
          ${this.renderBars(state.summary)}
          ${this.renderOutbound(state.summary)}
        `
      }
    }

    return `
      <div class="scene-place-stats-modal-backdrop" role="presentation">
        <div
          class="scene-place-stats-modal-panel"
          role="dialog"
          aria-modal="true"
          aria-labelledby="scene-place-stats-modal-title"
        >
          <button type="button" class="scene-place-stats-modal-close" aria-label="Close">&times;</button>
          <header class="scene-place-stats-modal-header">
            <h2 id="scene-place-stats-modal-title" class="scene-place-stats-modal-title">${escapeHtml(title)}</h2>
            <p class="scene-place-stats-modal-subtitle">
              ${CHART_ICON}
              <span>${escapeHtml(sub)} · Public stats</span>
            </p>
          </header>
          <div class="scene-place-stats-modal-body">${body}</div>
        </div>
      </div>
    `
  }
}
