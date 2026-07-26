import type { SessionIdentity } from '../../../network/SessionIdentity'
import {
  ADDRESSES,
  EXPLORER_TX,
  USE_FAKE_CLAIM,
  formatMana,
  shortAddr,
  escapeHtml,
  fetchPoolSnapshot,
  fetchWalletSnapshot,
  runDepositManaPack,
  runDepositNft,
  runPull,
  runSettle,
  runWithdrawRewards,
  type FlowApi,
  type GachaPosition,
  type PendingWin,
  type PoolSnapshot,
  type TxStep,
  type WalletSnapshot
} from '../../../gacha'
import { publishPoolClaim } from '../../../social/publishPoolClaim'

export type GachaPanelOptions = {
  getSession: () => SessionIdentity
  onClose?: () => void
}

type PanelMode = 'main' | 'deposit'

const INV_PAGE_SIZE = 8
const DEFAULT_BACKING = '10'
const DEFAULT_PACK_PRIZE = '5'
const MANA_PACK_INV_ID = 'mana-pack'

type InvKind = 'nft' | 'pack'

type InvItem = {
  id: string
  kind: InvKind
  tokenId: string
  name: string
  rarity: string
  collection: string
}

type DepositSelection = {
  item: InvItem
  backingMana: string
  packPrizeMana?: string
}

function manaPackInvItem(): InvItem {
  return {
    id: MANA_PACK_INV_ID,
    kind: 'pack',
    tokenId: 'pack',
    name: 'MANA Pack',
    rarity: 'legendary',
    collection: ADDRESSES.mockMana
  }
}

function ownedToInventory(tokenIds: number[]): InvItem[] {
  const nfts: InvItem[] = tokenIds.map((id) => ({
    id: `mock-${id}`,
    kind: 'nft' as const,
    tokenId: String(id),
    name: `Mock Wearable #${id}`,
    rarity: id % 5 === 0 ? 'legendary' : id % 3 === 0 ? 'epic' : id % 2 === 0 ? 'rare' : 'common',
    collection: ADDRESSES.mockWearable
  }))
  return [manaPackInvItem(), ...nfts]
}

function formatManaDisplay(n: number): string {
  if (!Number.isFinite(n)) return '0'
  if (n >= 1000) return n.toLocaleString(undefined, { maximumFractionDigits: 0 })
  return n.toLocaleString(undefined, { maximumFractionDigits: 2, minimumFractionDigits: 0 })
}

/**
 * Left HUD wearable pool — ~2× chat width.
 * Main: glass vitrine shelf · Deposit: 1/3 + 2/3 inventory · Win: center modal.
 */
export class GachaPanel {
  readonly element: HTMLDivElement
  private readonly winModal: HTMLDivElement
  private visible = false
  private busy = false
  private mode: PanelMode = 'main'
  private pool: PoolSnapshot | null = null
  private wallet: WalletSnapshot | null = null
  private inventory: InvItem[] = []
  private selections: DepositSelection[] = []
  private invPage = 0
  private steps: TxStep[] = []
  private status = ''
  private error: string | null = null
  private pendingWin: PendingWin | null = null
  /** True when pending win came from USE_FAKE_CLAIM (settle is demo-only). */
  private pendingWinIsFake = false
  private stepSeq = 0

  private readonly titleEl: HTMLElement
  private readonly feeEl: HTMLElement
  private readonly balanceEl: HTMLElement
  private readonly walletEl: HTMLElement
  private readonly bodyEl: HTMLElement
  private readonly statusEl: HTMLElement
  private readonly stepsEl: HTMLElement
  private readonly footerEl: HTMLElement
  private readonly onKeyDown: (ev: KeyboardEvent) => void

