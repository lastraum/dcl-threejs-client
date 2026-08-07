/**
 * Diablo 4–style dual trade window:
 * local offer grid + counterparty offer grid, gold/MANA, lock, accept.
 *
 * Item selection uses an in-window inventory overlay (not a second full backpack):
 * search, rarity, issue #, client-side pagination over the full owned set.
 */

import type { TradeItemWire, TradeOfferSnapshot } from '../../../social/tradeWire'
import { emptyOffer } from '../../../social/tradeWire'

export type TradeInventoryItem = TradeItemWire & {
  /** Local inventory key (unique complete URN). */
  key: string
  /** Issue / mint number when known (e.g. "42"). */
  issue?: string
  /** Max supply for rarity tier when known (e.g. "100"). */
  maxSupply?: string
  /** Category label for search. */
  category?: string
}

export type TradeWindowOptions = {
  localName: string
  localFaceUrl?: string | null
  peerName: string
  peerFaceUrl?: string | null
  /** Full peer wallet — shown under display name so settle can't hide a wrong identity. */
  peerAddress?: string | null
  /** Owned items the user can put into the trade (full inventory). May start empty while loading. */
  inventory: TradeInventoryItem[]
  /** True while inventory is still loading in the background. */
  inventoryLoading?: boolean
  onLocalOfferChange: (offer: TradeOfferSnapshot) => void
  /** User requested close (X / backdrop / Escape) — parent should confirm. */
  onClose: () => void
  /** Called when user clicks Accept Trade (both must be locked first). */
  onAcceptTrade: () => void
}

/** Max items per offer side (3-col scrollable grid). */
const GRID_MAX_ITEMS = 24
/** Minimum empty cells shown (3×3 visual floor) before scroll. */
const GRID_MIN_CELLS = 9
const PICKER_PAGE_SIZE = 24

const RARITY_CLASS: Record<string, string> = {
  unique: 'rarity-unique',
  mythic: 'rarity-mythic',
  exotic: 'rarity-exotic',
  legendary: 'rarity-legendary',
  epic: 'rarity-epic',
  rare: 'rarity-rare',
  uncommon: 'rarity-uncommon',
  common: 'rarity-common',
  base: 'rarity-base'
}

/** Window lifecycle after both accept / settle ends. */
export type TradeWindowPhase = 'trade' | 'settling' | 'success' | 'failed'

export class TradeWindow {
  readonly root: HTMLElement
  private readonly opts: TradeWindowOptions
  private disposed = false
  private inventory: TradeInventoryItem[]
  private inventoryLoading: boolean
  private localOffer: TradeOfferSnapshot = emptyOffer()
  private peerOffer: TradeOfferSnapshot = emptyOffer()
  private pickerOpen = false
  private pickerQuery = ''
  private pickerRarity = 'all'
  private pickerPage = 0
  private statusTitle = ''
  private statusSub = ''
  private statusTone: 'info' | 'ok' | 'err' = 'info'
  private statusClearTimer = 0
  /** trade = interactive; settling = frozen mid-chain; success/failed = result + Close. */
  private phase: TradeWindowPhase = 'trade'
  private resultDetail = ''
  /** Full 0x… hash for success — shown as Polygonscan link. */
  private resultTxHash: string | null = null

  constructor(opts: TradeWindowOptions) {
    this.opts = opts
    this.inventory = [...(opts.inventory || [])]
    this.inventoryLoading = opts.inventoryLoading === true
    this.root = document.createElement('div')
    this.root.className = 'trade-window-host'
    this.root.innerHTML = this.shellHtml()
    document.body.appendChild(this.root)
    this.bindChrome()
    this.render()
    if (this.inventoryLoading) {
      this.setStatus('Loading inventory…', 'Fetching wearables (this won’t block trading chrome).', {
        tone: 'info',
        autoClearMs: 0
      })
    }
  }

  /** Replace inventory after background load (window already open). */
  setInventory(items: TradeInventoryItem[], loading = false): void {
    this.inventory = [...items]
    this.inventoryLoading = loading
    if (!loading && this.statusTitle === 'Loading inventory…') {
      this.clearStatus()
    }
    if (loading) {
      this.setStatus('Loading inventory…', 'Fetching wearables…', { tone: 'info', autoClearMs: 0 })
    }
    if (this.pickerOpen) this.renderPickerBody()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    if (this.statusClearTimer) window.clearTimeout(this.statusClearTimer)
    window.removeEventListener('keydown', this.onKey, true)
    this.root.remove()
  }

