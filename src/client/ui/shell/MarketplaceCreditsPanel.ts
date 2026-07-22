import type { SessionIdentity } from '../../../network/SessionIdentity'
import {
  fetchSeasons,
  fetchUserCredits,
  formatCreditsAmount,
  latestClosedSeason,
  MARKETPLACE_URL,
  type SeasonInfo,
  type UserCreditsResponse
} from '../../../social/creditsApi'

export type MarketplaceCreditsPanelOptions = {
  getSession: () => SessionIdentity
  onClose?: () => void
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

const BAG_ICON = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
  <path d="M6 8h12l-1 12H7L6 8z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>
  <path d="M9 8V6a3 3 0 0 1 6 0v2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
</svg>`

/**
 * Explorer-style Weekly Rewards / Marketplace Credits modal.
 * Credits: GET /users/{address}/credits · Seasons: GET /seasons
 */
export class MarketplaceCreditsPanel {
  readonly element: HTMLDivElement
  private visible = false
  private readonly bodyEl: HTMLElement
  private readonly onKeyDown: (ev: KeyboardEvent) => void

  constructor(private readonly options: MarketplaceCreditsPanelOptions) {
    this.element = document.createElement('div')
    this.element.className = 'marketplace-credits-panel'
    this.element.hidden = true
    this.element.setAttribute('role', 'dialog')
    this.element.setAttribute('aria-modal', 'true')
    this.element.setAttribute('aria-label', 'Marketplace credits')
    this.element.innerHTML = `
      <div class="marketplace-credits-panel__backdrop" data-close></div>
      <div class="marketplace-credits-panel__card">
        <button type="button" class="marketplace-credits-panel__close" data-close aria-label="Close">×</button>
        <div class="marketplace-credits-panel__body" data-body>
          <p class="marketplace-credits-panel__loading">Loading…</p>
        </div>
      </div>
    `
    this.bodyEl = this.element.querySelector('[data-body]')!

    this.element.querySelectorAll('[data-close]').forEach((el) => {
      el.addEventListener('click', () => this.hide())
    })

    this.onKeyDown = (ev) => {
      if (ev.key === 'Escape' && this.visible) this.hide()
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
    document.body.classList.add('marketplace-credits-open')
    document.addEventListener('keydown', this.onKeyDown)
    this.bodyEl.innerHTML = `<p class="marketplace-credits-panel__loading">Loading…</p>`
    await this.reload()
  }

  hide(): void {
    if (!this.visible) return
    this.visible = false
    this.element.hidden = true
    document.body.classList.remove('marketplace-credits-open')
    document.removeEventListener('keydown', this.onKeyDown)
    this.options.onClose?.()
  }

  dispose(): void {
    this.hide()
    this.element.remove()
  }

  private async reload(): Promise<void> {
    const address = this.options.getSession().getAddress()
    const seasonsP = fetchSeasons()
    const creditsP = address
      ? fetchUserCredits(address)
      : Promise.resolve({ ok: true as const, data: { credits: [], totalCredits: 0 } })

    const [seasonsRes, creditsRes] = await Promise.all([seasonsP, creditsP])

    if (!this.visible) return

    const seasons = seasonsRes.ok ? seasonsRes.data : null
    const credits: UserCreditsResponse | null = creditsRes.ok ? creditsRes.data : null
    const total = credits?.totalCredits ?? 0
    const current = seasons?.current?.isActive ? seasons.current : null
    const closed = seasons ? latestClosedSeason(seasons) : null
    const next = seasons?.next ?? null

    let seasonBlock = ''
    if (!seasonsRes.ok) {
      seasonBlock = `
        <div class="marketplace-credits-panel__banner marketplace-credits-panel__banner--warn">
          <p class="marketplace-credits-panel__banner-title">Could not load seasons</p>
          <p class="marketplace-credits-panel__banner-text">${escapeHtml(seasonsRes.error)}</p>
        </div>`
    } else if (current) {
      seasonBlock = this.renderActiveSeason(current)
    } else if (closed) {
      seasonBlock = this.renderClosedSeason(closed, next)
    } else if (next) {
      seasonBlock = this.renderUpcomingSeason(next)
    } else {
      seasonBlock = `
        <div class="marketplace-credits-panel__banner">
          <p class="marketplace-credits-panel__banner-title">No active credits season</p>
          <p class="marketplace-credits-panel__banner-text">
            Check back later for Marketplace Credits seasons.
          </p>
        </div>`
    }

    if (creditsRes.ok === false && creditsRes.flagged) {
      seasonBlock = `
        <div class="marketplace-credits-panel__banner marketplace-credits-panel__banner--warn">
          <p class="marketplace-credits-panel__banner-title">Credits unavailable</p>
          <p class="marketplace-credits-panel__banner-text">${escapeHtml(creditsRes.error)}</p>
        </div>` + seasonBlock
    }

    const guestNote = !address
      ? `<p class="marketplace-credits-panel__guest">Sign in with a wallet to see your credits balance.</p>`
      : creditsRes.ok === false && !creditsRes.flagged
        ? `<p class="marketplace-credits-panel__guest">Could not load credits: ${escapeHtml(creditsRes.error)}</p>`
        : ''

    this.bodyEl.innerHTML = `
      <div class="marketplace-credits-panel__layout">
        <div class="marketplace-credits-panel__hero" aria-hidden="true">
          <div class="marketplace-credits-panel__hero-glow"></div>
          <div class="marketplace-credits-panel__hero-figure">${HERO_SVG}</div>
        </div>
        <div class="marketplace-credits-panel__main">
          <header class="marketplace-credits-panel__head">
            <div>
              <h2 class="marketplace-credits-panel__title">Weekly Rewards</h2>
              <p class="marketplace-credits-panel__subtitle">Earn Marketplace Credits, Go Shopping!</p>
            </div>
            <div class="marketplace-credits-panel__balance-wrap">
              <div class="marketplace-credits-panel__balance">
                <span class="marketplace-credits-panel__balance-label">Your credits</span>
                <div class="marketplace-credits-panel__balance-row">
                  <span class="marketplace-credits-panel__balance-icon">${BAG_ICON}</span>
                  <span class="marketplace-credits-panel__balance-value" data-total>${escapeHtml(formatCreditsAmount(total))}</span>
                </div>
              </div>
              <a class="marketplace-credits-panel__cta" href="${escapeHtml(MARKETPLACE_URL)}" target="_blank" rel="noopener noreferrer">
                Go to Marketplace
              </a>
            </div>
          </header>
          ${guestNote}
          ${seasonBlock}
        </div>
      </div>
    `
  }

  private renderActiveSeason(s: SeasonInfo): string {
    const range = formatSeasonRange(s)
    return `
      <div class="marketplace-credits-panel__banner marketplace-credits-panel__banner--live">
        <p class="marketplace-credits-panel__banner-title">${escapeHtml(s.name)} is live</p>
        ${
          s.description
            ? `<p class="marketplace-credits-panel__banner-text">${escapeHtml(s.description)}</p>`
            : `<p class="marketplace-credits-panel__banner-text">Complete goals to earn Marketplace Credits this season.</p>`
        }
        ${range ? `<p class="marketplace-credits-panel__banner-meta">${escapeHtml(range)}</p>` : ''}
      </div>`
  }

  private renderClosedSeason(closed: SeasonInfo, next: SeasonInfo | null): string {
    const name = closed.name || `Season ${closed.id}`
    return `
      <div class="marketplace-credits-panel__banner">
        <p class="marketplace-credits-panel__banner-title">${escapeHtml(name)} Has Closed</p>
        <p class="marketplace-credits-panel__banner-text">
          <a href="https://decentraland.org/subscribe" target="_blank" rel="noopener noreferrer">Subscribe</a>
          to Decentraland’s newsletter or follow on
          <a href="https://x.com/decentraland" target="_blank" rel="noopener noreferrer">X</a>
          for news on the next season’s start date!
        </p>
        ${
          next
            ? `<p class="marketplace-credits-panel__banner-meta">Next: ${escapeHtml(next.name)}${next.startDate ? ` · starts ${escapeHtml(formatDate(next.startDate))}` : ''}</p>`
            : ''
        }
      </div>`
  }

  private renderUpcomingSeason(next: SeasonInfo): string {
    return `
      <div class="marketplace-credits-panel__banner">
        <p class="marketplace-credits-panel__banner-title">${escapeHtml(next.name)} coming soon</p>
        <p class="marketplace-credits-panel__banner-text">
          ${
            next.startDate
              ? `Starts ${escapeHtml(formatDate(next.startDate))}.`
              : 'Watch for the next Marketplace Credits season.'
          }
        </p>
      </div>`
  }
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric'
    })
  } catch {
    return iso
  }
}

function formatSeasonRange(s: SeasonInfo): string {
  if (!s.startDate && !s.endDate) return ''
  const a = s.startDate ? formatDate(s.startDate) : '…'
  const b = s.endDate ? formatDate(s.endDate) : '…'
  return `${a} – ${b}`
}

/** Stylized promo figure (no external asset). */
const HERO_SVG = `<svg class="marketplace-credits-panel__hero-svg" viewBox="0 0 200 280" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <ellipse cx="100" cy="260" rx="56" ry="10" fill="rgba(0,0,0,0.35)"/>
  <path d="M70 95c0-28 14-48 30-48s30 20 30 48c8 6 18 22 18 44 0 28-16 52-48 52s-48-24-48-52c0-22 10-38 18-44z" fill="#c42d6a"/>
  <path d="M78 100c4-22 12-36 22-36s18 14 22 36c12 8 20 24 20 42 0 24-12 44-42 44s-42-20-42-44c0-18 8-34 20-42z" fill="#e84a8a"/>
  <circle cx="100" cy="58" r="28" fill="#f0a0c0"/>
  <circle cx="100" cy="58" r="24" fill="#2a1830"/>
  <path d="M78 52c6-14 38-14 44 0" stroke="#e84a8a" stroke-width="6" stroke-linecap="round"/>
  <circle cx="90" cy="58" r="3" fill="#fff"/>
  <circle cx="110" cy="58" r="3" fill="#fff"/>
  <path d="M55 130c-18 8-28 28-22 48 4 14 18 22 34 18" stroke="#c42d6a" stroke-width="14" stroke-linecap="round"/>
  <path d="M145 130c18 8 28 28 22 48-4 14-18 22-34 18" stroke="#c42d6a" stroke-width="14" stroke-linecap="round"/>
  <path d="M72 188c4 28 8 48 12 62h32c4-14 8-34 12-62" fill="#8b1e4a"/>
  <rect x="86" y="118" width="28" height="36" rx="6" fill="#ff3d7a"/>
  <text x="100" y="142" text-anchor="middle" fill="#fff" font-size="14" font-weight="700" font-family="system-ui,sans-serif">T</text>
</svg>`
