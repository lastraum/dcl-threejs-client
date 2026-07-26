/**
 * 2D wearable pool — glass vitrine shelf (not casino reels, not FWA fan).
 * Deposit view: scene-style 1/3 selection + 2/3 inventory (incl. always-on MANA pack).
 */
import type { LoginResult } from '../../../auth/AuthClient'
import {
  ADDRESSES,
  EXPLORER_TX,
  escapeHtml,
  fetchPoolSnapshot,
  fetchWalletSnapshot,
  formatMana,
  runDepositManaPack,
  runDepositNft,
  runPull,
  runSettle,
  shortAddr,
  type FlowApi,
  type GachaPosition,
  type PendingWin,
  type PoolSnapshot,
  type TxStep,
  type WalletSnapshot
} from '../../../gacha'
import { publishPoolClaim } from '../../../social/publishPoolClaim'

export type GachaCasinoViewOptions = {
  login: LoginResult
  getLogin?: () => LoginResult
}

const INV_PAGE_SIZE = 12
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
  imageUrl?: string
}

type DepositSelection = {
  item: InvItem
  backingMana: string
  packPrizeMana?: string
}

type ViewMode = 'play' | 'deposit'

function walletAddress(login: LoginResult): string | undefined {
  if (login.kind === 'wallet' || login.kind === 'guest') return login.address
  return undefined
}

function itemLabel(p: GachaPosition): string {
  if (p.kind === 'manaPack') return 'MANA Pack'
  return `Token #${p.tokenId}`
}