  constructor(private readonly options: GachaPanelOptions) {
    this.element = document.createElement('div')
    this.element.id = 'gacha-panel-wrap'
    this.element.className = 'gacha-panel-wrap'
    this.element.hidden = true
    this.element.setAttribute('role', 'dialog')
    this.element.setAttribute('aria-label', 'Wearable Pool')
    this.element.innerHTML = `
      <div class="gacha-panel gacha-panel--vitrine">
        <header class="gacha-panel__header">
          <div class="gacha-panel__header-main">
            <h2 class="gacha-panel__title" data-title>Wearable Pool</h2>
            <p class="gacha-panel__subtitle">Shared locker · deposit or claim</p>
            <div class="gacha-panel__stats">
              <span class="gacha-panel__stat" data-fee title="Claim fee">Fee —</span>
              <span class="gacha-panel__stat gacha-panel__stat--mana" data-balance title="Your MockMANA">Balance —</span>
            </div>
            <div class="gacha-panel__wallet" data-wallet></div>
          </div>
          <div class="gacha-panel__header-actions">
            <button type="button" class="gacha-panel__icon-btn" data-refresh title="Refresh" aria-label="Refresh">↻</button>
            <button type="button" class="gacha-panel__close" data-close aria-label="Close">×</button>
          </div>
        </header>
        <div class="gacha-panel__body" data-body>
          <p class="gacha-panel__loading">Loading pool…</p>
        </div>
        <div class="gacha-panel__steps" data-steps hidden></div>
        <p class="gacha-panel__status" data-status hidden></p>
        <footer class="gacha-panel__footer" data-footer>
          <button type="button" class="gacha-panel__btn gacha-panel__btn--secondary" data-deposit>Deposit</button>
          <button type="button" class="gacha-panel__btn gacha-panel__btn--primary" data-claim>Claim</button>
        </footer>
      </div>
    `

    this.winModal = document.createElement('div')
    this.winModal.id = 'gacha-win-modal'
    this.winModal.className = 'gacha-win-modal'
    this.winModal.hidden = true
    this.winModal.setAttribute('role', 'dialog')
    this.winModal.setAttribute('aria-modal', 'true')
    this.winModal.setAttribute('aria-label', 'Pool claim result')
    this.winModal.innerHTML = `
      <div class="gacha-win-modal__backdrop" data-win-backdrop></div>
      <div class="gacha-win-modal__card" data-win-card></div>
    `

    this.titleEl = this.element.querySelector('[data-title]')!
    this.feeEl = this.element.querySelector('[data-fee]')!
    this.balanceEl = this.element.querySelector('[data-balance]')!
    this.walletEl = this.element.querySelector('[data-wallet]')!
    this.bodyEl = this.element.querySelector('[data-body]')!
    this.statusEl = this.element.querySelector('[data-status]')!
    this.stepsEl = this.element.querySelector('[data-steps]')!
    this.footerEl = this.element.querySelector('[data-footer]')!

    this.element.querySelector('[data-close]')!.addEventListener('click', () => this.hide())
    this.element.querySelector('[data-refresh]')!.addEventListener('click', () => void this.refresh())
    this.element.querySelector('[data-deposit]')!.addEventListener('click', () => this.openDeposit())
    this.element.querySelector('[data-claim]')!.addEventListener('click', () => void this.onClaimClick())

    this.bodyEl.addEventListener('click', (ev) => void this.onBodyClick(ev))
    this.bodyEl.addEventListener('input', (ev) => this.onBodyInput(ev))
    this.winModal.addEventListener('click', (ev) => void this.onWinModalClick(ev))

    this.onKeyDown = (ev) => {
      if (ev.key !== 'Escape') return
      if (!this.winModal.hidden) {
        // Don't dismiss win on backdrop escape while busy settle; allow close of demo
        if (!this.busy) this.closeWinModal({ clearPending: false })
        return
      }
      if (!this.visible) return
      if (this.mode === 'deposit' && !this.busy) this.closeDeposit()
      else this.hide()
    }

    document.body.appendChild(this.element)
    document.body.appendChild(this.winModal)
  }

  isVisible(): boolean {
    return this.visible
  }

  toggle(): void {
    if (this.visible) this.hide()
    else void this.show()
  }

  async show(): Promise<void> {
    this.resetToMainMenu()
    this.visible = true
    this.element.hidden = false
    window.addEventListener('keydown', this.onKeyDown)
    await this.refresh()
  }

  hide(): void {
    if (!this.visible && this.winModal.hidden) return
    this.visible = false
    this.element.hidden = true
    this.resetToMainMenu()
    window.removeEventListener('keydown', this.onKeyDown)
    this.options.onClose?.()
  }

  /**
   * Always land on main pool shelf when reopening — clear deposit state, win modal, etc.
   */
  private resetToMainMenu(): void {
    this.mode = 'main'
    this.selections = []
    this.invPage = 0
    this.pendingWin = null
    this.pendingWinIsFake = false
    this.steps = []
    this.stepSeq = 0
    this.error = null
    this.status = ''
    this.busy = false
    this.element.classList.remove('is-deposit-mode', 'is-busy')
    this.footerEl.hidden = false
    this.titleEl.textContent = 'Wearable Pool'
    this.closeWinModal({ clearPending: true })
    this.stepsEl.hidden = true
    this.stepsEl.innerHTML = ''
    this.statusEl.hidden = true
    this.statusEl.textContent = ''
  }

  dispose(): void {
    this.hide()
    this.winModal.remove()
    this.element.remove()
    window.removeEventListener('keydown', this.onKeyDown)
  }

  private sessionAddress(): string | undefined {
    return this.options.getSession().getAddress()
  }

