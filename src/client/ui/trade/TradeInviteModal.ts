/**
 * Diablo 4–style trade invite toast:
 * "{NAME} INVITED YOU TO TRADE" + countdown bar + Accept / Decline.
 */

export type TradeInviteModalOptions = {
  peerName: string
  peerFaceUrl?: string | null
  /** Absolute expiry time (unix ms). */
  expiresAt: number
  onAccept: () => void
  onDecline: () => void
  onExpire?: () => void
}

export class TradeInviteModal {
  readonly root: HTMLElement
  private readonly opts: TradeInviteModalOptions
  private disposed = false
  private raf = 0
  private readonly startedAt: number
  private readonly durationMs: number

  constructor(opts: TradeInviteModalOptions) {
    this.opts = opts
    this.startedAt = Date.now()
    this.durationMs = Math.max(1000, opts.expiresAt - this.startedAt)

    this.root = document.createElement('div')
    this.root.className = 'trade-invite-host'
    this.root.innerHTML = this.render()
    document.body.appendChild(this.root)
    this.bind()
    this.tick()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    if (this.raf) cancelAnimationFrame(this.raf)
    this.root.remove()
  }

  private render(): string {
    const name = escapeHtml(this.opts.peerName.toUpperCase())
    const face = this.opts.peerFaceUrl
      ? `<img class="trade-invite__face" src="${escapeAttr(this.opts.peerFaceUrl)}" alt="" decoding="async" />`
      : `<div class="trade-invite__face trade-invite__face--fallback">${escapeHtml(
          this.opts.peerName.charAt(0).toUpperCase() || '?'
        )}</div>`

    return `
      <div class="trade-invite" role="dialog" aria-label="Trade invite">
        <div class="trade-invite__ornament trade-invite__ornament--top"></div>
        <div class="trade-invite__row">
          <div class="trade-invite__face-wrap">${face}</div>
          <div class="trade-invite__copy">
            <div class="trade-invite__title">
              <span class="trade-invite__name">${name}</span>
              <span class="trade-invite__verb"> INVITED YOU TO TRADE</span>
            </div>
            <div class="trade-invite__bar" aria-hidden="true">
              <div class="trade-invite__bar-fill" data-trade-invite-bar></div>
            </div>
          </div>
        </div>
        <div class="trade-invite__actions">
          <button type="button" class="trade-invite__btn trade-invite__btn--accept" data-trade-invite-accept>
            Accept
          </button>
          <button type="button" class="trade-invite__btn trade-invite__btn--decline" data-trade-invite-decline>
            Decline
          </button>
        </div>
        <div class="trade-invite__ornament trade-invite__ornament--bottom"></div>
      </div>
    `
  }

  private bind(): void {
    this.root.querySelector('[data-trade-invite-accept]')?.addEventListener('click', () => {
      if (this.disposed) return
      this.opts.onAccept()
      this.dispose()
    })
    this.root.querySelector('[data-trade-invite-decline]')?.addEventListener('click', () => {
      if (this.disposed) return
      this.opts.onDecline()
      this.dispose()
    })
  }

  private tick = (): void => {
    if (this.disposed) return
    const now = Date.now()
    const left = this.opts.expiresAt - now
    const fill = this.root.querySelector<HTMLElement>('[data-trade-invite-bar]')
    if (fill) {
      const pct = Math.max(0, Math.min(1, left / this.durationMs))
      fill.style.transform = `scaleX(${pct})`
    }
    if (left <= 0) {
      this.opts.onExpire?.()
      this.dispose()
      return
    }
    this.raf = requestAnimationFrame(this.tick)
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function escapeAttr(value: string): string {
  return escapeHtml(value).replace(/'/g, '&#39;')
}