function itemSub(p: GachaPosition): string {
  if (p.kind === 'manaPack') return `Prize ${formatMana(p.packMana)}`
  return `Back ${formatMana(p.backing)}`
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

export class GachaCasinoView {
  readonly root: HTMLElement

  private login: LoginResult
  private pool: PoolSnapshot | null = null
  private wallet: WalletSnapshot | null = null
  private inventory: InvItem[] = []
  private selections: DepositSelection[] = []
  private invPage = 0
  private mode: ViewMode = 'play'
  private busy = false
  private claiming = false
  private steps: TxStep[] = []
  private stepSeq = 0
  private status = ''
  private error: string | null = null
  private pendingWin: PendingWin | null = null
  private highlightPosId: number | null = null

  private readonly marqueeEl: HTMLElement
  private readonly taglineEl: HTMLElement
  private readonly playBodyEl: HTMLElement
  private readonly depositBodyEl: HTMLElement
  private readonly feeEl: HTMLElement
  private readonly balEl: HTMLElement
  private readonly walletEl: HTMLElement
  private readonly shelfEl: HTMLElement
  private readonly statusEl: HTMLElement
  private readonly stepsEl: HTMLElement
  private readonly resultEl: HTMLElement
  private readonly claimBtn: HTMLButtonElement
  private readonly depositBtn: HTMLButtonElement
  private readonly refreshBtn: HTMLButtonElement

  constructor(opts: GachaCasinoViewOptions) {
    this.login = opts.login

    this.root = document.createElement('div')
    this.root.className = 'gacha-casino gacha-casino--vitrine'
    this.root.innerHTML = `
      <div class="gacha-casino__stage">
        <div class="gacha-casino__machine gacha-casino__machine--vitrine">
          <header class="gacha-casino__header">
            <div class="gacha-casino__header-text">
              <h1 class="gacha-casino__title" data-marquee>Wearable Pool</h1>
              <p class="gacha-casino__tagline" data-tagline>Shared locker · deposit wearables or MANA · claim from the pool</p>
            </div>
          </header>

          <div class="gacha-casino__play" data-play>
            <div class="gacha-casino__hud">
              <div class="gacha-casino__chip">
                <span class="gacha-casino__chip-label">Claim fee</span>
                <span class="gacha-casino__chip-value" data-fee>—</span>
              </div>
              <div class="gacha-casino__chip gacha-casino__chip--gold">
                <span class="gacha-casino__chip-label">Your mMANA</span>
                <span class="gacha-casino__chip-value" data-bal>—</span>
              </div>
              <div class="gacha-casino__chip gacha-casino__chip--dim">
                <span class="gacha-casino__chip-label">Wallet</span>
                <span class="gacha-casino__chip-value gacha-casino__chip-value--sm" data-wallet>—</span>
              </div>
              <button type="button" class="gacha-casino__icon-btn" data-refresh title="Refresh pool" aria-label="Refresh">↻</button>
            </div>

            <div class="gacha-casino__vitrine" data-vitrine>
              <div class="gacha-casino__vitrine-glass" aria-hidden="true"></div>
              <div class="gacha-casino__vitrine-ledge" aria-hidden="true"></div>
              <div class="gacha-casino__shelf" data-shelf></div>
            </div>

            <div class="gacha-casino__result" data-result hidden></div>
            <div class="gacha-casino__steps" data-steps hidden></div>
            <p class="gacha-casino__status" data-status></p>

            <div class="gacha-casino__controls">
              <button type="button" class="gacha-casino__btn gacha-casino__btn--ghost" data-deposit-btn>
                Deposit
              </button>
              <button type="button" class="gacha-casino__btn gacha-casino__btn--claim" data-claim>
                <span class="gacha-casino__claim-label">Claim from pool</span>
                <span class="gacha-casino__claim-sub">weighted draw · settle after</span>
              </button>
            </div>

            <p class="gacha-casino__disclaimer">
              Gasless meta-tx · mock MANA & wearables on Polygon · same contracts as in-world client
            </p>
          </div>

          <div class="gacha-casino__deposit-view" data-deposit-view hidden></div>
        </div>
      </div>
    `

    this.marqueeEl = this.root.querySelector('[data-marquee]')!
    this.taglineEl = this.root.querySelector('[data-tagline]')!
    this.playBodyEl = this.root.querySelector('[data-play]')!
    this.depositBodyEl = this.root.querySelector('[data-deposit-view]')!
    this.feeEl = this.root.querySelector('[data-fee]')!
    this.balEl = this.root.querySelector('[data-bal]')!
    this.walletEl = this.root.querySelector('[data-wallet]')!
    this.shelfEl = this.root.querySelector('[data-shelf]')!
    this.statusEl = this.root.querySelector('[data-status]')!
    this.stepsEl = this.root.querySelector('[data-steps]')!
    this.resultEl = this.root.querySelector('[data-result]')!
    this.claimBtn = this.root.querySelector('[data-claim]')!
    this.depositBtn = this.root.querySelector('[data-deposit-btn]')!
    this.refreshBtn = this.root.querySelector('[data-refresh]')!

    this.claimBtn.addEventListener('click', () => void this.onClaim())
    this.depositBtn.addEventListener('click', () => this.openDeposit())
    this.refreshBtn.addEventListener('click', () => void this.refresh())
    this.resultEl.addEventListener('click', (ev) => void this.onResultClick(ev))
    this.depositBodyEl.addEventListener('click', (ev) => void this.onDepositViewClick(ev))
    this.depositBodyEl.addEventListener('input', (ev) => this.onDepositViewInput(ev))
  }

  mount(): void {
    void this.refresh()
  }

  setLogin(login: LoginResult): void {
    this.login = login
    void this.refresh()
  }

  dispose(): void {
    this.root.remove()
  }

  private addr(): string | undefined {
    return walletAddress(this.login)
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
    this.claimBtn.disabled = on || this.claiming
    this.depositBtn.disabled = on
    this.refreshBtn.disabled = on
    this.root.classList.toggle('is-busy', on)
    if (this.mode === 'deposit') this.renderDepositView()
  }

  private setMode(mode: ViewMode): void {
    this.mode = mode
    this.root.classList.toggle('is-deposit-mode', mode === 'deposit')
    this.playBodyEl.hidden = mode !== 'play'
    this.depositBodyEl.hidden = mode !== 'deposit'
    if (mode === 'deposit') {
      this.marqueeEl.textContent = 'Deposit to pool'
      this.taglineEl.textContent = 'Select inventory · set backing · lock into the shared locker'
      this.renderDepositView()
    } else {
      this.marqueeEl.textContent = this.pendingWin ? 'Claim ready to settle' : 'Wearable Pool'
      this.taglineEl.textContent = 'Shared locker · deposit wearables or MANA · claim from the pool'
    }
  }

  private openDeposit(): void {
    if (this.busy || this.claiming) return
    this.error = null
    this.syncInventoryFromWallet()
    const owned = new Set(this.inventory.map((i) => i.id))
    this.selections = this.selections.filter((s) => owned.has(s.item.id))
    this.invPage = 0
    this.setMode('deposit')
  }

  private closeDeposit(): void {
    if (this.busy) return
    this.setMode('play')
    this.renderStatus()
  }

  private syncInventoryFromWallet(): void {
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
    if (this.mode === 'play') {
      this.status = 'Loading pool…'
      this.renderStatus()
    }
    try {
      this.pool = await fetchPoolSnapshot()
      const a = this.addr()
      if (a && /^0x[a-fA-F0-9]{40}$/.test(a)) {
        try {
          this.wallet = await fetchWalletSnapshot(a as `0x${string}`)
        } catch {
          this.wallet = null
        }
      } else {
        this.wallet = null
      }
      this.syncInventoryFromWallet()
      this.renderHud()
      if (this.mode === 'play') {
        this.renderShelf(this.pool.positions)
        this.renderResult()
        this.status =
          this.pool.positions.length > 0
            ? `${this.pool.positions.length} in the vitrine · deposit or claim`
            : 'Empty pool — deposit a wearable or MANA pack to fill the shelf'
        this.renderStatus()
      } else {
        this.renderDepositView()
      }
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e)
      this.renderStatus()
      if (this.mode === 'play') {
        this.shelfEl.innerHTML = `<div class="gacha-casino__error">${escapeHtml(this.error)}</div>`
      }
    }
  }

  private renderHud(): void {
    this.feeEl.textContent = this.pool ? `${formatMana(this.pool.acquisitionFee)} mMANA` : '—'
    this.balEl.textContent = this.wallet ? formatMana(this.wallet.mana) : '—'
    const a = this.addr()
    this.walletEl.textContent = a ? shortAddr(a) : 'Not connected'
    if (this.wallet && this.wallet.claimable > 0n) {
      this.walletEl.textContent += ` · +${formatMana(this.wallet.claimable)} claim`
    }
  }

  // ── Vitrine shelf ─────────────────────────────────────────────────────────

  private renderShelf(positions: GachaPosition[]): void {
    this.shelfEl.innerHTML = ''
    this.shelfEl.classList.toggle('is-empty', positions.length === 0)

    if (positions.length === 0) {
      this.shelfEl.innerHTML = `
        <div class="gacha-vitrine__empty">
          <div class="gacha-vitrine__empty-icon" aria-hidden="true">◇</div>
          <p>Nothing on the shelf yet</p>
          <p class="gacha-vitrine__empty-hint">Deposit a wearable or MANA pack to fill the pool</p>
        </div>`
      return
    }

    const track = document.createElement('div')
    track.className = 'gacha-vitrine__track'
    for (const p of positions) {
      track.appendChild(this.makeShelfCard(p))
    }
    this.shelfEl.appendChild(track)

    // Scroll highlighted card into view after claim
    if (this.highlightPosId != null) {
      requestAnimationFrame(() => {
        const card = this.shelfEl.querySelector(
          `[data-pos="${this.highlightPosId}"]`
        ) as HTMLElement | null
        card?.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' })
      })
    }
  }

  private makeShelfCard(p: GachaPosition): HTMLElement {
    const el = document.createElement('article')
    const isPack = p.kind === 'manaPack'
    const lit = this.highlightPosId === p.positionId
    el.className = `gacha-vitrine__card${isPack ? ' is-pack' : ''}${lit ? ' is-spotlight' : ''}`
    el.dataset.pos = String(p.positionId)
    const glyph = isPack ? '◈' : '✦'
    const img = p.imageUrl
      ? `<img class="gacha-vitrine__card-img" src="${escapeHtml(p.imageUrl)}" alt="" loading="lazy" />`
      : `<div class="gacha-vitrine__card-glyph" aria-hidden="true">${glyph}</div>`
    el.innerHTML = `
      <div class="gacha-vitrine__card-art">${img}</div>
      <div class="gacha-vitrine__card-body">
        <div class="gacha-vitrine__card-title">${escapeHtml(itemLabel(p))}</div>
        <div class="gacha-vitrine__card-meta">${escapeHtml(itemSub(p))}</div>
        <div class="gacha-vitrine__card-foot">
          <span>pos ${p.positionId}</span>
          <span>${shortAddr(p.depositor)}</span>
        </div>
      </div>
    `
    return el
  }

  // ── Deposit view ──────────────────────────────────────────────────────────

  private renderDepositView(): void {
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
            <div class="gacha-dep__row-sub">PRIZE + BACKING · ESCROW</div>
          </div>
          <label class="gacha-dep__backing">
            <span>Pack prize</span>
            <input type="text" inputmode="decimal" data-prize-id="${escapeHtml(sel.item.id)}" value="${escapeHtml(sel.packPrizeMana || DEFAULT_PACK_PRIZE)}" ${this.busy ? 'disabled' : ''} />
          </label>
          <label class="gacha-dep__backing">
            <span>Backing</span>
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
            <span>MANA backing</span>
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
          <div class="gacha-dep__cell-sub">${isPack ? 'ALWAYS AVAILABLE' : `${escapeHtml(item.rarity.toUpperCase())} · #${escapeHtml(item.tokenId)}`}</div>
        </button>`)
    }

    this.depositBodyEl.innerHTML = `
      <div class="gacha-dep">
        <header class="gacha-dep__header">
          <button type="button" class="gacha-casino__btn gacha-casino__btn--ghost gacha-dep__back" data-dep-back ${this.busy ? 'disabled' : ''}>← Back</button>
          <div class="gacha-dep__header-stats">
            <span class="gacha-dep__stat gacha-dep__stat--ok">Wallet: ${escapeHtml(balLabel)} mMANA</span>
            <span class="gacha-dep__stat">${escapeHtml(selectedLabel)}</span>
            <span class="gacha-dep__stat gacha-dep__stat--gold">Lock: ${escapeHtml(formatManaDisplay(totalLock))} mMANA</span>
          </div>
        </header>

        <div class="gacha-dep__body">
          <aside class="gacha-dep__left">
            <h3 class="gacha-dep__section-title">To Deposit</h3>
            <div class="gacha-dep__list">${selRows}</div>
          </aside>
          <section class="gacha-dep__right">
            <div class="gacha-dep__inv-head">
              <h3 class="gacha-dep__section-title">Your Inventory · ${nftCount} NFT${nftCount === 1 ? '' : 's'} + pack</h3>
              <div class="gacha-dep__pager">
                <button type="button" class="gacha-dep__page-btn" data-inv-prev ${!canPrev || this.busy ? 'disabled' : ''}>‹</button>
                <span class="gacha-dep__page-label">${this.invPage + 1} / ${totalPages}</span>
                <button type="button" class="gacha-dep__page-btn" data-inv-next ${!canNext || this.busy ? 'disabled' : ''}>›</button>
              </div>
            </div>
            <div class="gacha-dep__grid">${cells.join('')}</div>
          </section>
        </div>

        <footer class="gacha-dep__footer">
          <p class="gacha-dep__footer-hint">${this.error ? escapeHtml(this.error) : this.status && this.mode === 'deposit' ? escapeHtml(this.status) : 'MANA Pack is always available · NFTs when you own them · set prize + backing for packs'}</p>
          <button type="button" class="gacha-casino__btn gacha-casino__btn--gold gacha-dep__confirm" data-dep-confirm ${this.busy || this.selections.length === 0 ? 'disabled' : ''}>
            Confirm deposit${this.selections.length ? ` (${this.selections.length})` : ''}
          </button>
        </footer>
        <div class="gacha-casino__steps gacha-dep__steps" data-dep-steps ${this.steps.length && this.mode === 'deposit' ? '' : 'hidden'}></div>
      </div>
    `

    const stepsHost = this.depositBodyEl.querySelector('[data-dep-steps]') as HTMLElement | null
    if (stepsHost && this.steps.length && this.mode === 'deposit') {
      stepsHost.hidden = false
      stepsHost.innerHTML = this.stepsEl.innerHTML || this.buildStepsHtml()
    }
  }

  private buildStepsHtml(): string {
    if (!this.steps.length) return ''
    return `<ol class="gacha-casino__step-list">${this.steps
      .map((s) => {
        const hash = s.hash
          ? ` <a href="${EXPLORER_TX}${s.hash}" target="_blank" rel="noopener">${s.hash.slice(0, 10)}…</a>`
          : ''
        const detail = s.detail ? ` <span>${escapeHtml(s.detail)}</span>` : ''
        return `<li class="is-${s.status}">${escapeHtml(s.label)}${hash}${detail}</li>`
      })
      .join('')}</ol>`
  }

  private onDepositViewClick(ev: MouseEvent): void {
    const t = ev.target as HTMLElement
    if (t.closest('[data-dep-back]')) {
      this.closeDeposit()
      return
    }
    if (t.closest('[data-inv-prev]')) {
      if (this.invPage > 0) {
        this.invPage -= 1
        this.renderDepositView()
      }
      return
    }
    if (t.closest('[data-inv-next]')) {
      const totalPages = Math.max(1, Math.ceil(this.inventory.length / INV_PAGE_SIZE))
      if (this.invPage + 1 < totalPages) {
        this.invPage += 1
        this.renderDepositView()
      }
      return
    }
    const remove = t.closest('[data-remove]') as HTMLElement | null
    if (remove?.dataset.remove) {
      this.selections = this.selections.filter((s) => s.item.id !== remove.dataset.remove)
      this.renderDepositView()
      return
    }
    const pick = t.closest('[data-pick]') as HTMLElement | null
    if (pick?.dataset.pick) {
      this.togglePick(pick.dataset.pick)
      return
    }
    if (t.closest('[data-dep-confirm]')) {
      void this.confirmDeposits()
    }
  }

  private onDepositViewInput(ev: Event): void {
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
    const gold = this.depositBodyEl.querySelector('.gacha-dep__stat--gold')
    if (gold) gold.textContent = `Lock: ${formatManaDisplay(this.totalLockMana())} mMANA`
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
    this.renderDepositView()
  }

  private async confirmDeposits(): Promise<void> {
    if (this.busy || this.selections.length === 0) return
    if (!this.addr()) {
      this.error = 'Connect a wallet to deposit'
      this.renderDepositView()
      return
    }
    for (const s of this.selections) {
      const back = Number(s.backingMana)
      if (!Number.isFinite(back) || back <= 0) {
        this.error = `Invalid backing for ${s.item.name}`
        this.renderDepositView()
        return
      }
      if (this.isPackSel(s)) {
        const prize = Number(s.packPrizeMana || '0')
        if (!Number.isFinite(prize) || prize <= 0) {
          this.error = `Invalid pack prize for ${s.item.name}`
          this.renderDepositView()
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
        this.renderDepositView()
        if (this.isPackSel(sel)) {
          await runDepositManaPack({
            sessionAddress: this.addr(),
            packPrizeMana: sel.packPrizeMana || DEFAULT_PACK_PRIZE,
            backingMana: sel.backingMana,
            api: this.flowApi()
          })
          this.selections = this.selections.filter((s) => s.item.id !== sel.item.id)
        } else {
          await runDepositNft({
            sessionAddress: this.addr(),
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
      this.setMode('play')
      this.status = 'Deposits locked in — shelf refreshed'
      this.renderStatus()
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e)
      this.renderDepositView()
    } finally {
      this.setBusy(false)
      if (this.mode === 'deposit') this.renderDepositView()
    }
  }

  // ── Claim / settle ────────────────────────────────────────────────────────

  private renderStatus(): void {
    if (this.mode === 'deposit') return
    if (this.error) {
      this.statusEl.className = 'gacha-casino__status is-error'
      this.statusEl.textContent = this.error
      return
    }
    this.statusEl.className = 'gacha-casino__status'
    this.statusEl.textContent = this.status
  }

  private renderSteps(): void {
    if (!this.steps.length) {
      this.stepsEl.hidden = true
      this.stepsEl.innerHTML = ''
      return
    }
    this.stepsEl.hidden = this.mode !== 'play'
    this.stepsEl.innerHTML = this.buildStepsHtml()
    if (this.mode === 'deposit') {
      const host = this.depositBodyEl.querySelector('[data-dep-steps]') as HTMLElement | null
      if (host) {
        host.hidden = false
        host.innerHTML = this.buildStepsHtml()
      }
    }
  }

  private renderResult(): void {
    if (!this.pendingWin) {
      this.resultEl.hidden = true
      this.resultEl.innerHTML = ''
      this.root.classList.remove('has-win')
      return
    }
    this.root.classList.add('has-win')
    this.resultEl.hidden = false
    const p = this.pendingWin.position
    const label = p
      ? p.kind === 'manaPack'
        ? `MANA pack · pos ${p.positionId}`
        : `Token #${p.tokenId} · pos ${p.positionId}`
      : `Position #${this.pendingWin.positionId}`
    this.resultEl.innerHTML = `
      <div class="gacha-casino__win-banner gacha-casino__win-banner--pool">
        <div class="gacha-casino__win-title">Selected from pool</div>
        <div class="gacha-casino__win-name">${escapeHtml(label)}</div>
        <p class="gacha-casino__win-hint">Settle — keep the prize or take the MANA bid.</p>
        <div class="gacha-casino__win-actions">
          <button type="button" class="gacha-casino__btn gacha-casino__btn--gold" data-settle-keep ${this.busy ? 'disabled' : ''}>Keep prize</button>
          <button type="button" class="gacha-casino__btn gacha-casino__btn--ghost" data-settle-take ${this.busy ? 'disabled' : ''}>Take MANA</button>
        </div>
      </div>
    `
  }

  private async onClaim(): Promise<void> {
    if (this.busy || this.claiming || this.mode !== 'play') return
    if (!this.addr()) {
      this.error = 'Connect a wallet to claim'
      this.renderStatus()
      return
    }
    if (!this.pool || this.pool.activeCount === 0n) {
      this.error = 'Empty pool — deposit first'
      this.renderStatus()
      return
    }

    this.setBusy(true)
    this.claiming = true
    this.error = null
    this.pendingWin = null
    this.highlightPosId = null
    this.steps = []
    this.stepSeq = 0
    this.renderResult()
    this.renderSteps()
    this.marqueeEl.textContent = 'Claiming…'
    this.root.classList.add('is-claiming')

    try {
      const { win } = await runPull({
        sessionAddress: this.addr(),
        acquisitionFee: this.pool.acquisitionFee,
        api: this.flowApi()
      })
      this.pendingWin = win
      this.highlightPosId = win?.positionId ?? null
      this.marqueeEl.textContent = win ? 'Claim ready to settle' : 'Wearable Pool'
      this.status = win ? `Pool selected position #${win.positionId}` : 'Claim confirmed'
      this.renderResult()
      this.renderStatus()
      const keepWin = this.pendingWin
      const keepHi = this.highlightPosId
      await this.refresh()
      this.pendingWin = keepWin
      this.highlightPosId = keepHi
      this.renderShelf(this.pool?.positions ?? [])
      this.renderResult()
      if (win) {
        this.marqueeEl.textContent = 'Claim ready to settle'
        // Peers only — PM topic (no local toast).
        const p = win.position
        const label = p
          ? p.kind === 'manaPack'
            ? 'MANA Pack'
            : `Token #${p.tokenId}`
          : `pos ${win.positionId}`
        const displayName =
          this.login.kind === 'guest' ? this.login.displayName : null
        void publishPoolClaim({
          identity: this.login.identity,
          address: this.addr(),
          displayName,
          positionId: win.positionId,
          label,
          demo: false
        })
      }
    } catch (e) {
      this.marqueeEl.textContent = 'Wearable Pool'
      this.error = e instanceof Error ? e.message : String(e)
      this.renderStatus()
    } finally {
      this.root.classList.remove('is-claiming')
      this.claiming = false
      this.setBusy(false)
      this.renderResult()
    }
  }

  private async onResultClick(ev: MouseEvent): Promise<void> {
    const t = ev.target as HTMLElement
    if (t.closest('[data-settle-keep]')) await this.runSettle(true)
    else if (t.closest('[data-settle-take]')) await this.runSettle(false)
  }

  private async runSettle(keep: boolean): Promise<void> {
    if (this.busy || !this.pendingWin) return
    this.setBusy(true)
    this.error = null
    this.steps = []
    this.stepSeq = 0
    this.renderSteps()
    try {
      await runSettle({
        sessionAddress: this.addr(),
        positionId: this.pendingWin.positionId,
        keepPrize: keep,
        api: this.flowApi()
      })
      this.pendingWin = null
      this.highlightPosId = null
      this.marqueeEl.textContent = 'Wearable Pool'
      this.status = keep ? 'Settled — prize is yours' : 'Settled — took the MANA bid'
      this.renderResult()
      await this.refresh()
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e)
      this.renderStatus()
    } finally {
      this.setBusy(false)
      this.renderResult()
    }
  }
}

function formatManaDisplay(n: number): string {
  if (!Number.isFinite(n)) return '0'
  if (n >= 1000) {
    return n.toLocaleString(undefined, { maximumFractionDigits: 0 })
  }
  return n.toLocaleString(undefined, { maximumFractionDigits: 2, minimumFractionDigits: 0 })
}