  getPhase(): TradeWindowPhase {
    return this.phase
  }

  /** True after success or fail — Close should dismiss without cancel confirm. */
  isTerminal(): boolean {
    return this.phase === 'success' || this.phase === 'failed'
  }

  /** Freeze controls while approvals / sign / accept run. */
  setSettling(active: boolean, title?: string, sub?: string): void {
    if (this.isTerminal()) return
    this.phase = active ? 'settling' : 'trade'
    if (active) {
      this.closePicker()
      if (title) this.setStatus(title, sub, { tone: 'info', autoClearMs: 0 })
    }
    this.render()
    this.paintHeaderTitle()
  }

  /**
   * Final success / fail screen. Keeps the window open with a Clear Close button
   * (does not auto-dismiss). Pass `txHash` on success for a clickable Polygonscan link.
   */
  showResult(
    kind: 'success' | 'failed',
    title: string,
    detail?: string,
    opts?: { txHash?: string | null }
  ): void {
    this.phase = kind
    this.resultDetail = (detail ?? '').trim()
    const rawTx = (opts?.txHash || '').trim()
    this.resultTxHash =
      kind === 'success' && /^0x[a-fA-F0-9]{64}$/.test(rawTx) ? rawTx : null
    this.closePicker()
    this.setStatus(title, detail, {
      tone: kind === 'success' ? 'ok' : 'err',
      autoClearMs: 0
    })
    this.render()
    this.paintHeaderTitle()
  }

  private polygonscanTxUrl(hash: string): string {
    return `https://polygonscan.com/tx/${hash}`
  }

  /**
   * In-window status banner (above the dimmed backdrop / global toasts).
   * Prefer this over SocialMobileNotifications while the trade modal is open.
   */
  setStatus(
    title: string,
    sub?: string,
    opts?: { tone?: 'info' | 'ok' | 'err'; autoClearMs?: number }
  ): void {
    // After success/fail, only allow updates that refresh the result banner.
    if (this.isTerminal() && opts?.tone !== 'ok' && opts?.tone !== 'err') return

    this.statusTitle = title.trim()
    this.statusSub = (sub ?? '').trim()
    this.statusTone = opts?.tone ?? 'info'
    this.paintStatus()
    if (this.statusClearTimer) window.clearTimeout(this.statusClearTimer)
    // Never auto-clear terminal or settling banners.
    const ms =
      this.isTerminal() || this.phase === 'settling'
        ? 0
        : (opts?.autoClearMs ?? 0)
    if (ms > 0) {
      this.statusClearTimer = window.setTimeout(() => {
        if (this.isTerminal() || this.phase === 'settling') return
        this.statusTitle = ''
        this.statusSub = ''
        this.paintStatus()
      }, ms)
    }
  }

  clearStatus(): void {
    if (this.isTerminal()) return
    this.statusTitle = ''
    this.statusSub = ''
    if (this.statusClearTimer) window.clearTimeout(this.statusClearTimer)
    this.statusClearTimer = 0
    this.paintStatus()
  }

  private paintHeaderTitle(): void {
    const el = this.root.querySelector<HTMLElement>('[data-trade-title]')
    if (!el) return
    if (this.phase === 'success') el.textContent = 'TRADE COMPLETE'
    else if (this.phase === 'failed') el.textContent = 'TRADE FAILED'
    else if (this.phase === 'settling') el.textContent = 'SETTLING…'
    else el.textContent = 'TRADE'
  }

  private paintStatus(): void {
    const el = this.root.querySelector<HTMLElement>('[data-trade-status]')
    if (!el) return
    if (!this.statusTitle) {
      el.hidden = true
      el.innerHTML = ''
      el.className = 'trade-window__status'
      return
    }
    el.hidden = false
    el.className = `trade-window__status trade-window__status--${this.statusTone}`
    const badge =
      this.phase === 'success'
        ? '<span class="trade-window__status-badge trade-window__status-badge--ok">SUCCESS</span>'
        : this.phase === 'failed'
          ? '<span class="trade-window__status-badge trade-window__status-badge--err">FAILED</span>'
          : this.phase === 'settling'
            ? '<span class="trade-window__status-badge trade-window__status-badge--info">IN PROGRESS</span>'
            : ''
    const txLink =
      this.resultTxHash != null
        ? `<a class="trade-window__tx-link" href="${escapeAttr(
            this.polygonscanTxUrl(this.resultTxHash)
          )}" target="_blank" rel="noopener noreferrer">View on Polygonscan ↗</a>
           <div class="trade-window__tx-hash">${escapeHtml(this.resultTxHash)}</div>`
        : ''
    el.innerHTML = `
      <div class="trade-window__status-row">
        ${badge}
        <div class="trade-window__status-title">${escapeHtml(this.statusTitle)}</div>
      </div>
      ${
        this.statusSub
          ? `<div class="trade-window__status-sub">${escapeHtml(this.statusSub)}</div>`
          : ''
      }
      ${txLink}
    `
  }

