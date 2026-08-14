/**
 * Compact post-settle result modal — replaces the full trade window on success.
 * "Trade Success!" + View TX (Polygonscan) + Close.
 */

export type TradeResultModalOptions = {
  kind: 'success' | 'failed'
  title?: string
  /** Optional short subtitle under the title. */
  detail?: string
  /** Full 0x… tx hash — enables View TX when valid. */
  txHash?: string | null
  onClose: () => void
}

export class TradeResultModal {
  readonly root: HTMLElement
  private readonly opts: TradeResultModalOptions
  private disposed = false

  constructor(opts: TradeResultModalOptions) {
    this.opts = opts
    this.root = document.createElement('div')
    this.root.className = 'trade-result-host'
    this.root.innerHTML = this.render()
    document.body.appendChild(this.root)
    this.bind()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    window.removeEventListener('keydown', this.onKey, true)
    this.root.remove()
  }

  private render(): string {
    const ok = this.opts.kind === 'success'
    const title = escapeHtml(
      this.opts.title?.trim() || (ok ? 'Trade Success!' : 'Trade Failed')
    )
    const detail = (this.opts.detail || '').trim()
    const tx = (this.opts.txHash || '').trim()
    const hasTx = ok && /^0x[a-fA-F0-9]{64}$/.test(tx)
    const shortTx = hasTx ? `${tx.slice(0, 10)}…${tx.slice(-6)}` : ''

    return `
      <div class="trade-result-backdrop" data-trade-result-close></div>
      <div class="trade-result" role="dialog" aria-label="${title}" aria-modal="true">
        <div class="trade-result__badge ${ok ? 'trade-result__badge--ok' : 'trade-result__badge--err'}">
          ${ok ? '✓' : '✕'}
        </div>
        <h2 class="trade-result__title">${title}</h2>
        ${
          detail
            ? `<p class="trade-result__detail">${escapeHtml(detail)}</p>`
            : ok
              ? `<p class="trade-result__detail">Items swapped on Polygon.</p>`
              : ''
        }
        ${
          hasTx
            ? `<p class="trade-result__tx-hash" title="${escapeAttr(tx)}">${escapeHtml(shortTx)}</p>`
            : ''
        }
        <div class="trade-result__actions">
          ${
            hasTx
              ? `<a class="trade-result__btn trade-result__btn--tx" href="${escapeAttr(
                  `https://polygonscan.com/tx/${tx}`
                )}" target="_blank" rel="noopener noreferrer" data-trade-result-tx>
                  View TX
                </a>`
              : ''
          }
          <button type="button" class="trade-result__btn trade-result__btn--close" data-trade-result-close>
            Close
          </button>
        </div>
      </div>
    `
  }

  private bind(): void {
    this.root.addEventListener('click', (ev) => {
      const t = ev.target as HTMLElement | null
      if (!t) return
      // Don't treat the View TX link as close.
      if (t.closest('[data-trade-result-tx]')) return
      if (t.closest('[data-trade-result-close]')) {
        this.opts.onClose()
        this.dispose()
      }
    })
    window.addEventListener('keydown', this.onKey, true)
  }

  private onKey = (e: KeyboardEvent): void => {
    if (this.disposed) return
    if (e.key === 'Escape') {
      e.preventDefault()
      this.opts.onClose()
      this.dispose()
    }
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
