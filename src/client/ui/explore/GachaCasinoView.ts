/**
 * 2D grab bag — glass display shelf.
 * Deposit view: scene-style 1/3 selection + 2/3 inventory (incl. always-on MANA pack).
 */
import type { LoginResult } from '../../../auth/AuthClient'
import {
  ADDRESSES,
  EXPLORER_TX,
  computeClaimChanceLabels,
  escapeHtml,
  fetchPoolSnapshot,
  fetchWalletSnapshot,
  fetchCreatorCollections,
  fetchCollectionItems,
  formatMana,
  runDepositManaPack,
  runDepositNft,
  runStockFromCollection,
  runPull,
  runSettle,
  shortAddr,
  humanizeStockError,
  hideGachaSignOverlay,
  requestGachaSignContinue,
  showGachaSuccessOverlay,
  syncGachaSignOverlay,
  type CreatorCollection,
  type CreatorCollectionItem,
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
const DEFAULT_STOCK_COUNT = '5'
const MANA_PACK_INV_ID = 'mana-pack'

type DepositSource = 'wallet' | 'creator'

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
  if (p.name?.trim()) return p.name.trim()
  if (p.issuedId) return `Issue #${p.issuedId}`
  return `Token #${p.tokenId}`
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

/** Skeleton shelf while pool snapshot loads (distinct from true empty). */
function shelfLoadingHtml(count: number, label: string): string {
  const cards = Array.from({ length: count }, (_, i) => {
    const delay = (i * 0.08).toFixed(2)
    return `
      <div class="gacha-shelf-skel__card" style="animation-delay:${delay}s" aria-hidden="true">
        <div class="gacha-shelf-skel__art"></div>
        <div class="gacha-shelf-skel__lines">
          <div class="gacha-shelf-skel__line gacha-shelf-skel__line--title"></div>
          <div class="gacha-shelf-skel__line"></div>
          <div class="gacha-shelf-skel__line gacha-shelf-skel__line--short"></div>
        </div>
      </div>`
  }).join('')
  return `
    <div class="gacha-shelf-skel" role="status" aria-live="polite" aria-busy="true">
      <div class="gacha-shelf-skel__track">${cards}</div>
      <div class="gacha-shelf-skel__footer">
        <span class="gacha-shelf-skel__spin" aria-hidden="true"></span>
        <p class="gacha-shelf-skel__label">${escapeHtml(label)}</p>
      </div>
    </div>`
}

export class GachaCasinoView {
  readonly root: HTMLElement

  private login: LoginResult
  private pool: PoolSnapshot | null = null
  private wallet: WalletSnapshot | null = null
  private inventory: InvItem[] = []
  private selections: DepositSelection[] = []
  private invPage = 0
  private depositSource: DepositSource = 'wallet'
  private creatorBrowse: 'collections' | 'items' = 'collections'
  private creatorCollections: CreatorCollection[] = []
  private creatorItems: CreatorCollectionItem[] = []
  private creatorLoading = false
  private creatorLoadError: string | null = null
  private creatorPage = 0
  private selectedCreatorCollection: CreatorCollection | null = null
  private stockItem: CreatorCollectionItem | null = null
  private stockMintCount = DEFAULT_STOCK_COUNT
  private stockAvgBacking = DEFAULT_BACKING
  private creatorAbort: AbortController | null = null
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
  private readonly playBodyEl: HTMLElement
  private readonly depositBodyEl: HTMLElement
  private readonly feeEl: HTMLElement
  private readonly balEl: HTMLElement
  private readonly poolCountEl: HTMLElement
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
              <h1 class="gacha-casino__title" data-marquee>Grab bag</h1>
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
                <span class="gacha-casino__chip-label">In bag</span>
                <span class="gacha-casino__chip-value" data-pool-count>—</span>
              </div>
              <button type="button" class="gacha-casino__icon-btn" data-refresh title="Refresh grab bag" aria-label="Refresh">↻</button>
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
                <span class="gacha-casino__claim-label">Claim from grab bag</span>
              </button>
            </div>
          </div>

          <div class="gacha-casino__deposit-view" data-deposit-view hidden></div>
        </div>
      </div>
    `

    this.marqueeEl = this.root.querySelector('[data-marquee]')!
    this.playBodyEl = this.root.querySelector('[data-play]')!
    this.depositBodyEl = this.root.querySelector('[data-deposit-view]')!
    this.feeEl = this.root.querySelector('[data-fee]')!
    this.balEl = this.root.querySelector('[data-bal]')!
    this.poolCountEl = this.root.querySelector('[data-pool-count]')!
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
    this.renderShelfLoading()
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
        if (this.steps.length) this.renderSteps()
      },
      pushStep: (label) => {
        const id = `s${++this.stepSeq}`
        this.steps = this.steps.map((s) =>
          s.status === 'active' ? { ...s, status: 'done' as const } : s
        )
        this.steps = [...this.steps, { id, label, status: 'active' }]
        this.status = label
        this.renderSteps()
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
    if (!on && this.steps.length === 0) hideGachaSignOverlay()
    if (this.mode === 'deposit') this.renderDepositView()
  }

  private setMode(mode: ViewMode): void {
    this.mode = mode
    this.root.classList.toggle('is-deposit-mode', mode === 'deposit')
    this.playBodyEl.hidden = mode !== 'play'
    this.depositBodyEl.hidden = mode !== 'deposit'
    if (mode === 'deposit') {
      this.marqueeEl.textContent = 'Deposit to grab bag'
      this.renderDepositView()
    } else {
      this.marqueeEl.textContent = this.pendingWin ? 'Claim ready to settle' : 'Grab bag'
    }
  }

  private openDeposit(): void {
    if (this.busy || this.claiming) return
    this.error = null
    this.depositSource = 'wallet'
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
      this.status = ''
      this.renderStatus()
      this.renderShelfLoading()
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
        this.renderShelf(this.pool.positions, { scrollToEnd: true })
        this.renderResult()
        this.status =
          this.pool.positions.length > 0 || this.pool.activeCount > 0n
            ? ''
            : 'Empty grab bag — deposit a wearable or MANA pack to fill the shelf'
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
    // Prefer on-chain activeCount (truth); fall back to loaded shelf rows
    const n =
      this.pool != null
        ? Math.max(Number(this.pool.activeCount), this.pool.positions.length)
        : 0
    this.poolCountEl.textContent = String(n)
  }

  // ── Display shelf ─────────────────────────────────────────────────────────

  private renderShelfLoading(): void {
    this.shelfEl.classList.add('is-empty', 'is-loading')
    this.shelfEl.innerHTML = shelfLoadingHtml(6, 'Opening the grab bag…')
  }

  private renderShelf(positions: GachaPosition[], opts?: { scrollToEnd?: boolean }): void {
    this.shelfEl.innerHTML = ''
    this.shelfEl.classList.toggle('is-empty', positions.length === 0)
    this.shelfEl.classList.remove('is-loading')

    if (positions.length === 0) {
      this.shelfEl.innerHTML = `
        <div class="gacha-vitrine__empty">
          <div class="gacha-vitrine__empty-icon" aria-hidden="true">◈</div>
          <p class="gacha-vitrine__empty-title">Grab bag is empty</p>
          <p class="gacha-vitrine__empty-hint">Deposit a wearable or MANA pack to fill the shelf</p>
          <p class="gacha-vitrine__empty-hint gacha-vitrine__empty-hint--soft">Weighted chance shows once items are in the bag</p>
        </div>`
      return
    }

    // positions are oldest → newest; new deposits sit at the end
    const chances = computeClaimChanceLabels(positions)
    const track = document.createElement('div')
    track.className = 'gacha-vitrine__track'
    for (const p of positions) {
      track.appendChild(this.makeShelfCard(p, chances.get(p.positionId) ?? '—'))
    }
    this.shelfEl.appendChild(track)

    // Scroll highlighted card into view after claim, else jump to newest (right end)
    requestAnimationFrame(() => {
      if (this.highlightPosId != null) {
        const card = this.shelfEl.querySelector(
          `[data-pos="${this.highlightPosId}"]`
        ) as HTMLElement | null
        card?.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' })
        return
      }
      if (opts?.scrollToEnd) {
        this.shelfEl.scrollTo({ left: this.shelfEl.scrollWidth, behavior: 'smooth' })
      }
    })
  }

  private makeShelfCard(p: GachaPosition, chanceLabel: string): HTMLElement {
    const el = document.createElement('article')
    const isPack = p.kind === 'manaPack'
    const lit = this.highlightPosId === p.positionId
    const rarity = isPack ? 'legendary' : (p.rarity || 'common').toLowerCase()
    el.className = `gacha-vitrine__card${isPack ? ' is-pack' : ''}${lit ? ' is-spotlight' : ''} gacha-rarity--${rarity}`
    el.dataset.pos = String(p.positionId)
    el.dataset.rarity = rarity
    const glyph = isPack ? '◈' : '✦'
    const img = p.imageUrl
      ? `<img class="gacha-vitrine__card-img" src="${escapeHtml(p.imageUrl)}" alt="" loading="lazy" decoding="async" />`
      : `<div class="gacha-vitrine__card-glyph" aria-hidden="true">${glyph}</div>`
    const title = itemLabel(p)
    // Same line stack as wearables: title → detail → rarity → backed by → chance
    const detail = isPack
      ? `Prize ${formatMana(p.packMana)} mMANA`
      : p.issuedId
        ? `Issue #${p.issuedId}`
        : `Token #${p.tokenId}`
    const rarityLabel = isPack ? 'pack' : rarity
    const backing = `Backed by ${formatMana(p.backing)} mMANA`
    const chance =
      chanceLabel === '—' ? '— chance' : `${escapeHtml(chanceLabel)} chance`
    el.innerHTML = `
      <div class="gacha-vitrine__card-art gacha-rarity-bg--${escapeHtml(rarity)}">${img}</div>
      <div class="gacha-vitrine__card-body">
        <div class="gacha-vitrine__card-line gacha-vitrine__card-line--title" title="${escapeHtml(title)}">${escapeHtml(title)}</div>
        <div class="gacha-vitrine__card-line">${escapeHtml(detail)}</div>
        <div class="gacha-vitrine__card-line gacha-vitrine__card-line--rarity is-${escapeHtml(rarity)}">${escapeHtml(rarityLabel)}</div>
        <div class="gacha-vitrine__card-line">${escapeHtml(backing)}</div>
        <div class="gacha-vitrine__card-line gacha-vitrine__card-line--chance">${chance}</div>
      </div>
    `
    return el
  }

  // ── Deposit view ──────────────────────────────────────────────────────────

  private renderCreatorDepositHtml(balLabel: string, tabs: string): string {
    const count = Math.max(0, Math.floor(Number(this.stockMintCount) || 0))
    const avg = Number(this.stockAvgBacking) || 0
    const lockEst = this.stockItem && count > 0 && avg > 0 ? formatManaDisplay(count * avg) : '0'
    const pageSize = INV_PAGE_SIZE
    const browsingItems = this.creatorBrowse === 'items'
    const gridList = browsingItems ? this.creatorItems : this.creatorCollections
    const totalPages = Math.max(1, Math.ceil(gridList.length / pageSize))
    if (this.creatorPage >= totalPages) this.creatorPage = totalPages - 1
    const start = this.creatorPage * pageSize
    const pageSlice = gridList.slice(start, start + pageSize)
    const canPrev = this.creatorPage > 0
    const canNext = this.creatorPage + 1 < totalPages

    const selBlock = !this.stockItem
      ? `<p class="gacha-dep__empty">Pick a collection, then an item →</p>`
      : `
        <div class="gacha-dep__stock-card">
          <button type="button" class="gacha-dep__stock-clear" data-stock-clear aria-label="Clear selection" ${this.busy ? 'disabled' : ''}>×</button>
          <div class="gacha-dep__stock-top">
            <div class="gacha-dep__stock-thumb gacha-dep__thumb--${escapeHtml(this.stockItem.rarity)}">
              ${
                this.stockItem.thumbnail
                  ? `<img src="${escapeHtml(this.stockItem.thumbnail)}" alt="" loading="lazy" />`
                  : 'NFT'
              }
            </div>
            <div class="gacha-dep__stock-meta">
              <div class="gacha-dep__stock-name" title="${escapeHtml(this.stockItem.name)}">${escapeHtml(this.stockItem.name)}</div>
              <div class="gacha-dep__stock-tags">
                <span class="gacha-dep__pill gacha-dep__pill--${escapeHtml(this.stockItem.rarity)}">${escapeHtml(this.stockItem.rarity)}</span>
                <span class="gacha-dep__pill">item ${this.stockItem.itemId}</span>
              </div>
              <div class="gacha-dep__stock-addr" title="${escapeHtml(this.stockItem.contractAddress)}">${escapeHtml(shortAddr(this.stockItem.contractAddress))}</div>
            </div>
          </div>
          <div class="gacha-dep__stock-fields">
            <label class="gacha-dep__stock-field">
              <span>Mint count</span>
              <input type="text" inputmode="numeric" data-stock-count value="${escapeHtml(this.stockMintCount)}" ${this.busy ? 'disabled' : ''} />
            </label>
            <label class="gacha-dep__stock-field">
              <span>Avg backing</span>
              <input type="text" inputmode="decimal" data-stock-backing value="${escapeHtml(this.stockAvgBacking)}" ${this.busy ? 'disabled' : ''} />
            </label>
          </div>
        </div>`

    let cells = ''
    if (this.creatorLoading) {
      cells = `<div class="gacha-dep__empty gacha-dep__empty--center">Loading…</div>`
    } else if (this.creatorLoadError) {
      cells = `<div class="gacha-dep__empty gacha-dep__empty--center">${escapeHtml(this.creatorLoadError)}</div>`
    } else if (gridList.length === 0) {
      cells = browsingItems
        ? `<div class="gacha-dep__empty gacha-dep__empty--center">No items in this collection</div>`
        : `<div class="gacha-dep__empty gacha-dep__empty--center">No Polygon collections for this wallet<br/><span class="gacha-dep__creator-note">Indexed via marketplace (published Collection V2)</span></div>`
    } else {
      const parts: string[] = []
      for (let i = 0; i < pageSize; i++) {
        const row = pageSlice[i]
        if (!row) {
          parts.push(`<div class="gacha-dep__cell gacha-dep__cell--empty" aria-hidden="true"></div>`)
          continue
        }
        if (browsingItems) {
          const it = row as CreatorCollectionItem
          const on =
            this.stockItem?.contractAddress === it.contractAddress &&
            this.stockItem?.itemId === it.itemId
          const thumb = it.thumbnail
            ? `<img class="gacha-dep__cell-img" src="${escapeHtml(it.thumbnail)}" alt="" loading="lazy" />`
            : 'NFT'
          const avail = it.available != null ? `${it.available} left` : `item ${it.itemId}`
          parts.push(`
            <button type="button" class="gacha-dep__cell${on ? ' is-selected' : ''}" data-creator-item="${it.itemId}" ${this.busy ? 'disabled' : ''}>
              <div class="gacha-dep__cell-thumb gacha-dep__thumb--${escapeHtml(it.rarity)}">${thumb}</div>
              <div class="gacha-dep__cell-name">${escapeHtml(it.name)}</div>
              <div class="gacha-dep__cell-sub">${escapeHtml(it.rarity.toUpperCase())} · ${escapeHtml(avail)}</div>
            </button>`)
        } else {
          const col = row as CreatorCollection
          const on =
            this.selectedCreatorCollection?.contractAddress === col.contractAddress
          const thumb = col.thumbnail
            ? `<img class="gacha-dep__cell-img" src="${escapeHtml(col.thumbnail)}" alt="" loading="lazy" />`
            : 'COL'
          parts.push(`
            <button type="button" class="gacha-dep__cell${on ? ' is-selected' : ''}" data-creator-col="${escapeHtml(col.contractAddress)}" ${this.busy ? 'disabled' : ''}>
              <div class="gacha-dep__cell-thumb gacha-dep__thumb--epic">${thumb}</div>
              <div class="gacha-dep__cell-name">${escapeHtml(col.name)}</div>
              <div class="gacha-dep__cell-sub">${col.size} item${col.size === 1 ? '' : 's'} · ${escapeHtml(shortAddr(col.contractAddress))}</div>
            </button>`)
        }
      }
      cells = parts.join('')
    }

    const invTitle = browsingItems
      ? `${this.selectedCreatorCollection?.name ?? 'Items'} · ${this.creatorItems.length}`
      : `Your collections · ${this.creatorCollections.length}`
    const upBtn = browsingItems
      ? `<button type="button" class="gacha-dep__page-btn" data-creator-up ${this.busy ? 'disabled' : ''} title="Back to collections">↑</button>`
      : ''

    return `
      <div class="gacha-dep gacha-dep--creator">
        <header class="gacha-dep__header">
          <button type="button" class="gacha-casino__btn gacha-casino__btn--ghost gacha-dep__back" data-dep-back ${this.busy ? 'disabled' : ''}>← Back</button>
          <div class="gacha-dep__header-stats">
            <span class="gacha-dep__stat gacha-dep__stat--ok">Wallet: ${escapeHtml(balLabel)} mMANA</span>
            <span class="gacha-dep__stat gacha-dep__stat--gold">Lock ~${escapeHtml(lockEst)} mMANA</span>
          </div>
        </header>
        ${tabs}
        <div class="gacha-dep__body">
          <aside class="gacha-dep__left">
            <h3 class="gacha-dep__section-title">To stock</h3>
            <div class="gacha-dep__list">${selBlock}</div>
          </aside>
          <section class="gacha-dep__right">
            <div class="gacha-dep__inv-head">
              <h3 class="gacha-dep__section-title">${escapeHtml(invTitle)}</h3>
              <div class="gacha-dep__pager">
                ${upBtn}
                <button type="button" class="gacha-dep__page-btn" data-creator-prev ${!canPrev || this.busy || this.creatorLoading ? 'disabled' : ''}>‹</button>
                <span class="gacha-dep__page-label">${this.creatorPage + 1} / ${totalPages}</span>
                <button type="button" class="gacha-dep__page-btn" data-creator-next ${!canNext || this.busy || this.creatorLoading ? 'disabled' : ''}>›</button>
              </div>
            </div>
            <div class="gacha-dep__grid">${cells}</div>
          </section>
        </div>
        <footer class="gacha-dep__footer">
          ${
            this.error || (this.status && this.mode === 'deposit')
              ? `<p class="gacha-dep__footer-hint">${escapeHtml(this.error || this.status)}</p>`
              : ''
          }
          <button type="button" class="gacha-casino__btn gacha-casino__btn--gold gacha-dep__confirm" data-stock-confirm ${this.busy || !this.stockItem ? 'disabled' : ''}>
            Stock into grab bag
          </button>
        </footer>
        <div class="gacha-casino__steps gacha-dep__steps" data-dep-steps ${this.steps.length && this.mode === 'deposit' ? '' : 'hidden'}></div>
      </div>`
  }

  private renderDepositView(): void {
    const balLabel = this.wallet ? formatMana(this.wallet.mana) : '—'
    const tabs = `
      <div class="gacha-dep__tabs" role="tablist">
        <button type="button" class="gacha-dep__tab${this.depositSource === 'wallet' ? ' is-active' : ''}" data-dep-source="wallet" ${this.busy ? 'disabled' : ''}>Your wallet</button>
        <button type="button" class="gacha-dep__tab${this.depositSource === 'creator' ? ' is-active' : ''}" data-dep-source="creator" ${this.busy ? 'disabled' : ''}>Creator collection</button>
      </div>`

    if (this.depositSource === 'creator') {
      this.depositBodyEl.innerHTML = this.renderCreatorDepositHtml(balLabel, tabs)
      const stepsHostC = this.depositBodyEl.querySelector('[data-dep-steps]') as HTMLElement | null
      if (stepsHostC && this.steps.length) {
        stepsHostC.hidden = false
        stepsHostC.innerHTML = this.stepsEl.innerHTML || this.buildStepsHtml()
      }
      return
    }

    const nftCount = this.inventory.filter((i) => i.kind === 'nft').length
    const invTotal = this.inventory.length
    const totalPages = Math.max(1, Math.ceil(invTotal / INV_PAGE_SIZE))
    if (this.invPage >= totalPages) this.invPage = totalPages - 1
    const start = this.invPage * INV_PAGE_SIZE
    const pageItems = this.inventory.slice(start, start + INV_PAGE_SIZE)
    const selectedIds = new Set(this.selections.map((s) => s.item.id))
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
        <div class="gacha-dep__stock-card gacha-dep__stock-card--pack" data-sel-id="${escapeHtml(sel.item.id)}">
          <button type="button" class="gacha-dep__stock-clear" data-remove="${escapeHtml(sel.item.id)}" aria-label="Remove" ${this.busy ? 'disabled' : ''}>×</button>
          <div class="gacha-dep__stock-top">
            <div class="gacha-dep__stock-thumb gacha-dep__thumb--pack">◈</div>
            <div class="gacha-dep__stock-meta">
              <div class="gacha-dep__stock-name">${escapeHtml(sel.item.name)}</div>
              <div class="gacha-dep__stock-tags">
                <span class="gacha-dep__pill gacha-dep__pill--legendary">pack</span>
                <span class="gacha-dep__pill">escrow</span>
              </div>
            </div>
          </div>
          <div class="gacha-dep__stock-fields">
            <label class="gacha-dep__stock-field">
              <span>Pack prize</span>
              <input type="text" inputmode="decimal" data-prize-id="${escapeHtml(sel.item.id)}" value="${escapeHtml(sel.packPrizeMana || DEFAULT_PACK_PRIZE)}" ${this.busy ? 'disabled' : ''} />
            </label>
            <label class="gacha-dep__stock-field">
              <span>Backing</span>
              <input type="text" inputmode="decimal" data-backing-id="${escapeHtml(sel.item.id)}" value="${escapeHtml(sel.backingMana)}" ${this.busy ? 'disabled' : ''} />
            </label>
          </div>
        </div>`
              }
              return `
        <div class="gacha-dep__stock-card gacha-dep__stock-card--nft" data-sel-id="${escapeHtml(sel.item.id)}">
          <button type="button" class="gacha-dep__stock-clear" data-remove="${escapeHtml(sel.item.id)}" aria-label="Remove" ${this.busy ? 'disabled' : ''}>×</button>
          <div class="gacha-dep__stock-top">
            <div class="gacha-dep__stock-thumb gacha-dep__thumb--${escapeHtml(sel.item.rarity)}">NFT</div>
            <div class="gacha-dep__stock-meta">
              <div class="gacha-dep__stock-name">${escapeHtml(sel.item.name)}</div>
              <div class="gacha-dep__stock-tags">
                <span class="gacha-dep__pill gacha-dep__pill--${escapeHtml(sel.item.rarity)}">${escapeHtml(sel.item.rarity)}</span>
                <span class="gacha-dep__pill">#${escapeHtml(sel.item.tokenId)}</span>
              </div>
            </div>
          </div>
          <div class="gacha-dep__stock-fields gacha-dep__stock-fields--single">
            <label class="gacha-dep__stock-field">
              <span>Backing</span>
              <input type="text" inputmode="decimal" data-backing-id="${escapeHtml(sel.item.id)}" value="${escapeHtml(sel.backingMana)}" ${this.busy ? 'disabled' : ''} />
            </label>
          </div>
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
        ${tabs}
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
          ${
            this.error || (this.status && this.mode === 'deposit')
              ? `<p class="gacha-dep__footer-hint">${escapeHtml(this.error || this.status)}</p>`
              : ''
          }
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
    const sourceBtn = t.closest('[data-dep-source]') as HTMLElement | null
    if (sourceBtn?.dataset.depSource === 'wallet' || sourceBtn?.dataset.depSource === 'creator') {
      if (this.busy) return
      this.depositSource = sourceBtn.dataset.depSource
      this.error = null
      if (this.depositSource === 'creator') void this.ensureCreatorCollectionsLoaded()
      this.renderDepositView()
      return
    }
    if (t.closest('[data-creator-up]')) {
      this.creatorBrowse = 'collections'
      this.selectedCreatorCollection = null
      this.creatorItems = []
      this.creatorPage = 0
      this.renderDepositView()
      return
    }
    if (t.closest('[data-creator-prev]')) {
      if (this.creatorPage > 0) {
        this.creatorPage -= 1
        this.renderDepositView()
      }
      return
    }
    if (t.closest('[data-creator-next]')) {
      const n =
        this.creatorBrowse === 'items' ? this.creatorItems.length : this.creatorCollections.length
      const totalPages = Math.max(1, Math.ceil(n / INV_PAGE_SIZE))
      if (this.creatorPage + 1 < totalPages) {
        this.creatorPage += 1
        this.renderDepositView()
      }
      return
    }
    const colBtn = t.closest('[data-creator-col]') as HTMLElement | null
    if (colBtn?.dataset.creatorCol) {
      void this.openCreatorCollection(colBtn.dataset.creatorCol)
      return
    }
    const itemBtn = t.closest('[data-creator-item]') as HTMLElement | null
    if (itemBtn?.dataset.creatorItem != null) {
      const id = Number(itemBtn.dataset.creatorItem)
      const it = this.creatorItems.find((x) => x.itemId === id)
      if (it) {
        this.stockItem = it
        this.renderDepositView()
      }
      return
    }
    if (t.closest('[data-stock-clear]')) {
      this.stockItem = null
      this.renderDepositView()
      return
    }
    if (t.closest('[data-stock-confirm]')) {
      void this.confirmStockFromCollection()
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
    if ('stockCount' in input.dataset) {
      this.stockMintCount = input.value
      this.updateCreatorLockStat()
      return
    }
    if ('stockBacking' in input.dataset) {
      this.stockAvgBacking = input.value
      this.updateCreatorLockStat()
      return
    }
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

  private updateCreatorLockStat(): void {
    const gold = this.depositBodyEl.querySelector('.gacha-dep__stat--gold')
    if (!gold) return
    const c = Math.max(0, Math.floor(Number(this.stockMintCount) || 0))
    const a = Number(this.stockAvgBacking) || 0
    gold.textContent = `Lock ~${formatManaDisplay(c * a)} mMANA`
  }

  private async ensureCreatorCollectionsLoaded(): Promise<void> {
    const addr = this.addr()
    if (!addr) {
      this.creatorLoadError = 'Connect a wallet'
      this.creatorCollections = []
      this.renderDepositView()
      return
    }
    if (this.creatorLoading) return
    this.creatorAbort?.abort()
    this.creatorAbort = new AbortController()
    this.creatorLoading = true
    this.creatorLoadError = null
    this.creatorBrowse = 'collections'
    this.selectedCreatorCollection = null
    this.creatorItems = []
    this.creatorPage = 0
    this.renderDepositView()
    try {
      this.creatorCollections = await fetchCreatorCollections(addr, {
        signal: this.creatorAbort.signal
      })
    } catch (e) {
      if ((e as Error)?.name === 'AbortError') return
      this.creatorLoadError = e instanceof Error ? e.message : String(e)
      this.creatorCollections = []
    } finally {
      this.creatorLoading = false
      if (this.mode === 'deposit' && this.depositSource === 'creator') this.renderDepositView()
    }
  }

  private async openCreatorCollection(contractAddress: string): Promise<void> {
    if (this.busy) return
    const col =
      this.creatorCollections.find(
        (c) => c.contractAddress.toLowerCase() === contractAddress.toLowerCase()
      ) ?? null
    if (!col) return
    this.selectedCreatorCollection = col
    this.creatorBrowse = 'items'
    this.creatorPage = 0
    this.creatorItems = []
    this.creatorLoading = true
    this.creatorLoadError = null
    this.renderDepositView()
    this.creatorAbort?.abort()
    this.creatorAbort = new AbortController()
    try {
      this.creatorItems = await fetchCollectionItems(col.contractAddress, {
        signal: this.creatorAbort.signal
      })
    } catch (e) {
      if ((e as Error)?.name === 'AbortError') return
      this.creatorLoadError = e instanceof Error ? e.message : String(e)
      this.creatorItems = []
    } finally {
      this.creatorLoading = false
      if (this.mode === 'deposit' && this.depositSource === 'creator') this.renderDepositView()
    }
  }

  private async confirmStockFromCollection(): Promise<void> {
    if (this.busy) return
    if (!this.addr()) {
      this.error = 'Connect a wallet to stock'
      this.renderDepositView()
      return
    }
    const item = this.stockItem
    if (!item) {
      this.error = 'Select an item from the grid'
      this.renderDepositView()
      return
    }
    const mintCount = Math.floor(Number(this.stockMintCount))
    if (!Number.isFinite(mintCount) || mintCount < 1) {
      this.error = 'Mint count must be at least 1'
      this.renderDepositView()
      return
    }
    const avg = Number(this.stockAvgBacking)
    if (!Number.isFinite(avg) || avg <= 0) {
      this.error = 'Avg backing must be greater than 0'
      this.renderDepositView()
      return
    }

    this.setBusy(true)
    this.error = null
    this.steps = []
    this.stepSeq = 0
    this.status = `Stocking ${mintCount}× ${item.name}…`
    this.renderDepositView()
    try {
      await runStockFromCollection({
        sessionAddress: this.addr(),
        collection: item.contractAddress,
        itemId: item.itemId,
        mintCount,
        avgBackingMana: this.stockAvgBacking,
        api: this.flowApi(),
        waitForContinue: async ({ label }) => {
          await requestGachaSignContinue({
            title: 'Stock into grab bag',
            status: label,
            steps: this.steps,
            buttonLabel: 'Continue'
          })
        }
      })
      this.steps = []
      hideGachaSignOverlay()
      this.stockItem = null
      await this.refresh()
      this.setBusy(false)
      await showGachaSuccessOverlay({
        title: 'Stocked!',
        message: `${mintCount} item${mintCount === 1 ? '' : 's'} added to the grab bag.`,
        detail: item.name,
        buttonLabel: 'Back to grab bag'
      })
      this.setMode('play')
      this.status = `Stocked ${mintCount} into grab bag`
      this.renderStatus()
    } catch (e) {
      this.error = humanizeStockError(e)
      // Keep deposit + overlay with failed step; do not bounce to main
      this.renderDepositView()
      this.renderSteps()
      this.setBusy(false)
      if (this.mode === 'deposit') this.renderDepositView()
      return
    }
    this.setBusy(false)
    if (this.mode === 'deposit') this.renderDepositView()
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
    // Centered viewport overlay for sign / meta-tx (2D + 3D).
    if (this.steps.length > 0) {
      const active = this.steps.find((s) => s.status === 'active')
      const title =
        this.mode === 'deposit'
          ? this.depositSource === 'creator'
            ? 'Stock into grab bag'
            : 'Deposit to grab bag'
          : this.claiming
            ? 'Claim from grab bag'
            : 'Grab bag transaction'
      const statusLine =
        active != null
          ? 'Confirm in your wallet…'
          : this.status?.trim() || 'Working…'
      syncGachaSignOverlay({
        title,
        status: statusLine,
        steps: this.steps
      })
    } else {
      hideGachaSignOverlay()
    }

    if (!this.steps.length) {
      this.stepsEl.hidden = true
      this.stepsEl.innerHTML = ''
      // Hide inline deposit step hosts — overlay owns progress now.
      const host = this.depositBodyEl.querySelector('[data-dep-steps]') as HTMLElement | null
      if (host) {
        host.hidden = true
        host.innerHTML = ''
      }
      return
    }
    // Keep play-mode inline list as secondary; deposit uses overlay only.
    this.stepsEl.hidden = this.mode !== 'play'
    this.stepsEl.innerHTML = this.buildStepsHtml()
    if (this.mode === 'deposit') {
      const host = this.depositBodyEl.querySelector('[data-dep-steps]') as HTMLElement | null
      if (host) {
        host.hidden = true
        host.innerHTML = ''
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
        <div class="gacha-casino__win-title">Selected from grab bag</div>
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
      this.error = 'Empty grab bag — deposit first'
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
      this.marqueeEl.textContent = win ? 'Claim ready to settle' : 'Grab bag'
      this.status = win ? `Grab bag selected position #${win.positionId}` : 'Claim confirmed'
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
      this.marqueeEl.textContent = 'Grab bag'
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
      this.marqueeEl.textContent = 'Grab bag'
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