  setPeerOffer(offer: TradeOfferSnapshot): void {
    this.peerOffer = {
      items: [...offer.items],
      mana: offer.mana,
      locked: offer.locked,
      accepted: offer.accepted
    }
    this.render()
  }

  setLocalOffer(offer: TradeOfferSnapshot, silent = false): void {
    this.localOffer = {
      items: [...offer.items],
      mana: offer.mana,
      locked: offer.locked,
      accepted: offer.accepted
    }
    this.render()
    if (!silent) this.opts.onLocalOfferChange(this.localOffer)
  }

  markPeerAccepted(accepted: boolean): void {
    this.peerOffer = { ...this.peerOffer, accepted }
    this.render()
  }

  private shellHtml(): string {
    return `
      <div class="trade-window-backdrop" data-trade-close></div>
      <div class="trade-window" role="dialog" aria-label="Trade">
        <header class="trade-window__header">
          <div class="trade-window__title" data-trade-title>TRADE</div>
          <button type="button" class="trade-window__close" data-trade-close aria-label="Close trade">&times;</button>
        </header>
        <div class="trade-window__status" data-trade-status hidden role="status" aria-live="polite"></div>
        <div class="trade-window__body" data-trade-body></div>
        <footer class="trade-window__footer" data-trade-footer></footer>
        <div class="trade-window__picker" data-trade-picker hidden></div>
      </div>
    `
  }

  private bindChrome(): void {
    this.root.addEventListener('click', (ev) => {
      const t = ev.target as HTMLElement | null
      if (!t) return
      if (t.closest('[data-trade-close]') || t.closest('[data-trade-result-close]')) {
        this.opts.onClose()
        return
      }
      // Freeze offer edits while settling or after terminal result.
      if (this.phase !== 'trade') return
      if (t.closest('[data-trade-lock]')) {
        this.toggleLock()
        return
      }
      if (t.closest('[data-trade-accept]')) {
        this.tryAccept()
        return
      }
      if (t.closest('[data-trade-add-item]')) {
        if (this.localOffer.locked) return
        this.openPicker()
        return
      }
      if (t.closest('[data-trade-add-mana]')) {
        if (this.localOffer.locked) return
        this.promptMana()
        return
      }
      const remove = t.closest('[data-trade-remove-item]') as HTMLElement | null
      if (remove?.dataset.tradeRemoveItem != null) {
        if (this.localOffer.locked) return
        const idx = Number(remove.dataset.tradeRemoveItem)
        if (Number.isFinite(idx)) this.removeLocalItem(idx)
        return
      }
      const pick = t.closest('[data-trade-pick]') as HTMLElement | null
      if (pick?.dataset.tradePick) {
        this.pickItem(pick.dataset.tradePick)
        return
      }
      if (t.closest('[data-trade-picker-close]')) {
        this.closePicker()
        return
      }
      if (t.closest('[data-trade-picker-prev]')) {
        this.pickerPage = Math.max(0, this.pickerPage - 1)
        this.renderPickerBody()
        return
      }
      if (t.closest('[data-trade-picker-next]')) {
        this.pickerPage += 1
        this.renderPickerBody()
        return
      }
    })

    this.root.addEventListener('input', (ev) => {
      const t = ev.target as HTMLElement | null
      if (!t || !this.pickerOpen) return
      if (t.matches('[data-trade-picker-search]')) {
        this.pickerQuery = (t as HTMLInputElement).value
        this.pickerPage = 0
        this.renderPickerBody()
      }
    })

    this.root.addEventListener('change', (ev) => {
      const t = ev.target as HTMLElement | null
      if (!t || !this.pickerOpen) return
      if (t.matches('[data-trade-picker-rarity]')) {
        this.pickerRarity = (t as HTMLSelectElement).value
        this.pickerPage = 0
        this.renderPickerBody()
      }
    })

    window.addEventListener('keydown', this.onKey, true)
  }