  private flowApi(): FlowApi {
    return {
      note: (label) => {
        this.status = label
        this.renderStatus()
      },
      pushStep: (label) => {
        const id = `s${++this.stepSeq}`
        this.steps = this.steps.map((s) =>
          s.status === 'active' ? { ...s, status: 'done' as const } : s
        )
        this.steps = [...this.steps, { id, label, status: 'active' }]
        this.renderSteps()
        this.status = label
        this.renderStatus()
        return id
      },
      finishStep: (id, patch) => {
        this.steps = this.steps.map((s) => {
          if (s.id !== id) return s
          return {
            ...s,
            status: patch?.error ? ('error' as const) : ('done' as const),
            hash: patch?.hash ?? s.hash,
            detail: patch?.detail ?? s.detail
          }
        })
        this.renderSteps()
      }
    }
  }

  private setBusy(on: boolean): void {
    this.busy = on
    this.footerEl.querySelectorAll('button').forEach((b) => {
      ;(b as HTMLButtonElement).disabled = on
    })
    this.element.classList.toggle('is-busy', on)
    // Keep settle buttons in sync (modal HTML is static after open)
    this.winModal.querySelectorAll<HTMLButtonElement>('[data-settle-keep], [data-settle-take]').forEach((b) => {
      b.disabled = on
    })
    if (this.mode === 'deposit') this.renderDepositBody()
  }

  private syncInventory(): void {
    this.inventory = ownedToInventory(this.wallet?.ownedTokenIds ?? [])
  }

  private isPackSel(s: DepositSelection): boolean {
    return s.item.kind === 'pack'
  }

  private totalLockMana(): number {
    let t = 0
    for (const s of this.selections) {
      const back = Number(s.backingMana)
      if (Number.isFinite(back) && back > 0) t += back
      if (this.isPackSel(s)) {
        const prize = Number(s.packPrizeMana || '0')
        if (Number.isFinite(prize) && prize > 0) t += prize
      }
    }
    return t
  }