  private onKey = (e: KeyboardEvent): void => {
    if (this.disposed) return
    if (e.key === 'Escape') {
      if (this.pickerOpen) {
        this.closePicker()
        e.preventDefault()
        return
      }
      this.opts.onClose()
    }
  }

  private toggleLock(): void {
    if (this.phase !== 'trade') return
    if (this.localOffer.accepted) return
    this.localOffer = {
      ...this.localOffer,
      locked: !this.localOffer.locked,
      accepted: false
    }
    this.render()
    this.opts.onLocalOfferChange(this.localOffer)
  }

  private tryAccept(): void {
    if (this.phase !== 'trade') return
    if (!this.localOffer.locked || !this.peerOffer.locked) return
    this.localOffer = { ...this.localOffer, accepted: true }
    this.render()
    this.opts.onLocalOfferChange(this.localOffer)
    this.opts.onAcceptTrade()
  }

  private removeLocalItem(index: number): void {
    if (this.phase !== 'trade') return
    const items = this.localOffer.items.filter((_, i) => i !== index)
    this.localOffer = { ...this.localOffer, items, accepted: false }
    this.render()
    this.opts.onLocalOfferChange(this.localOffer)
  }

  private promptMana(): void {
    if (this.phase !== 'trade') return
    const raw = window.prompt('Add MANA to offer', String(this.localOffer.mana || 0))
    if (raw == null) return
    const n = Number(raw.replace(/,/g, '').trim())
    if (!Number.isFinite(n) || n < 0) return
    this.localOffer = {
      ...this.localOffer,
      mana: Math.min(1_000_000_000, Math.floor(n)),
      accepted: false
    }
    this.render()
    this.opts.onLocalOfferChange(this.localOffer)
  }

  private openPicker(): void {
    if (this.phase !== 'trade') return
    this.pickerOpen = true
    this.pickerQuery = ''
    this.pickerRarity = 'all'
    this.pickerPage = 0
    const el = this.root.querySelector<HTMLElement>('[data-trade-picker]')
    if (!el) return
    el.hidden = false
    el.innerHTML = `
      <div class="trade-picker">
        <div class="trade-picker__head">
          <span>Your inventory</span>
          <button type="button" class="trade-window__close" data-trade-picker-close aria-label="Close">&times;</button>
        </div>
        <div class="trade-picker__toolbar">
          <input
            class="trade-picker__search"
            type="search"
            data-trade-picker-search
            placeholder="Search name, rarity, #issue…"
            autocomplete="off"
            enterkeyhint="search"
          />
          <select class="trade-picker__rarity" data-trade-picker-rarity aria-label="Filter by rarity">
            <option value="all">All rarities</option>
            <option value="unique">Unique</option>
            <option value="mythic">Mythic</option>
            <option value="exotic">Exotic</option>
            <option value="legendary">Legendary</option>
            <option value="epic">Epic</option>
            <option value="rare">Rare</option>
            <option value="uncommon">Uncommon</option>
            <option value="common">Common</option>
          </select>
        </div>
        <div class="trade-picker__meta" data-trade-picker-meta></div>
        <div class="trade-picker__grid" data-trade-picker-grid></div>
        <div class="trade-picker__pager" data-trade-picker-pager></div>
      </div>
    `
    this.renderPickerBody()
    const search = el.querySelector<HTMLInputElement>('[data-trade-picker-search]')
    search?.focus()
  }

  private closePicker(): void {
    this.pickerOpen = false
    const el = this.root.querySelector<HTMLElement>('[data-trade-picker]')
    if (el) {
      el.hidden = true
      el.innerHTML = ''
    }
  }

  private filteredInventory(): TradeInventoryItem[] {
    const offered = new Set(this.localOffer.items.map((i) => i.urn))
    const q = this.pickerQuery.trim().toLowerCase()
    const rarity = this.pickerRarity

    return this.inventory.filter((it) => {
      if (offered.has(it.urn)) return false
      if (rarity !== 'all' && (it.r || '').toLowerCase() !== rarity) return false
      if (!q) return true
      const hay = [
        it.name,
        it.urn,
        it.r,
        it.issue,
        it.category,
        it.issue ? `#${it.issue}` : '',
        it.issue && it.maxSupply ? `#${it.issue}/${it.maxSupply}` : ''
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
      return hay.includes(q)
    })
  }

  private renderPickerBody(): void {
    if (!this.pickerOpen) return
    const filtered = this.filteredInventory()
    const totalPages = Math.max(1, Math.ceil(filtered.length / PICKER_PAGE_SIZE))
    if (this.pickerPage >= totalPages) this.pickerPage = totalPages - 1
    const start = this.pickerPage * PICKER_PAGE_SIZE
    const pageItems = filtered.slice(start, start + PICKER_PAGE_SIZE)
    const end = Math.min(filtered.length, start + pageItems.length)

    const grid = this.root.querySelector('[data-trade-picker-grid]')
    const meta = this.root.querySelector('[data-trade-picker-meta]')
    const pager = this.root.querySelector('[data-trade-picker-pager]')
    if (!grid || !meta || !pager) return

    meta.textContent = this.inventoryLoading
      ? 'Loading inventory…'
      : filtered.length === 0
        ? 'No matching items'
        : `Showing ${start + 1}–${end} of ${filtered.length} · ${this.inventory.length} owned`

    grid.innerHTML = this.inventoryLoading
      ? `<p class="trade-picker__empty">Loading wearables…</p>`
      : pageItems
          .map((it) => {
            const rarity = (it.r || 'common').toLowerCase()
            const rarityCls = RARITY_CLASS[rarity] || 'rarity-common'
            const issue =
              it.issue != null && it.issue !== ''
                ? it.maxSupply
                  ? `#${it.issue} / ${it.maxSupply}`
                  : `#${it.issue}`
                : ''
            const label = it.name || shortUrn(it.urn)
            return `
          <button type="button" class="trade-picker__cell ${rarityCls}" data-trade-pick="${escapeAttr(
            it.key
          )}" title="${escapeAttr(label)}">
            <div class="trade-picker__thumb">
              ${
                it.img
                  ? `<img src="${escapeAttr(it.img)}" alt="" loading="lazy" />`
                  : `<span class="trade-picker__fallback">${escapeHtml(label.charAt(0) || '?')}</span>`
              }
              ${issue ? `<span class="trade-picker__issue">${escapeHtml(issue)}</span>` : ''}
            </div>
            <span class="trade-picker__rarity-tag">${escapeHtml(rarity)}</span>
            <span class="trade-picker__label">${escapeHtml(label)}</span>
          </button>`
          })
          .join('') || `<p class="trade-picker__empty">No wearable items match your filters.</p>`

    const canPrev = this.pickerPage > 0
    const canNext = this.pickerPage < totalPages - 1
    pager.innerHTML = `
      <button type="button" class="trade-picker__page-btn" data-trade-picker-prev ${
        canPrev ? '' : 'disabled'
      }>Prev</button>
      <span class="trade-picker__page-label">Page ${this.pickerPage + 1} / ${totalPages}</span>
      <button type="button" class="trade-picker__page-btn" data-trade-picker-next ${
        canNext ? '' : 'disabled'
      }>Next</button>
    `
  }

  private pickItem(key: string): void {
    const item = this.inventory.find((i) => i.key === key)
    if (!item) return
    if (this.localOffer.items.some((i) => i.urn === item.urn)) return
    if (this.localOffer.items.length >= GRID_MAX_ITEMS) return
    const wire: TradeItemWire = {
      urn: item.urn,
      name: item.name,
      img: item.img,
      r: item.r,
      c: item.c,
      tid: item.tid,
      issue: item.issue,
      max: item.maxSupply
    }
    this.localOffer = {
      ...this.localOffer,
      items: [...this.localOffer.items, wire],
      accepted: false
    }
    // Stay in picker so multi-select is fast; just refresh page contents.
    this.render()
    this.opts.onLocalOfferChange(this.localOffer)
    if (this.pickerOpen) this.renderPickerBody()
  }

  private render(): void {
    const body = this.root.querySelector('[data-trade-body]')
    const footer = this.root.querySelector('[data-trade-footer]')
    if (!body || !footer) return

    const frozen = this.phase !== 'trade'
    const canEdit = !frozen && !this.localOffer.locked

    body.innerHTML = `
      <section class="trade-panel trade-panel--local ${frozen ? 'is-frozen' : ''}">
        ${this.panelHeader(this.opts.localName, this.opts.localFaceUrl, this.localOffer, true)}
        ${this.gridHtml(this.localOffer, true && canEdit)}
        ${this.manaRow(this.localOffer.mana, canEdit)}
        <div class="trade-panel__hint">
          ${
            this.phase === 'success'
              ? 'Trade complete — items moved on-chain'
              : this.phase === 'failed'
                ? 'Settlement failed — close and try again'
                : this.phase === 'settling'
                  ? 'Settlement in progress — please wait…'
                  : this.localOffer.locked
                    ? 'Offer locked — unlock to edit'
                    : 'Choose item(s) and / or MANA to offer'
          }
        </div>
      </section>
      <div class="trade-window__swap" aria-hidden="true">
        <div class="trade-window__swap-icon">⇄</div>
      </div>
      <section class="trade-panel trade-panel--peer ${this.peerOffer.locked || frozen ? 'is-locked' : ''}">
        ${this.panelHeader(this.opts.peerName, this.opts.peerFaceUrl, this.peerOffer, false)}
        ${
          this.peerOffer.locked && this.phase === 'trade'
            ? `<div class="trade-panel__lock-overlay"><span class="trade-panel__lock-icon">🔒</span><span>Offer Locked In</span></div>`
            : ''
        }
        ${this.gridHtml(this.peerOffer, false)}
        ${this.manaRow(this.peerOffer.mana, false)}
      </section>
    `

    if (this.isTerminal()) {
      const isOk = this.phase === 'success'
      const txBlock =
        isOk && this.resultTxHash
          ? `<a class="trade-window__tx-link trade-window__tx-link--btn" href="${escapeAttr(
              this.polygonscanTxUrl(this.resultTxHash)
            )}" target="_blank" rel="noopener noreferrer">View transaction on Polygonscan ↗</a>
             <div class="trade-window__tx-hash">${escapeHtml(this.resultTxHash)}</div>`
          : ''
      footer.innerHTML = `
        <div class="trade-window__result ${isOk ? 'trade-window__result--ok' : 'trade-window__result--err'}">
          <div class="trade-window__result-label">${isOk ? '✓ Success' : '✕ Failed'}</div>
          ${
            this.resultDetail
              ? `<div class="trade-window__result-detail">${escapeHtml(this.resultDetail)}</div>`
              : ''
          }
          ${txBlock}
          <button type="button" class="trade-window__btn trade-window__btn--close-result" data-trade-result-close>
            Close
          </button>
        </div>
      `
      this.paintStatus()
      this.paintHeaderTitle()
      return
    }

    if (this.phase === 'settling') {
      footer.innerHTML = `
        <div class="trade-window__result trade-window__result--info">
          <div class="trade-window__result-label">Settling on-chain…</div>
          <div class="trade-window__result-detail">Approvals and signatures — do not close this window.</div>
        </div>
      `
      this.paintStatus()
      this.paintHeaderTitle()
      return
    }

    const bothLocked = this.localOffer.locked && this.peerOffer.locked
    const localAccepted = this.localOffer.accepted
    const peerAccepted = this.peerOffer.accepted

    footer.innerHTML = `
      <button type="button" class="trade-window__btn" data-trade-add-item ${
        this.localOffer.locked ? 'disabled' : ''
      }>Add Item</button>
      <button type="button" class="trade-window__btn" data-trade-add-mana ${
        this.localOffer.locked ? 'disabled' : ''
      }>Add MANA</button>
      <button type="button" class="trade-window__btn trade-window__btn--lock ${
        this.localOffer.locked ? 'is-active' : ''
      }" data-trade-lock>
        ${this.localOffer.locked ? 'Unlock Offer' : 'Lock In Offer'}
      </button>
      <button type="button" class="trade-window__btn trade-window__btn--accept" data-trade-accept ${
        bothLocked && !localAccepted ? '' : 'disabled'
      }>
        ${
          localAccepted && peerAccepted
            ? 'Trade Accepted'
            : localAccepted
              ? 'Waiting for peer…'
              : 'Accept Trade'
        }
      </button>
    `
    this.paintStatus()
    this.paintHeaderTitle()
  }

  private panelHeader(
    name: string,
    faceUrl: string | null | undefined,
    offer: TradeOfferSnapshot,
    isLocal: boolean
  ): string {
    const addr = !isLocal ? (this.opts.peerAddress || '').trim() : ''
    const addrShort =
      addr && /^0x[a-fA-F0-9]{40}$/i.test(addr)
        ? `${addr.slice(0, 6)}…${addr.slice(-4)}`
        : ''
    const face = faceUrl
      ? `<img class="trade-panel__face" src="${escapeAttr(faceUrl)}" alt="" />`
      : `<div class="trade-panel__face trade-panel__face--fallback">${escapeHtml(
          name.charAt(0).toUpperCase() || '?'
        )}</div>`
    const status = offer.accepted
      ? 'Accepted'
      : offer.locked
        ? 'Locked'
        : isLocal
          ? 'Your offer'
          : 'Their offer'
    return `
      <div class="trade-panel__head">
        <div class="trade-panel__face-wrap">${face}</div>
        <div>
          <div class="trade-panel__name">${escapeHtml(name)}</div>
          ${
            addrShort
              ? `<div class="trade-panel__addr" title="${escapeAttr(addr)}">${escapeHtml(addrShort)}</div>`
              : ''
          }
          <div class="trade-panel__status ${offer.locked ? 'is-locked' : ''}">${status}</div>
        </div>
      </div>
    `
  }

  private gridHtml(offer: TradeOfferSnapshot, isLocal: boolean): string {
    const cells: string[] = []
    const n = offer.items.length
    const showAdd = isLocal && !offer.locked && n < GRID_MAX_ITEMS
    // Pad to a 3×3 floor so empty offers still look like a grid; scroll for more.
    const totalCells = Math.max(GRID_MIN_CELLS, n + (showAdd ? 1 : 0))

    for (let i = 0; i < totalCells; i++) {
      const item = offer.items[i]
      if (item) {
        cells.push(this.itemCellHtml(item, i, isLocal && !offer.locked))
      } else if (showAdd && i === n) {
        cells.push(`
          <button type="button" class="trade-slot trade-slot--add" data-trade-add-item aria-label="Add item">
            <span class="trade-slot__add-icon">+</span>
            <span class="trade-slot__add-label">Add</span>
          </button>
        `)
      } else {
        cells.push(`<div class="trade-slot trade-slot--empty"></div>`)
      }
    }
    return `<div class="trade-grid-scroll"><div class="trade-grid">${cells.join('')}</div></div>`
  }

  /** Same card layout as inventory picker: thumb + issue + rarity + name. */
  private itemCellHtml(item: TradeItemWire, index: number, canRemove: boolean): string {
    const rarity = (item.r || 'common').toLowerCase()
    const rarityCls = RARITY_CLASS[rarity] || 'rarity-common'
    const issue =
      item.issue != null && item.issue !== ''
        ? item.max
          ? `#${item.issue} / ${item.max}`
          : `#${item.issue}`
        : ''
    return `
      <div class="trade-slot has-item ${rarityCls}" title="${escapeAttr(item.name || item.urn)}">
        <div class="trade-slot__thumb">
          ${
            item.img
              ? `<img src="${escapeAttr(item.img)}" alt="" loading="lazy" />`
              : `<span class="trade-slot__fallback">${escapeHtml((item.name || '?').charAt(0))}</span>`
          }
          ${issue ? `<span class="trade-slot__issue">${escapeHtml(issue)}</span>` : ''}
          ${
            canRemove
              ? `<button type="button" class="trade-slot__remove" data-trade-remove-item="${index}" aria-label="Remove">×</button>`
              : ''
          }
        </div>
        <span class="trade-slot__rarity">${escapeHtml(rarity)}</span>
        <span class="trade-slot__name">${escapeHtml(item.name || shortUrn(item.urn))}</span>
      </div>
    `
  }

  private manaRow(mana: number, isLocal: boolean): string {
    const formatted = mana.toLocaleString()
    return `
      <div class="trade-mana ${isLocal && !this.localOffer.locked ? 'is-editable' : ''}" ${
        isLocal && !this.localOffer.locked ? 'data-trade-add-mana' : ''
      }>
        <span class="trade-mana__icon">◈</span>
        <span class="trade-mana__value">${formatted}</span>
        <span class="trade-mana__label">MANA</span>
      </div>
    `
  }
}

function shortUrn(urn: string): string {
  const parts = urn.split(':')
  return parts[parts.length - 1] || urn.slice(0, 12)
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