  async refresh(): Promise<void> {
    this.error = null
    if (this.mode === 'main') {
      this.status = 'Loading pool…'
      this.renderStatus()
    }
    try {
      this.pool = await fetchPoolSnapshot()
      const addr = this.sessionAddress()
      if (addr && /^0x[a-fA-F0-9]{40}$/.test(addr)) {
        try {
          this.wallet = await fetchWalletSnapshot(addr as `0x${string}`)
        } catch {
          this.wallet = null
        }
      } else {
        this.wallet = null
      }
      this.syncInventory()
      this.renderHeader()
      if (this.mode === 'deposit') {
        this.renderDepositBody()
      } else {
        this.renderMainBody()
        this.status = this.pool.positions.length
          ? `${this.pool.positions.length} on the shelf · deposit or claim`
          : 'Empty shelf — deposit a wearable or MANA pack'
        this.renderStatus()
      }
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e)
      this.bodyEl.innerHTML = `<p class="gacha-panel__error">${escapeHtml(this.error)}</p>`
      this.status = ''
      this.renderStatus()
    }
  }

  private renderHeader(): void {
    const fee = this.pool ? formatMana(this.pool.acquisitionFee) : '—'
    this.feeEl.textContent = `Fee ${fee} mMANA`
    const bal = this.wallet ? formatMana(this.wallet.mana) : '—'
    this.balanceEl.textContent = `Balance ${bal}`
    const addr = this.sessionAddress()
    this.walletEl.textContent = addr ? shortAddr(addr) : 'Connect wallet to play'
    if (this.wallet && this.wallet.claimable > 0n) {
      this.walletEl.textContent += ` · claimable ${formatMana(this.wallet.claimable)}`
    }
  }

  private setMode(mode: PanelMode): void {
    this.mode = mode
    this.element.classList.toggle('is-deposit-mode', mode === 'deposit')
    this.footerEl.hidden = mode === 'deposit'
    if (mode === 'deposit') {
      this.titleEl.textContent = 'Deposit to pool'
      this.closeWinModal({ clearPending: false })
      this.renderDepositBody()
    } else {
      this.titleEl.textContent = 'Wearable Pool'
      this.renderMainBody()
    }
  }

  private openDeposit(): void {
    if (this.busy) return
    if (!this.sessionAddress()) {
      this.error = 'Connect a wallet to deposit'
      this.renderStatus()
      return
    }
    this.error = null
    this.syncInventory()
    const owned = new Set(this.inventory.map((i) => i.id))
    this.selections = this.selections.filter((s) => owned.has(s.item.id))
    this.invPage = 0
    this.setMode('deposit')
  }

  private closeDeposit(): void {
    if (this.busy) return
    this.setMode('main')
    this.renderStatus()
  }

  private renderMainBody(): void {
    const positions = this.pool?.positions ?? []
    if (!positions.length) {
      this.bodyEl.innerHTML = `
        <div class="gacha-panel__empty">
          <div class="gacha-panel__empty-icon" aria-hidden="true">◇</div>
          <p>Nothing on the shelf yet</p>
          <p class="gacha-panel__muted">Deposit a wearable or MANA pack to fill the pool.</p>
        </div>`
      return
    }

    const cards = positions.map((p) => this.shelfCardHtml(p)).join('')
    this.bodyEl.innerHTML = `
      <div class="gacha-panel__vitrine">
        <div class="gacha-panel__vitrine-glass" aria-hidden="true"></div>
        <div class="gacha-panel__shelf" data-shelf>
          <div class="gacha-panel__shelf-track">${cards}</div>
        </div>
      </div>
      <p class="gacha-panel__page-label">${positions.length} in pool · scroll the shelf</p>
    `
  }

  private shelfCardHtml(p: GachaPosition): string {
    const isPack = p.kind === 'manaPack'
    const title = isPack ? 'MANA Pack' : `Token #${escapeHtml(p.tokenId)}`
    const sub = isPack ? `Prize ${formatMana(p.packMana)}` : `Back ${formatMana(p.backing)}`
    const img = p.imageUrl
      ? `<img class="gacha-panel__card-img" src="${escapeHtml(p.imageUrl)}" alt="" loading="lazy" />`
      : `<div class="gacha-panel__card-placeholder" aria-hidden="true">${isPack ? '◈' : '✦'}</div>`
    return `
      <article class="gacha-panel__card${isPack ? ' is-pack' : ''}" data-pos="${p.positionId}">
        <div class="gacha-panel__card-media">${img}</div>
        <div class="gacha-panel__card-title">${title}</div>
        <div class="gacha-panel__card-sub">${sub}</div>
        <div class="gacha-panel__card-depositor">${shortAddr(p.depositor)}</div>
        <div class="gacha-panel__card-id">pos ${p.positionId}</div>
      </article>`
  }

  /** Same layout as 2D: 1/3 To Deposit · 2/3 inventory (pack always first). */
  private renderDepositBody(): void {
    const nftCount = this.inventory.filter((i) => i.kind === 'nft').length
    const invTotal = this.inventory.length
    const totalPages = Math.max(1, Math.ceil(invTotal / INV_PAGE_SIZE))
    if (this.invPage >= totalPages) this.invPage = totalPages - 1
    const start = this.invPage * INV_PAGE_SIZE
    const pageItems = this.inventory.slice(start, start + INV_PAGE_SIZE)
    const selectedIds = new Set(this.selections.map((s) => s.item.id))
    const balLabel = this.wallet ? formatMana(this.wallet.mana) : '—'
    const totalLock = this.totalLockMana()
    const canPrev = this.invPage > 0
    const canNext = this.invPage + 1 < totalPages
    const packCount = this.selections.filter((s) => this.isPackSel(s)).length
    const nftSelCount = this.selections.length - packCount
    const selectedLabel =
      this.selections.length === 0
        ? 'Selected: 0'
        : `Selected: ${nftSelCount ? `${nftSelCount} NFT` : ''}${nftSelCount && packCount ? ' · ' : ''}${packCount ? `${packCount} pack` : ''}`

    const selRows =
      this.selections.length === 0
        ? `<p class="gacha-dep__empty">Select items from your inventory →</p>`
        : this.selections
            .map((sel) => {
              if (this.isPackSel(sel)) {
                return `
        <div class="gacha-dep__row gacha-dep__row--pack" data-sel-id="${escapeHtml(sel.item.id)}">
          <div class="gacha-dep__thumb gacha-dep__thumb--pack">◈</div>
          <div class="gacha-dep__row-meta">
            <div class="gacha-dep__row-name">${escapeHtml(sel.item.name)}</div>
            <div class="gacha-dep__row-sub">PRIZE + BACKING</div>
          </div>
          <label class="gacha-dep__backing">
            <span>Prize</span>
            <input type="text" inputmode="decimal" data-prize-id="${escapeHtml(sel.item.id)}" value="${escapeHtml(sel.packPrizeMana || DEFAULT_PACK_PRIZE)}" ${this.busy ? 'disabled' : ''} />
          </label>
          <label class="gacha-dep__backing">
            <span>Back</span>
            <input type="text" inputmode="decimal" data-backing-id="${escapeHtml(sel.item.id)}" value="${escapeHtml(sel.backingMana)}" ${this.busy ? 'disabled' : ''} />
          </label>
          <button type="button" class="gacha-dep__remove" data-remove="${escapeHtml(sel.item.id)}" aria-label="Remove" ${this.busy ? 'disabled' : ''}>✕</button>
        </div>`
              }
              return `
        <div class="gacha-dep__row" data-sel-id="${escapeHtml(sel.item.id)}">
          <div class="gacha-dep__thumb gacha-dep__thumb--${escapeHtml(sel.item.rarity)}">NFT</div>
          <div class="gacha-dep__row-meta">
            <div class="gacha-dep__row-name">${escapeHtml(sel.item.name)}</div>
            <div class="gacha-dep__row-sub">${escapeHtml(sel.item.rarity.toUpperCase())} · #${escapeHtml(sel.item.tokenId)}</div>
          </div>
          <label class="gacha-dep__backing">
            <span>Back</span>
            <input type="text" inputmode="decimal" data-backing-id="${escapeHtml(sel.item.id)}" value="${escapeHtml(sel.backingMana)}" ${this.busy ? 'disabled' : ''} />
          </label>
          <button type="button" class="gacha-dep__remove" data-remove="${escapeHtml(sel.item.id)}" aria-label="Remove" ${this.busy ? 'disabled' : ''}>✕</button>
        </div>`
            })
            .join('')

    const cells: string[] = []
    for (let i = 0; i < INV_PAGE_SIZE; i++) {
      const item = pageItems[i]
      if (!item) {
        cells.push(`<div class="gacha-dep__cell gacha-dep__cell--empty" aria-hidden="true"></div>`)
        continue
      }
      const on = selectedIds.has(item.id)
      const isPack = item.kind === 'pack'
      cells.push(`
        <button type="button" class="gacha-dep__cell${on ? ' is-selected' : ''}${isPack ? ' is-pack' : ''}" data-pick="${escapeHtml(item.id)}" ${this.busy ? 'disabled' : ''}>
          <div class="gacha-dep__cell-thumb ${isPack ? 'gacha-dep__thumb--pack' : `gacha-dep__thumb--${escapeHtml(item.rarity)}`}">${isPack ? '◈' : 'NFT'}</div>
          <div class="gacha-dep__cell-name">${escapeHtml(item.name)}</div>
          <div class="gacha-dep__cell-sub">${isPack ? 'ALWAYS' : `#${escapeHtml(item.tokenId)}`}</div>
        </button>`)
    }

    this.bodyEl.innerHTML = `
      <div class="gacha-dep gacha-dep--hud">
        <div class="gacha-dep__header gacha-dep__header--compact">
          <button type="button" class="gacha-panel__btn gacha-panel__btn--secondary gacha-dep__back" data-dep-back ${this.busy ? 'disabled' : ''}>← Back</button>
          <div class="gacha-dep__header-stats">
            <span class="gacha-dep__stat gacha-dep__stat--ok">${escapeHtml(balLabel)} mMANA</span>
            <span class="gacha-dep__stat">${escapeHtml(selectedLabel)}</span>
            <span class="gacha-dep__stat gacha-dep__stat--gold">Lock ${escapeHtml(formatManaDisplay(totalLock))}</span>
          </div>
        </div>
        <div class="gacha-dep__body">
          <aside class="gacha-dep__left">
            <h3 class="gacha-dep__section-title">To Deposit</h3>
            <div class="gacha-dep__list">${selRows}</div>
          </aside>
          <section class="gacha-dep__right">
            <div class="gacha-dep__inv-head">
              <h3 class="gacha-dep__section-title">${nftCount} NFT + pack</h3>
              <div class="gacha-dep__pager">
                <button type="button" class="gacha-dep__page-btn" data-inv-prev ${!canPrev || this.busy ? 'disabled' : ''}>‹</button>
                <span class="gacha-dep__page-label">${this.invPage + 1}/${totalPages}</span>
                <button type="button" class="gacha-dep__page-btn" data-inv-next ${!canNext || this.busy ? 'disabled' : ''}>›</button>
              </div>
            </div>
            <div class="gacha-dep__grid gacha-dep__grid--hud">${cells.join('')}</div>
          </section>
        </div>
        <footer class="gacha-dep__footer">
          <p class="gacha-dep__footer-hint">${this.error ? escapeHtml(this.error) : this.status && this.mode === 'deposit' ? escapeHtml(this.status) : 'Pack always available · set prize + backing'}</p>
          <button type="button" class="gacha-panel__btn gacha-panel__btn--primary gacha-dep__confirm" data-dep-confirm ${this.busy || this.selections.length === 0 ? 'disabled' : ''}>
            Confirm${this.selections.length ? ` (${this.selections.length})` : ''}
          </button>
        </footer>
      </div>
    `
  }

  private openWinModal(win: PendingWin, isFake: boolean): void {
    this.pendingWin = win
    this.pendingWinIsFake = isFake
    const p = win.position
    const isPack = p?.kind === 'manaPack'
    const title = p
      ? isPack
        ? 'MANA Pack'
        : `Token #${escapeHtml(p.tokenId)}`
      : `Position #${win.positionId}`
    const sub = p
      ? isPack
        ? `Prize ${formatMana(p.packMana)} · Back ${formatMana(p.backing)}`
        : `Back ${formatMana(p.backing)} mMANA · ${shortAddr(p.depositor)}`
      : 'Settle your claim'
    const glyph = isPack ? '◈' : '✦'
    const demo = isFake
      ? `<p class="gacha-win-modal__demo">Demo mode — no chain. Tap Keep or Take to preview settle.</p>`
      : ''
    // Always enable settle on open; setBusy() toggles disabled while a settle runs.
    const card = this.winModal.querySelector('[data-win-card]')!
    card.innerHTML = `
      <button type="button" class="gacha-win-modal__x" data-win-close aria-label="Close">×</button>
      <div class="gacha-win-modal__kicker">Selected from pool</div>
      <div class="gacha-win-modal__art" aria-hidden="true">${glyph}</div>
      <h3 class="gacha-win-modal__title">${title}</h3>
      <p class="gacha-win-modal__sub">${sub}</p>
      <p class="gacha-win-modal__pos">pos ${win.positionId}</p>
      ${demo}
      <div class="gacha-win-modal__actions">
        <button type="button" class="gacha-panel__btn gacha-panel__btn--primary" data-settle-keep>Keep prize</button>
        <button type="button" class="gacha-panel__btn gacha-panel__btn--secondary" data-settle-take>Take MANA</button>
      </div>
    `
    this.winModal.hidden = false
    document.documentElement.classList.add('gacha-win-open')
  }

  private closeWinModal(opts: { clearPending: boolean }): void {
    this.winModal.hidden = true
    document.documentElement.classList.remove('gacha-win-open')
    const card = this.winModal.querySelector('[data-win-card]')
    if (card) card.innerHTML = ''
    if (opts.clearPending) {
      this.pendingWin = null
      this.pendingWinIsFake = false
    }
  }

  private renderSteps(): void {
    if (!this.steps.length || this.mode === 'deposit') {
      this.stepsEl.hidden = true
      this.stepsEl.innerHTML = ''
      return
    }
    this.stepsEl.hidden = false
    this.stepsEl.innerHTML = `<ol class="gacha-panel__step-list">${this.steps
      .map((s) => {
        const hash = s.hash
          ? ` <a class="gacha-panel__tx" href="${EXPLORER_TX}${s.hash}" target="_blank" rel="noopener">${s.hash.slice(0, 10)}…</a>`
          : ''
        const detail = s.detail ? ` <span class="gacha-panel__muted">${escapeHtml(s.detail)}</span>` : ''
        return `<li class="gacha-panel__step is-${s.status}">${escapeHtml(s.label)}${hash}${detail}</li>`
      })
      .join('')}</ol>`
  }

  private renderStatus(): void {
    if (this.mode === 'deposit') return
    if (this.error) {
      this.statusEl.hidden = false
      this.statusEl.className = 'gacha-panel__status is-error'
      this.statusEl.textContent = this.error
      return
    }
    if (!this.status) {
      this.statusEl.hidden = true
      this.statusEl.textContent = ''
      return
    }
    this.statusEl.hidden = false
    this.statusEl.className = 'gacha-panel__status'
    this.statusEl.textContent = this.status
  }

  private async onBodyClick(ev: MouseEvent): Promise<void> {
    const t = ev.target as HTMLElement

    if (this.mode === 'main') return

    // Deposit mode
    if (t.closest('[data-dep-back]')) {
      this.closeDeposit()
      return
    }
    if (t.closest('[data-inv-prev]')) {
      if (this.invPage > 0) {
        this.invPage -= 1
        this.renderDepositBody()
      }
      return
    }
    if (t.closest('[data-inv-next]')) {
      const totalPages = Math.max(1, Math.ceil(this.inventory.length / INV_PAGE_SIZE))
      if (this.invPage + 1 < totalPages) {
        this.invPage += 1
        this.renderDepositBody()
      }
      return
    }
    const remove = t.closest('[data-remove]') as HTMLElement | null
    if (remove?.dataset.remove) {
      this.selections = this.selections.filter((s) => s.item.id !== remove.dataset.remove)
      this.renderDepositBody()
      return
    }
    const pick = t.closest('[data-pick]') as HTMLElement | null
    if (pick?.dataset.pick) {
      this.togglePick(pick.dataset.pick)
      return
    }
    if (t.closest('[data-dep-confirm]')) {
      await this.confirmDeposits()
    }
  }

  private onBodyInput(ev: Event): void {
    if (this.mode !== 'deposit') return
    const input = ev.target as HTMLInputElement
    const prizeId = input.dataset.prizeId
    const backingId = input.dataset.backingId
    if (prizeId) {
      this.selections = this.selections.map((s) =>
        s.item.id === prizeId ? { ...s, packPrizeMana: input.value } : s
      )
    } else if (backingId) {
      this.selections = this.selections.map((s) =>
        s.item.id === backingId ? { ...s, backingMana: input.value } : s
      )
    } else {
      return
    }
    const gold = this.bodyEl.querySelector('.gacha-dep__stat--gold')
    if (gold) gold.textContent = `Lock ${formatManaDisplay(this.totalLockMana())}`
  }

  private togglePick(id: string): void {
    if (this.busy) return
    const existing = this.selections.find((s) => s.item.id === id)
    if (existing) {
      this.selections = this.selections.filter((s) => s.item.id !== id)
    } else {
      const item = this.inventory.find((i) => i.id === id)
      if (!item) return
      if (item.kind === 'pack') {
        this.selections = [
          ...this.selections,
          { item, backingMana: DEFAULT_BACKING, packPrizeMana: DEFAULT_PACK_PRIZE }
        ]
      } else {
        this.selections = [...this.selections, { item, backingMana: DEFAULT_BACKING }]
      }
    }
    this.renderDepositBody()
  }

  private async confirmDeposits(): Promise<void> {
    if (this.busy || this.selections.length === 0) return
    if (!this.sessionAddress()) {
      this.error = 'Connect a wallet to deposit'
      this.renderDepositBody()
      return
    }
    for (const s of this.selections) {
      const back = Number(s.backingMana)
      if (!Number.isFinite(back) || back <= 0) {
        this.error = `Invalid backing for ${s.item.name}`
        this.renderDepositBody()
        return
      }
      if (this.isPackSel(s)) {
        const prize = Number(s.packPrizeMana || '0')
        if (!Number.isFinite(prize) || prize <= 0) {
          this.error = `Invalid pack prize for ${s.item.name}`
          this.renderDepositBody()
          return
        }
      }
    }

    this.setBusy(true)
    this.error = null
    this.steps = []
    this.stepSeq = 0
    const queue = [...this.selections]
    try {
      for (let i = 0; i < queue.length; i++) {
        const sel = queue[i]!
        this.status = `Depositing ${i + 1}/${queue.length}: ${sel.item.name}…`
        this.renderDepositBody()
        if (this.isPackSel(sel)) {
          await runDepositManaPack({
            sessionAddress: this.sessionAddress(),
            packPrizeMana: sel.packPrizeMana || DEFAULT_PACK_PRIZE,
            backingMana: sel.backingMana,
            api: this.flowApi()
          })
          this.selections = this.selections.filter((s) => s.item.id !== sel.item.id)
        } else {
          await runDepositNft({
            sessionAddress: this.sessionAddress(),
            tokenId: BigInt(sel.item.tokenId),
            backingMana: sel.backingMana,
            api: this.flowApi()
          })
          this.inventory = this.inventory.filter((it) => it.id !== sel.item.id)
          this.selections = this.selections.filter((s) => s.item.id !== sel.item.id)
          if (this.wallet) {
            this.wallet = {
              ...this.wallet,
              ownedTokenIds: this.wallet.ownedTokenIds.filter((id) => String(id) !== sel.item.tokenId)
            }
          }
        }
      }
      this.status = 'Deposits locked in'
      this.steps = []
      await this.refresh()
      this.setMode('main')
      this.status = 'Deposits locked in — pool refreshed'
      this.renderStatus()
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e)
      this.renderDepositBody()
    } finally {
      this.setBusy(false)
      if (this.mode === 'deposit') this.renderDepositBody()
    }
  }

  private async onClaimClick(): Promise<void> {
    if (this.busy || this.mode !== 'main') return
    if (!this.sessionAddress() && !USE_FAKE_CLAIM) {
      this.error = 'Connect a wallet to claim'
      this.renderStatus()
      return
    }
    if (!this.pool || this.pool.positions.length === 0) {
      this.error = 'Pool is empty — deposit first'
      this.renderStatus()
      return
    }

    this.setBusy(true)
    this.error = null
    this.pendingWin = null
    this.pendingWinIsFake = false
    this.steps = []
    this.stepSeq = 0
    this.closeWinModal({ clearPending: true })
    this.renderSteps()
    this.status = USE_FAKE_CLAIM ? 'Demo claim…' : 'Claiming from pool…'
    this.renderStatus()

    try {
      let win: PendingWin | null = null
      let isFake = false

      if (USE_FAKE_CLAIM) {
        isFake = true
        await new Promise((r) => setTimeout(r, 700))
        const pick =
          this.pool.positions[Math.floor(Math.random() * this.pool.positions.length)] ?? null
        if (!pick) throw new Error('No positions to preview')
        win = { positionId: pick.positionId, position: pick }
      } else {
        const result = await runPull({
          sessionAddress: this.sessionAddress(),
          acquisitionFee: this.pool.acquisitionFee,
          api: this.flowApi()
        })
        win = result.win
        await this.refresh()
      }

      if (win) {
        this.status = isFake
          ? `Demo: selected pos #${win.positionId}`
          : `Selected pos #${win.positionId} — settle in modal`
        this.renderStatus()
        // Peers only — PM topic broadcast (no local toast).
        void this.broadcastClaim(win, isFake)
        // Clear busy before opening so Keep / Take are clickable immediately.
        this.setBusy(false)
        this.openWinModal(win, isFake)
      } else {
        this.status = 'Claim confirmed'
        this.renderStatus()
        this.setBusy(false)
      }
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e)
      this.renderStatus()
      this.setBusy(false)
    }
  }

  private async broadcastClaim(win: PendingWin, demo: boolean): Promise<void> {
    const session = this.options.getSession()
    const p = win.position
    const label = p
      ? p.kind === 'manaPack'
        ? 'MANA Pack'
        : `Token #${p.tokenId}`
      : `pos ${win.positionId}`
    const profile = session.getProfile()
    const displayName = profile?.displayName?.trim() || null
    const ok = await publishPoolClaim({
      identity: session.getAuthIdentity(),
      address: session.getAddress() ?? this.sessionAddress(),
      displayName,
      positionId: win.positionId,
      label,
      demo
    })
    // Surface peer-toast path in panel status (win modal stays the local UX).
    if (!ok) {
      this.status = demo
        ? `Demo win #${win.positionId} — peer toast not sent (check social logs)`
        : `Win #${win.positionId} — peer toast not sent (check social logs)`
      this.renderStatus()
    }
  }

  private async onWinModalClick(ev: MouseEvent): Promise<void> {
    const t = ev.target as HTMLElement
    if (t.closest('[data-win-close]') || t.closest('[data-win-backdrop]')) {
      if (!this.busy) this.closeWinModal({ clearPending: false })
      return
    }
    if (t.closest('[data-settle-keep]')) await this.runSettle(true)
    else if (t.closest('[data-settle-take]')) await this.runSettle(false)
  }

  private async runSettle(keepPrize: boolean): Promise<void> {
    if (this.busy || !this.pendingWin) return
    this.setBusy(true)
    this.error = null
    this.steps = []
    this.stepSeq = 0
    this.renderSteps()
    try {
      if (this.pendingWinIsFake) {
        const card = this.winModal.querySelector('[data-win-card]')
        if (card) {
          card.innerHTML = `
            <div class="gacha-win-modal__kicker">Demo settle</div>
            <div class="gacha-win-modal__art" aria-hidden="true">✓</div>
            <h3 class="gacha-win-modal__title">${keepPrize ? 'Kept prize' : 'Took MANA'}</h3>
            <p class="gacha-win-modal__sub">UI preview only — no chain transaction.</p>
            <div class="gacha-win-modal__actions">
              <button type="button" class="gacha-panel__btn gacha-panel__btn--primary" data-win-close>Done</button>
            </div>
          `
        }
        await new Promise((r) => setTimeout(r, 900))
        this.status = keepPrize
          ? 'Demo settle — keep (no chain)'
          : 'Demo settle — take MANA (no chain)'
        this.pendingWin = null
        this.pendingWinIsFake = false
        this.closeWinModal({ clearPending: true })
        this.renderStatus()
        return
      }

      await runSettle({
        sessionAddress: this.sessionAddress(),
        positionId: this.pendingWin.positionId,
        keepPrize,
        api: this.flowApi()
      })
      this.pendingWin = null
      this.pendingWinIsFake = false
      this.closeWinModal({ clearPending: true })
      this.status = keepPrize ? 'Settled — prize kept' : 'Settled — took MANA'
      this.renderStatus()
      await this.refresh()
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e)
      this.renderStatus()
      if (this.pendingWin) this.openWinModal(this.pendingWin, this.pendingWinIsFake)
    } finally {
      this.setBusy(false)
    }
  }

  async claimRewards(): Promise<void> {
    if (this.busy) return
    this.setBusy(true)
    this.steps = []
    this.stepSeq = 0
    try {
      await runWithdrawRewards({
        sessionAddress: this.sessionAddress(),
        api: this.flowApi()
      })
      await this.refresh()
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e)
      this.renderStatus()
    } finally {
      this.setBusy(false)
    }
  }
}
