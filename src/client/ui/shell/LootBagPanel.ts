import type { SessionIdentity } from '../../../network/SessionIdentity'
import {
  ADDRESSES,
  computeClaimChanceLabels,
  formatIssueLabel,
  formatMana,
  takeTokensNetWei,
  shortAddr,
  escapeHtml,
  fetchPoolSnapshot,
  fetchWalletSnapshot,
  fetchCreatorCollections,
  fetchCollectionItems,
  findPendingWinForPurchaser,
  resolveIssuedId,
  runDepositManaPack,
  runDepositNft,
  runStockFromCollection,
  runPull,
  runSettle,
  runWithdrawRewards,
  getCollectionMinterStatus,
  humanizeStockError,
  hideLootBagSignOverlay,
  requestLootBagSignContinue,
  showLootBagSuccessOverlay,
  syncLootBagSignOverlay,
  type CreatorCollection,
  type CreatorCollectionItem,
  type FlowApi,
  type LootBagPosition,
  type PendingWin,
  lootBagClaimingBlocked,
  lootBagClaimingBlockedReason,
  type PoolSnapshot,
  type TxStep,
  type WalletSnapshot
} from '../../../lootBag'
import { publishPoolClaim } from '../../../social/publishPoolClaim'

export type LootBagPanelOptions = {
  getSession: () => SessionIdentity
  onClose?: () => void
}

type PanelMode = 'main' | 'deposit'
/** Wallet inventory deposit vs creator Collection V2 stock */
type DepositSource = 'wallet' | 'creator'

/** Deposit inventory grid — denser page so wallets with many wearables feel complete */
const INV_PAGE_SIZE = 18
const DEFAULT_BACKING = '10'
const DEFAULT_PACK_PRIZE = '5'
const DEFAULT_STOCK_COUNT = '5'
const MANA_PACK_INV_ID = 'mana-pack'

/** sessionStorage — survive refresh between pull and Keep/Take (same as 2D). */
function pendingWinStorageKey(addr: string): string {
  return `lootbag.pendingWin.${addr.toLowerCase()}`
}

function readStoredPendingPositionId(addr: string | undefined): number | null {
  if (!addr || typeof sessionStorage === 'undefined') return null
  try {
    const raw = sessionStorage.getItem(pendingWinStorageKey(addr))
    if (!raw) return null
    const n = Number(raw)
    return Number.isFinite(n) && n >= 1 ? n : null
  } catch {
    return null
  }
}

function writeStoredPendingPositionId(addr: string | undefined, positionId: number): void {
  if (!addr || typeof sessionStorage === 'undefined') return
  try {
    sessionStorage.setItem(pendingWinStorageKey(addr), String(positionId))
  } catch {
    /* quota / private mode */
  }
}

function clearStoredPendingPositionId(addr: string | undefined): void {
  if (!addr || typeof sessionStorage === 'undefined') return
  try {
    sessionStorage.removeItem(pendingWinStorageKey(addr))
  } catch {
    /* ignore */
  }
}

function mergeWinPosition(
  fromChain: LootBagPosition | null,
  fromShelf: LootBagPosition | null
): LootBagPosition | null {
  if (!fromChain && !fromShelf) return null
  const base = fromChain ?? fromShelf!
  if (!fromShelf) {
    const issue = resolveIssuedId(base.tokenId, {
      collection: base.collection,
      knownIssuedId: base.issuedId
    })
    return issue != null ? { ...base, issuedId: issue } : base
  }
  const issuedId =
    resolveIssuedId(base.tokenId, {
      collection: base.collection,
      knownIssuedId: base.issuedId ?? fromShelf.issuedId
    }) ?? undefined
  return {
    ...base,
    name: base.name?.trim() || fromShelf.name,
    rarity: base.rarity || fromShelf.rarity,
    imageUrl: base.imageUrl || fromShelf.imageUrl,
    itemId: base.itemId ?? fromShelf.itemId,
    issuedId
  }
}

type InvKind = 'nft' | 'pack'

type InvItem = {
  id: string
  kind: InvKind
  tokenId: string
  name: string
  rarity: string
  collection: string
  imageUrl?: string
  issuedId?: string
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

function invIssueLabel(item: { tokenId: string; collection: string; issuedId?: string }): string {
  return formatIssueLabel(item.tokenId, {
    collection: item.collection,
    knownIssuedId: item.issuedId
  })
}

function posIssueLabel(p: LootBagPosition): string {
  return formatIssueLabel(p.tokenId, {
    collection: p.collection,
    knownIssuedId: p.issuedId
  })
}

function walletNftsToInventory(
  nfts: { id: string; collection: string; tokenId: string; name: string; rarity: string; imageUrl?: string; issuedId?: string }[]
): InvItem[] {
  const items: InvItem[] = nfts.map((n) => ({
    id: n.id,
    kind: 'nft' as const,
    tokenId: n.tokenId,
    name: n.name,
    rarity: n.rarity || 'common',
    collection: n.collection,
    imageUrl: n.imageUrl,
    issuedId:
      resolveIssuedId(n.tokenId, { collection: n.collection, knownIssuedId: n.issuedId }) ??
      undefined
  }))
  // A–Z by name (pack stays pinned first in filterInv)
  items.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
  return [manaPackInvItem(), ...items]
}

/** Filter + A–Z inventory; MANA pack stays first when it matches. */
function filterInv(items: InvItem[], query: string): InvItem[] {
  const q = query.trim().toLowerCase()
  const pack = items.find((i) => i.kind === 'pack')
  let nfts = items.filter((i) => i.kind === 'nft')
  if (q) {
    nfts = nfts.filter((i) => {
      const hay = [i.name, i.rarity, i.tokenId, i.issuedId ?? '', i.collection, i.id]
        .join(' ')
        .toLowerCase()
      return hay.includes(q)
    })
  }
  nfts.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
  const showPack =
    !!pack &&
    (!q || pack.name.toLowerCase().includes(q) || q === 'pack' || q.includes('mana'))
  return showPack && pack ? [pack, ...nfts] : nfts
}

/** Centered loading status while pool snapshot loads (no skeleton cards). */
function shelfLoadingHtml(label: string): string {
  return `
    <div class="lootbag-shelf-skel lootbag-shelf-skel--panel lootbag-shelf-skel--text-only" role="status" aria-live="polite" aria-busy="true">
      <div class="lootbag-shelf-skel__footer">
        <span class="lootbag-shelf-skel__spin" aria-hidden="true"></span>
        <p class="lootbag-shelf-skel__label">${escapeHtml(label)}</p>
      </div>
    </div>`
}

/**
 * Left HUD Loot Bag — ~2× chat width.
 * Main: glass display shelf · Deposit: 1/3 + 2/3 inventory · Win: center modal.
 */
export class LootBagPanel {
  readonly element: HTMLDivElement
  private readonly winModal: HTMLDivElement
  private visible = false
  private busy = false
  private mode: PanelMode = 'main'
  private depositSource: DepositSource = 'wallet'
  private pool: PoolSnapshot | null = null
  private wallet: WalletSnapshot | null = null
  private inventory: InvItem[] = []
  private selections: DepositSelection[] = []
  private invPage = 0
  /** Wallet inventory search (name / rarity / issue / collection) */
  private invSearch = ''
  /** Creator stock (Collection V2 → Loot Bag) — grid browse + stock selection */
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
  /** Take MANA NFT return / Keep fee credits — prefer collection creator */
  private stockDepositor = ''
  private creatorAbort: AbortController | null = null
  private steps: TxStep[] = []
  private status = ''
  private error: string | null = null
  private pendingWin: PendingWin | null = null
  private stepSeq = 0
  private claiming = false

  private readonly titleEl: HTMLElement
  private readonly feeEl: HTMLElement
  private readonly balanceEl: HTMLElement
  private readonly headerDepositEl: HTMLElement
  private readonly bodyEl: HTMLElement
  private readonly statusEl: HTMLElement
  private readonly stepsEl: HTMLElement
  private readonly footerEl: HTMLElement
  private readonly onKeyDown: (ev: KeyboardEvent) => void

  constructor(private readonly options: LootBagPanelOptions) {
    this.element = document.createElement('div')
    this.element.id = 'lootbag-panel-wrap'
    this.element.className = 'lootbag-panel-wrap lootbag-panel-wrap--dock'
    this.element.hidden = true
    this.element.setAttribute('role', 'dialog')
    this.element.setAttribute('aria-label', 'Loot Bag')
    this.element.innerHTML = `
      <div class="lootbag-panel lootbag-panel--dock">
        <div class="lootbag-panel__dock" data-dock>
          <section class="lootbag-panel__bag" aria-label="Loot Bag">
            <header class="lootbag-panel__header">
              <div class="lootbag-panel__header-main">
                <h2 class="lootbag-panel__title" data-title>Loot Bag</h2>
                <div class="lootbag-panel__stats" data-stats>
                  <span class="lootbag-panel__stat" data-fee title="Loot Pack claim cost">Pack cost —</span>
                  <span class="lootbag-panel__stat-sep" aria-hidden="true">|</span>
                  <span class="lootbag-panel__stat lootbag-panel__stat--mana" data-balance title="Your mMANA balance">Balance —</span>
                </div>
                <div class="lootbag-panel__header-deposit" data-header-deposit hidden></div>
              </div>
              <div class="lootbag-panel__header-actions">
                <button type="button" class="lootbag-panel__btn lootbag-panel__btn--secondary lootbag-panel__btn--sm" data-deposit>Add Loot</button>
                <button type="button" class="lootbag-panel__icon-btn" data-refresh title="Refresh" aria-label="Refresh">↻</button>
                <button type="button" class="lootbag-panel__close" data-close aria-label="Close">×</button>
              </div>
            </header>
            <div class="lootbag-panel__body" data-body></div>
            <div class="lootbag-panel__steps" data-steps hidden></div>
            <p class="lootbag-panel__status" data-status hidden></p>
          </section>
          <div class="lootbag-panel__dock-gap" aria-hidden="true"></div>
          <aside class="lootbag-panel__pack" data-pack-col aria-label="Loot Pack">
            <div class="lootbag-panel__pack-frame">
              <img
                class="lootbag-panel__pack-art"
                src="/media/lootbag/lootpack.png?v=5"
                alt="Loot Pack"
                width="512"
                height="768"
                decoding="async"
              />
            </div>
            <button type="button" class="lootbag-panel__btn lootbag-panel__btn--primary lootbag-panel__pack-claim" data-claim>
              Claim Loot Pack
            </button>
          </aside>
        </div>
        <footer class="lootbag-panel__footer" data-footer hidden></footer>
      </div>
    `

    this.winModal = document.createElement('div')
    this.winModal.id = 'lootbag-win-modal'
    this.winModal.className = 'lootbag-win-modal'
    this.winModal.hidden = true
    this.winModal.setAttribute('role', 'dialog')
    this.winModal.setAttribute('aria-modal', 'true')
    this.winModal.setAttribute('aria-label', 'Loot Bag claim result')
    this.winModal.innerHTML = `
      <div class="lootbag-win-modal__backdrop" data-win-backdrop></div>
      <div class="lootbag-win-modal__card" data-win-card></div>
    `

    this.titleEl = this.element.querySelector('[data-title]')!
    this.feeEl = this.element.querySelector('[data-fee]')!
    this.balanceEl = this.element.querySelector('[data-balance]')!
    this.headerDepositEl = this.element.querySelector('[data-header-deposit]')!
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
    // Deposit toolbar lives in the outer header (same row as title)
    this.headerDepositEl.addEventListener('click', (ev) => void this.onBodyClick(ev))
    this.headerDepositEl.addEventListener('input', (ev) => this.onBodyInput(ev))
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
    this.renderShelfLoading()
    await this.refresh()
    // Reopen Keep/Take if chain still holds an unsettled prize
    await this.restorePendingWinIfAny()
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
   * Always land on main Loot Bag shelf when reopening — clear deposit state, win modal, etc.
   */
  private resetToMainMenu(): void {
    this.mode = 'main'
    this.selections = []
    this.invPage = 0
    this.invSearch = ''
    // Keep pendingWin until settle — restorePendingWinIfAny reopens modal after refresh
    this.steps = []
    this.stepSeq = 0
    this.error = null
    this.status = ''
    this.busy = false
    this.claiming = false
    this.element.classList.remove('is-deposit-mode', 'is-busy')
    this.footerEl.hidden = true
    const packCol = this.element.querySelector('[data-pack-col]') as HTMLElement | null
    if (packCol) packCol.hidden = false
    const gap = this.element.querySelector('.lootbag-panel__dock-gap') as HTMLElement | null
    if (gap) gap.hidden = false
    this.titleEl.textContent = 'Loot Bag'
    this.closeWinModal({ clearPending: false })
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
          const nextStatus = patch?.error
            ? ('error' as const)
            : patch?.keepActive
              ? ('active' as const)
              : ('done' as const)
          return {
            ...s,
            status: nextStatus,
            hash: patch?.hash ?? s.hash,
            detail: patch?.detail ?? s.detail
          }
        })
        this.renderSteps()
      }
    }
  }

  private dismissSignOverlay(): void {
    this.steps = []
    hideLootBagSignOverlay()
    this.stepsEl.hidden = true
    this.stepsEl.innerHTML = ''
  }

  private setBusy(on: boolean): void {
    this.busy = on
    this.footerEl.querySelectorAll('button').forEach((b) => {
      ;(b as HTMLButtonElement).disabled = on
    })
    this.syncClaimButton()
    this.element.classList.toggle('is-busy', on)
    if (!on) {
      const inFlight = this.steps.some((s) => s.status === 'active' || s.status === 'error')
      if (!inFlight) this.dismissSignOverlay()
    }
    // Keep settle buttons in sync (modal HTML is static after open)
    this.winModal.querySelectorAll<HTMLButtonElement>('[data-settle-keep], [data-settle-take]').forEach((b) => {
      b.disabled = on
    })
    if (this.mode === 'deposit') this.renderDepositBody()
  }

  private syncInventory(): void {
    this.inventory = walletNftsToInventory(this.wallet?.ownedNfts ?? [])
  }

  private isPackSel(s: DepositSelection): boolean {
    return s.item.kind === 'pack'
  }

  /** Mana + NFT/pack totals the user will send with this deposit. */
  private depositSendTotals(): { mana: number; nfts: number; packs: number } {
    let mana = 0
    let nfts = 0
    let packs = 0
    for (const s of this.selections) {
      const back = Number(s.backingMana)
      if (Number.isFinite(back) && back > 0) mana += back
      if (this.isPackSel(s)) {
        packs++
        const prize = Number(s.packPrizeMana || '0')
        if (Number.isFinite(prize) && prize > 0) mana += prize
      } else {
        nfts++
      }
    }
    return { mana, nfts, packs }
  }

  private depositSendSummaryText(): string {
    if (this.selections.length === 0) return 'Nothing selected'
    const { mana, nfts, packs } = this.depositSendTotals()
    const manaLabel = Number.isFinite(mana)
      ? mana.toLocaleString(undefined, { maximumFractionDigits: 2 })
      : '0'
    const parts: string[] = [`${manaLabel} mMANA`]
    if (nfts) parts.push(`${nfts} NFT${nfts === 1 ? '' : 's'}`)
    if (packs) parts.push(`${packs} pack${packs === 1 ? '' : 's'}`)
    return parts.join(' · ')
  }

  private refreshDepositSendSummary(): void {
    const el = this.bodyEl.querySelector('[data-dep-send-summary]')
    if (el) el.textContent = this.depositSendSummaryText()
  }

  async refresh(): Promise<void> {
    this.error = null
    if (this.mode === 'main') {
      this.status = ''
      this.renderStatus()
      this.renderShelfLoading()
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
          ? lootBagClaimingBlockedReason(this.pool) || ''
          : 'Empty Loot Bag — deposit a wearable or MANA pack'
        this.renderStatus()
      }
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e)
      this.bodyEl.innerHTML = `<p class="lootbag-panel__error">${escapeHtml(this.error)}</p>`
      this.status = ''
      this.renderStatus()
    }
  }

  /** Pack claim cost + wallet balance for header / claim modals. */
  private manaCostBalance(): { feeLabel: string; balLabel: string; summary: string } {
    const fee = this.pool ? formatMana(this.pool.acquisitionFee) : '—'
    const bal = this.wallet ? formatMana(this.wallet.mana) : '—'
    const feeLabel = `Pack cost ${fee} mMANA`
    const balLabel = `Balance ${bal}`
    return { feeLabel, balLabel, summary: `${feeLabel} | ${balLabel}` }
  }

  private renderHeader(): void {
    const { feeLabel, balLabel } = this.manaCostBalance()
    this.feeEl.textContent = feeLabel
    this.balanceEl.textContent = balLabel
    this.syncClaimButton()
  }

  private syncClaimButton(): void {
    const btn = this.element.querySelector('[data-claim]') as HTMLButtonElement | null
    if (!btn) return
    const blocked = lootBagClaimingBlocked(this.pool)
    btn.disabled = this.busy || this.claiming || blocked
    btn.textContent = this.pool?.paused
      ? 'Loot Bag paused'
      : this.pool?.claimsPaused
        ? 'Claiming paused'
        : 'Claim Loot Pack'
    btn.title = lootBagClaimingBlockedReason(this.pool) ?? 'Claim a Loot Pack'
  }

  private setMode(mode: PanelMode): void {
    this.mode = mode
    this.element.classList.toggle('is-deposit-mode', mode === 'deposit')
    // Pack column only on main play dock
    const packCol = this.element.querySelector('[data-pack-col]') as HTMLElement | null
    if (packCol) packCol.hidden = mode === 'deposit'
    const gap = this.element.querySelector('.lootbag-panel__dock-gap') as HTMLElement | null
    if (gap) gap.hidden = mode === 'deposit'
    // Outer header: bag stats + Add Loot on main; deposit toolbar on title row while depositing
    const stats = this.element.querySelector('.lootbag-panel__stats') as HTMLElement | null
    if (stats) stats.hidden = mode === 'deposit'
    const depositBtn = this.element.querySelector('[data-deposit]') as HTMLElement | null
    if (depositBtn) depositBtn.hidden = mode === 'deposit'
    this.headerDepositEl.hidden = mode !== 'deposit'
    if (mode !== 'deposit') this.headerDepositEl.innerHTML = ''
    this.footerEl.hidden = true
    if (mode === 'deposit') {
      this.titleEl.textContent = 'Add Loot'
      this.closeWinModal({ clearPending: false })
      this.renderDepositBody()
    } else {
      this.titleEl.textContent = 'Loot Bag'
      if (stats) stats.hidden = false
      if (depositBtn) depositBtn.hidden = false
      this.renderMainBody()
    }
  }

  /** Deposit controls on the same row as the "Add Loot" title (search/pager optional). */
  private renderHeaderDepositToolbar(opts: {
    balLabel: string
    tabs: string
    searchHtml?: string
    pagerHtml?: string
  }): void {
    this.headerDepositEl.hidden = false
    this.headerDepositEl.innerHTML = `
      <div class="lootbag-dep__toolbar">
        <div class="lootbag-dep__toolbar-left">
          <button type="button" class="lootbag-panel__btn lootbag-panel__btn--secondary lootbag-panel__btn--sm lootbag-dep__back" data-dep-back ${this.busy ? 'disabled' : ''}>← Back</button>
          ${opts.tabs}
        </div>
        ${
          opts.searchHtml || opts.pagerHtml
            ? `<div class="lootbag-dep__toolbar-tools">
                ${opts.searchHtml || ''}
                ${opts.pagerHtml || ''}
              </div>`
            : ''
        }
        <div class="lootbag-dep__toolbar-center">
          <span class="lootbag-dep__stat lootbag-dep__stat--ok">${escapeHtml(opts.balLabel)} mMANA</span>
        </div>
      </div>`
  }

  private openDeposit(): void {
    if (this.busy) return
    if (!this.sessionAddress()) {
      this.error = 'Connect a wallet to deposit'
      this.renderStatus()
      return
    }
    this.error = null
    this.depositSource = 'wallet'
    this.invPage = 0
    this.invSearch = ''
    this.setMode('deposit')
    // Re-fetch wallet NFTs when opening Add Loot (stale snapshot was dropping items)
    void this.refreshWalletInventoryForDeposit()
  }

  /** Pull full Catalyst + mock inventory before showing deposit grid. */
  private async refreshWalletInventoryForDeposit(): Promise<void> {
    const addr = this.sessionAddress()
    if (!addr || !/^0x[a-fA-F0-9]{40}$/.test(addr)) return
    this.bodyEl.innerHTML = shelfLoadingHtml('Loading your wearables…')
    try {
      this.wallet = await fetchWalletSnapshot(addr as `0x${string}`)
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e)
    }
    this.syncInventory()
    const owned = new Set(this.inventory.map((i) => i.id))
    this.selections = this.selections.filter((s) => owned.has(s.item.id))
    this.renderHeader()
    if (this.mode === 'deposit') this.renderDepositBody()
    if (this.error) this.renderStatus()
  }

  private closeDeposit(): void {
    if (this.busy) return
    this.setMode('main')
    this.renderStatus()
  }

  private renderShelfLoading(): void {
    this.bodyEl.innerHTML = shelfLoadingHtml('Opening the Loot Bag…')
  }

  private renderMainBody(): void {
    const positions = this.pool?.positions ?? []
    if (!positions.length) {
      this.bodyEl.innerHTML = `
        <div class="lootbag-panel__row-empty">
          <p>Loot Bag is empty</p>
          <p class="lootbag-panel__muted">Add loot to fill the bag</p>
        </div>`
      return
    }

    // positions are oldest → newest; new deposits sit at the end
    const chances = computeClaimChanceLabels(positions)
    const cards = positions
      .map((p) => this.shelfCardHtml(p, chances.get(p.positionId) ?? '—'))
      .join('')
    this.bodyEl.innerHTML = `
      <div class="lootbag-panel__row-shelf" data-shelf>
        <div class="lootbag-panel__row-track">${cards}</div>
      </div>
    `
    requestAnimationFrame(() => {
      const shelf = this.bodyEl.querySelector('[data-shelf]') as HTMLElement | null
      if (shelf) shelf.scrollTo({ left: shelf.scrollWidth, behavior: 'smooth' })
    })
  }

  private shelfCardHtml(p: LootBagPosition, chanceLabel: string): string {
    const isPack = p.kind === 'manaPack'
    const rarity = isPack ? 'legendary' : (p.rarity || 'common').toLowerCase()
    const issueLabel = posIssueLabel(p)
    const title = isPack
      ? 'MANA Pack'
      : p.name?.trim()
        ? escapeHtml(p.name.trim())
        : escapeHtml(issueLabel)
    // Same line stack as wearables: title → detail → rarity → backed by → chance
    const detail = isPack
      ? `Prize ${formatMana(p.packMana)} mMANA`
      : escapeHtml(issueLabel)
    // Wearables with a real name show issue under title; title-only issue tokens skip the duplicate
    const detailHtml = isPack || p.name?.trim()
      ? `<div class="lootbag-panel__card-line">${detail}</div>`
      : ''
    const rarityLabel = isPack ? 'pack' : escapeHtml(rarity)
    const backing = `Backed by ${formatMana(p.backing)} mMANA`
    const chance = chanceLabel === '—' ? '— chance' : `${escapeHtml(chanceLabel)} chance`
    const img = p.imageUrl
      ? `<img class="lootbag-panel__card-img" src="${escapeHtml(p.imageUrl)}" alt="" loading="lazy" decoding="async" />`
      : `<div class="lootbag-panel__card-placeholder" aria-hidden="true">${isPack ? '◈' : '✦'}</div>`
    return `
      <article class="lootbag-panel__card${isPack ? ' is-pack' : ''} lootbag-rarity--${escapeHtml(rarity)}" data-pos="${p.positionId}" data-rarity="${escapeHtml(rarity)}">
        <div class="lootbag-panel__card-media lootbag-rarity-bg--${escapeHtml(rarity)}">${img}</div>
        <div class="lootbag-panel__card-line lootbag-panel__card-line--title" title="${title}">${title}</div>
        ${detailHtml}
        <div class="lootbag-panel__card-line lootbag-panel__card-line--rarity is-${escapeHtml(rarity)}">${rarityLabel}</div>
        <div class="lootbag-panel__card-line">${backing}</div>
        <div class="lootbag-panel__card-line lootbag-panel__card-line--chance">${chance}</div>
      </article>`
  }

  private renderCreatorDepositHtml(balLabel: string, tabs: string): string {
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
      ? `<p class="lootbag-dep__empty">Pick a collection, then an item →</p>`
      : `
        <div class="lootbag-dep__stock-card">
          <button type="button" class="lootbag-dep__stock-clear" data-stock-clear aria-label="Clear selection" ${this.busy ? 'disabled' : ''}>×</button>
          <div class="lootbag-dep__stock-top">
            <div class="lootbag-dep__stock-thumb lootbag-dep__thumb--${escapeHtml(this.stockItem.rarity)}">
              ${
                this.stockItem.thumbnail
                  ? `<img src="${escapeHtml(this.stockItem.thumbnail)}" alt="" loading="lazy" />`
                  : 'NFT'
              }
            </div>
            <div class="lootbag-dep__stock-meta">
              <div class="lootbag-dep__stock-name" title="${escapeHtml(this.stockItem.name)}">${escapeHtml(this.stockItem.name)}</div>
              <div class="lootbag-dep__stock-tags">
                <span class="lootbag-dep__pill lootbag-dep__pill--${escapeHtml(this.stockItem.rarity)}">${escapeHtml(this.stockItem.rarity)}</span>
                <span class="lootbag-dep__pill">item ${this.stockItem.itemId}</span>
              </div>
              <div class="lootbag-dep__stock-addr" title="${escapeHtml(this.stockItem.contractAddress)}">${escapeHtml(shortAddr(this.stockItem.contractAddress))}</div>
            </div>
          </div>
          <div class="lootbag-dep__stock-fields">
            <label class="lootbag-dep__stock-field">
              <span>Mint count</span>
              <input type="text" inputmode="numeric" data-stock-count value="${escapeHtml(this.stockMintCount)}" ${this.busy ? 'disabled' : ''} />
            </label>
            <label class="lootbag-dep__stock-field">
              <span>Avg backing</span>
              <input type="text" inputmode="decimal" data-stock-backing value="${escapeHtml(this.stockAvgBacking)}" ${this.busy ? 'disabled' : ''} />
            </label>
          </div>
          <div class="lootbag-dep__stock-fields lootbag-dep__stock-fields--depositor">
            <label class="lootbag-dep__stock-field lootbag-dep__stock-field--depositor">
              <span>Depositor wallet</span>
              <input type="text" data-stock-depositor value="${escapeHtml(this.stockDepositor)}" placeholder="0x… (Take MANA returns here)" ${this.busy ? 'disabled' : ''} autocomplete="off" spellcheck="false" />
            </label>
            <p class="lootbag-dep__stock-hint">Who receives the NFT if a claimer Takes MANA (and Keep fee credits). Defaults to collection creator. You still pay the mMANA backing.</p>
          </div>
        </div>`

    let cells = ''
    if (this.creatorLoading) {
      cells = `<div class="lootbag-dep__empty lootbag-dep__empty--center">Loading…</div>`
    } else if (this.creatorLoadError) {
      cells = `<div class="lootbag-dep__empty lootbag-dep__empty--center">${escapeHtml(this.creatorLoadError)}</div>`
    } else if (gridList.length === 0) {
      cells = browsingItems
        ? `<div class="lootbag-dep__empty lootbag-dep__empty--center">No items in this collection</div>`
        : `<div class="lootbag-dep__empty lootbag-dep__empty--center">No Polygon collections for this wallet (marketplace index)</div>`
    } else {
      const parts: string[] = []
      for (let i = 0; i < pageSize; i++) {
        const row = pageSlice[i]
        if (!row) {
          parts.push(`<div class="lootbag-panel__card lootbag-panel__card--empty" aria-hidden="true"></div>`)
          continue
        }
        if (browsingItems) {
          const it = row as CreatorCollectionItem
          const on =
            this.stockItem?.contractAddress === it.contractAddress &&
            this.stockItem?.itemId === it.itemId
          const rarity = (it.rarity || 'common').toLowerCase()
          const avail =
            it.available != null ? `${it.available} left` : `Item #${it.itemId}`
          const media = it.thumbnail
            ? `<img class="lootbag-panel__card-img" src="${escapeHtml(it.thumbnail)}" alt="" loading="lazy" decoding="async" />`
            : `<div class="lootbag-panel__card-placeholder" aria-hidden="true">✦</div>`
          parts.push(`
            <button type="button" class="lootbag-panel__card lootbag-dep__pick${on ? ' is-selected' : ''} lootbag-rarity--${escapeHtml(rarity)}" data-creator-item="${it.itemId}" ${this.busy ? 'disabled' : ''}>
              <div class="lootbag-panel__card-media lootbag-rarity-bg--${escapeHtml(rarity)}">${media}</div>
              <div class="lootbag-panel__card-line lootbag-panel__card-line--title" title="${escapeHtml(it.name)}">${escapeHtml(it.name)}</div>
              <div class="lootbag-panel__card-line">${escapeHtml(avail)}</div>
              <div class="lootbag-panel__card-line lootbag-panel__card-line--rarity is-${escapeHtml(rarity)}">${escapeHtml(rarity)}</div>
            </button>`)
        } else {
          const col = row as CreatorCollection
          const on =
            this.selectedCreatorCollection?.contractAddress === col.contractAddress
          const media = col.thumbnail
            ? `<img class="lootbag-panel__card-img" src="${escapeHtml(col.thumbnail)}" alt="" loading="lazy" decoding="async" />`
            : `<div class="lootbag-panel__card-placeholder" aria-hidden="true">COL</div>`
          parts.push(`
            <button type="button" class="lootbag-panel__card lootbag-dep__pick${on ? ' is-selected' : ''} lootbag-rarity--epic" data-creator-col="${escapeHtml(col.contractAddress)}" ${this.busy ? 'disabled' : ''}>
              <div class="lootbag-panel__card-media lootbag-rarity-bg--epic">${media}</div>
              <div class="lootbag-panel__card-line lootbag-panel__card-line--title" title="${escapeHtml(col.name)}">${escapeHtml(col.name)}</div>
              <div class="lootbag-panel__card-line">${col.size} item${col.size === 1 ? '' : 's'}</div>
              <div class="lootbag-panel__card-line">${escapeHtml(shortAddr(col.contractAddress))}</div>
            </button>`)
        }
      }
      cells = parts.join('')
    }

    const upBtn = browsingItems
      ? `<button type="button" class="lootbag-dep__page-btn" data-creator-up ${this.busy ? 'disabled' : ''} title="Back to collections">↑</button>`
      : ''

    this.renderHeaderDepositToolbar({
      balLabel,
      tabs,
      pagerHtml: `
        <div class="lootbag-dep__pager lootbag-dep__pager--header">
          ${upBtn}
          <button type="button" class="lootbag-dep__page-btn" data-creator-prev ${!canPrev || this.busy || this.creatorLoading ? 'disabled' : ''}>‹</button>
          <span class="lootbag-dep__page-label">${this.creatorPage + 1}/${totalPages}</span>
          <button type="button" class="lootbag-dep__page-btn" data-creator-next ${!canNext || this.busy || this.creatorLoading ? 'disabled' : ''}>›</button>
        </div>`
    })

    return `
      <div class="lootbag-dep lootbag-dep--hud lootbag-dep--creator">
        <div class="lootbag-dep__body">
          <section class="lootbag-dep__main">
            <div class="lootbag-dep__grid lootbag-dep__grid--bag">${cells}</div>
          </section>
          <aside class="lootbag-dep__side">
            <h3 class="lootbag-dep__section-title">To stock</h3>
            <div class="lootbag-dep__list">${selBlock}</div>
          </aside>
        </div>
        <footer class="lootbag-dep__footer">
          ${
            this.error || (this.status && this.mode === 'deposit')
              ? `<p class="lootbag-dep__footer-hint">${escapeHtml(this.error || this.status)}</p>`
              : ''
          }
          <button type="button" class="lootbag-panel__btn lootbag-panel__btn--primary lootbag-dep__confirm" data-stock-confirm ${this.busy || !this.stockItem ? 'disabled' : ''}>
            Stock into Loot Bag
          </button>
        </footer>
      </div>`
  }

  /** Deposit: wallet inventory (1/3·2/3) or creator Collection V2 stock form. */
  private renderDepositBody(): void {
    const balLabel = this.wallet ? formatMana(this.wallet.mana) : '—'
    const tabs = `
      <div class="lootbag-dep__tabs lootbag-dep__tabs--header" role="tablist">
        <button type="button" class="lootbag-dep__tab${this.depositSource === 'wallet' ? ' is-active' : ''}" data-dep-source="wallet" ${this.busy ? 'disabled' : ''}>Wallet</button>
        <button type="button" class="lootbag-dep__tab${this.depositSource === 'creator' ? ' is-active' : ''}" data-dep-source="creator" ${this.busy ? 'disabled' : ''}>Creator collection</button>
      </div>`

    if (this.depositSource === 'creator') {
      this.bodyEl.innerHTML = this.renderCreatorDepositHtml(balLabel, tabs)
      return
    }

    const nftCount = this.inventory.filter((i) => i.kind === 'nft').length
    const filtered = filterInv(this.inventory, this.invSearch)
    const invTotal = filtered.length
    const totalPages = Math.max(1, Math.ceil(invTotal / INV_PAGE_SIZE))
    if (this.invPage >= totalPages) this.invPage = totalPages - 1
    if (this.invPage < 0) this.invPage = 0
    const start = this.invPage * INV_PAGE_SIZE
    const pageItems = filtered.slice(start, start + INV_PAGE_SIZE)
    const selectedIds = new Set(this.selections.map((s) => s.item.id))
    const canPrev = this.invPage > 0
    const canNext = this.invPage + 1 < totalPages
    const packCount = this.selections.filter((s) => this.isPackSel(s)).length
    const nftSelCount = this.selections.length - packCount
    const selectedLabel =
      this.selections.length === 0
        ? '0'
        : `${nftSelCount ? `${nftSelCount} NFT` : ''}${nftSelCount && packCount ? ' · ' : ''}${packCount ? `${packCount} pack` : ''}`

    const selRows =
      this.selections.length === 0
        ? `<p class="lootbag-dep__empty">${
            nftCount === 0
              ? 'No Polygon wearables in this wallet · use Creator collection to mint'
              : '← Select items from your inventory'
          }</p>`
        : this.selections
            .map((sel) => {
              if (this.isPackSel(sel)) {
                return `
        <div class="lootbag-dep__stock-card lootbag-dep__stock-card--pack" data-sel-id="${escapeHtml(sel.item.id)}">
          <button type="button" class="lootbag-dep__stock-clear" data-remove="${escapeHtml(sel.item.id)}" aria-label="Remove" ${this.busy ? 'disabled' : ''}>×</button>
          <div class="lootbag-dep__stock-top">
            <div class="lootbag-dep__stock-thumb lootbag-dep__thumb--pack">◈</div>
            <div class="lootbag-dep__stock-meta">
              <div class="lootbag-dep__stock-name">${escapeHtml(sel.item.name)}</div>
              <div class="lootbag-dep__stock-tags">
                <span class="lootbag-dep__pill lootbag-dep__pill--legendary">pack</span>
                <span class="lootbag-dep__pill">escrow</span>
              </div>
            </div>
          </div>
          <div class="lootbag-dep__stock-fields">
            <label class="lootbag-dep__stock-field">
              <span>Pack prize</span>
              <input type="text" inputmode="decimal" data-prize-id="${escapeHtml(sel.item.id)}" value="${escapeHtml(sel.packPrizeMana || DEFAULT_PACK_PRIZE)}" ${this.busy ? 'disabled' : ''} />
            </label>
            <label class="lootbag-dep__stock-field">
              <span>Backing</span>
              <input type="text" inputmode="decimal" data-backing-id="${escapeHtml(sel.item.id)}" value="${escapeHtml(sel.backingMana)}" ${this.busy ? 'disabled' : ''} />
            </label>
          </div>
        </div>`
              }
              const thumb = sel.item.imageUrl
                ? `<img src="${escapeHtml(sel.item.imageUrl)}" alt="" loading="lazy" />`
                : 'NFT'
              const marketUrl = `https://market.decentraland.org/contracts/${encodeURIComponent(sel.item.collection)}/tokens/${encodeURIComponent(sel.item.tokenId)}`
              const issueLabel = invIssueLabel(sel.item)
              const issuePill = `<span class="lootbag-dep__pill">${escapeHtml(issueLabel)}</span>`
              return `
        <div class="lootbag-dep__stock-card lootbag-dep__stock-card--nft" data-sel-id="${escapeHtml(sel.item.id)}">
          <button type="button" class="lootbag-dep__stock-clear" data-remove="${escapeHtml(sel.item.id)}" aria-label="Remove" ${this.busy ? 'disabled' : ''}>×</button>
          <div class="lootbag-dep__stock-top">
            <div class="lootbag-dep__stock-thumb lootbag-dep__thumb--${escapeHtml(sel.item.rarity)} lootbag-rarity-bg--${escapeHtml(sel.item.rarity)}">${thumb}</div>
            <div class="lootbag-dep__stock-meta">
              <div class="lootbag-dep__stock-name">${escapeHtml(sel.item.name)}</div>
              <div class="lootbag-dep__stock-tags">
                <span class="lootbag-dep__pill lootbag-dep__pill--${escapeHtml(sel.item.rarity)}">${escapeHtml(sel.item.rarity)}</span>
                ${issuePill}
                <a class="lootbag-dep__pill lootbag-dep__pill--view" href="${escapeHtml(marketUrl)}" target="_blank" rel="noopener noreferrer" title="${escapeHtml(issueLabel)}">View</a>
              </div>
            </div>
          </div>
          <div class="lootbag-dep__stock-fields lootbag-dep__stock-fields--single">
            <label class="lootbag-dep__stock-field">
              <span>Backing</span>
              <input type="text" inputmode="decimal" data-backing-id="${escapeHtml(sel.item.id)}" value="${escapeHtml(sel.backingMana)}" ${this.busy ? 'disabled' : ''} />
            </label>
          </div>
        </div>`
            })
            .join('')

    // Same card chrome as bag inventory row
    const cells: string[] = []
    for (let i = 0; i < INV_PAGE_SIZE; i++) {
      const item = pageItems[i]
      if (!item) {
        cells.push(`<div class="lootbag-panel__card lootbag-panel__card--empty" aria-hidden="true"></div>`)
        continue
      }
      const on = selectedIds.has(item.id)
      const isPack = item.kind === 'pack'
      const rarity = isPack ? 'legendary' : (item.rarity || 'common').toLowerCase()
      const media = item.imageUrl && !isPack
        ? `<img class="lootbag-panel__card-img" src="${escapeHtml(item.imageUrl)}" alt="" loading="lazy" decoding="async" />`
        : `<div class="lootbag-panel__card-placeholder" aria-hidden="true">${isPack ? '◈' : '✦'}</div>`
      const detail = isPack
        ? 'Always available'
        : escapeHtml(invIssueLabel(item))
      const rarityLabel = isPack ? 'pack' : rarity
      cells.push(`
        <button type="button" class="lootbag-panel__card lootbag-dep__pick${on ? ' is-selected' : ''}${isPack ? ' is-pack' : ''} lootbag-rarity--${escapeHtml(rarity)}" data-pick="${escapeHtml(item.id)}" ${this.busy ? 'disabled' : ''}>
          <div class="lootbag-panel__card-media lootbag-rarity-bg--${escapeHtml(rarity)}">${media}</div>
          <div class="lootbag-panel__card-line lootbag-panel__card-line--title" title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</div>
          <div class="lootbag-panel__card-line">${detail}</div>
          <div class="lootbag-panel__card-line lootbag-panel__card-line--rarity is-${escapeHtml(rarity)}">${escapeHtml(rarityLabel)}</div>
        </button>`)
    }

    this.renderHeaderDepositToolbar({
      balLabel,
      tabs,
      searchHtml: `
        <div class="lootbag-dep__search-row lootbag-dep__search-row--header">
          <input
            type="search"
            class="lootbag-dep__search"
            data-inv-search
            placeholder="Search name, rarity, issue…"
            value="${escapeHtml(this.invSearch)}"
            ${this.busy ? 'disabled' : ''}
            autocomplete="off"
            spellcheck="false"
          />
          ${
            this.invSearch.trim()
              ? `<button type="button" class="lootbag-dep__search-clear" data-inv-search-clear ${this.busy ? 'disabled' : ''}>Clear</button>`
              : ''
          }
        </div>`,
      pagerHtml: `
        <div class="lootbag-dep__pager lootbag-dep__pager--header">
          <button type="button" class="lootbag-dep__page-btn" data-inv-prev ${!canPrev || this.busy ? 'disabled' : ''}>‹</button>
          <span class="lootbag-dep__page-label" title="${invTotal} depositable item${invTotal === 1 ? '' : 's'}">${this.invPage + 1}/${totalPages} · ${invTotal}</span>
          <button type="button" class="lootbag-dep__page-btn" data-inv-next ${!canNext || this.busy ? 'disabled' : ''}>›</button>
        </div>`
    })

    const sendSummary = this.depositSendSummaryText()

    this.bodyEl.innerHTML = `
      <div class="lootbag-dep lootbag-dep--hud">
        <div class="lootbag-dep__body">
          <section class="lootbag-dep__main">
            <div class="lootbag-dep__grid lootbag-dep__grid--bag">${
              invTotal === 0
                ? `<div class="lootbag-dep__empty lootbag-dep__empty--center">${
                    this.invSearch.trim()
                      ? 'No items match your search'
                      : nftCount === 0
                        ? 'No wearables in wallet'
                        : 'Nothing to show'
                  }</div>`
                : cells.join('')
            }</div>
          </section>
          <aside class="lootbag-dep__side">
            <div class="lootbag-dep__side-head">
              <h3 class="lootbag-dep__section-title">To Deposit</h3>
              <span class="lootbag-dep__side-count" data-dep-selected title="Selected">${escapeHtml(selectedLabel)}</span>
            </div>
            <div class="lootbag-dep__list">${selRows}</div>
          </aside>
        </div>
        <footer class="lootbag-dep__footer lootbag-dep__footer--inv-row">
          <div class="lootbag-dep__footer-inv">
            <button type="button" class="lootbag-panel__btn lootbag-panel__btn--primary lootbag-dep__confirm" data-dep-confirm ${this.busy || this.selections.length === 0 ? 'disabled' : ''}>
              Confirm deposit
            </button>
            ${
              this.error || (this.status && this.mode === 'deposit')
                ? `<p class="lootbag-dep__footer-hint lootbag-dep__footer-hint--row">${escapeHtml(this.error || this.status)}</p>`
                : ''
            }
          </div>
          <div class="lootbag-dep__footer-side">
            <span class="lootbag-dep__footer-send" data-dep-send-summary title="Assets you will send">${escapeHtml(sendSummary)}</span>
          </div>
        </footer>
      </div>
    `
  }

  private openWinModal(win: PendingWin): void {
    this.pendingWin = win
    writeStoredPendingPositionId(this.sessionAddress(), win.positionId)
    const p = win.position
    const isPack = p?.kind === 'manaPack'
    const title = p
      ? isPack
        ? 'MANA Pack'
        : escapeHtml(p.name?.trim() || posIssueLabel(p))
      : `Position #${win.positionId}`
    const netTake =
      p && p.backing > 0n
        ? takeTokensNetWei(p.backing, this.pool?.depositorBidRateBps)
        : 0n
    const sub = p
      ? isPack
        ? `Prize ${formatMana(p.packMana)} mMANA · Backed by ${formatMana(p.backing)} mMANA`
        : `Backed by ${formatMana(p.backing)} mMANA · ${shortAddr(p.depositor)}`
      : 'Settle your claim'
    const bidPct = Math.round((this.pool?.depositorBidRateBps ?? 8500) / 100)
    const takeHint =
      netTake > 0n
        ? `<p class="lootbag-win-modal__hint">Take MANA nets ${formatMana(netTake)} mMANA (${bidPct}% of backing; protocol keeps the rest).</p>`
        : ''
    const glyph = isPack ? '◈' : '✦'
    // Always enable settle on open; setBusy() toggles disabled while a settle runs.
    const card = this.winModal.querySelector('[data-win-card]')!
    card.innerHTML = `
      <button type="button" class="lootbag-win-modal__x" data-win-close aria-label="Close">×</button>
      <div class="lootbag-win-modal__kicker">Selected from Loot Bag</div>
      <div class="lootbag-win-modal__art" aria-hidden="true">${glyph}</div>
      <h3 class="lootbag-win-modal__title">${title}</h3>
      <p class="lootbag-win-modal__sub">${sub}</p>
      <p class="lootbag-win-modal__pos">pos ${win.positionId}</p>
      ${takeHint}
      <div class="lootbag-win-modal__actions">
        <button type="button" class="lootbag-panel__btn lootbag-panel__btn--primary" data-settle-keep>Keep prize</button>
        <button type="button" class="lootbag-panel__btn lootbag-panel__btn--secondary" data-settle-take>${
          netTake > 0n ? `Take ${formatMana(netTake)} mMANA` : 'Take MANA'
        }</button>
      </div>
    `
    this.winModal.hidden = false
    document.documentElement.classList.add('lootbag-win-open')
  }

  private closeWinModal(opts: { clearPending: boolean }): void {
    this.winModal.hidden = true
    document.documentElement.classList.remove('lootbag-win-open')
    const card = this.winModal.querySelector('[data-win-card]')
    if (card) card.innerHTML = ''
    if (opts.clearPending) {
      this.pendingWin = null
      clearStoredPendingPositionId(this.sessionAddress())
    }
  }

  /** Drop won item from local shelf without full bag reload (FWA-style). */
  private removeWonPositionLocally(positionId: number): void {
    if (!this.pool) return
    const next = this.pool.positions.filter((p) => p.positionId !== positionId)
    if (next.length === this.pool.positions.length) return
    const dropped = this.pool.positions.length - next.length
    this.pool = {
      ...this.pool,
      positions: next,
      activeCount:
        this.pool.activeCount > BigInt(dropped)
          ? this.pool.activeCount - BigInt(dropped)
          : 0n
    }
    if (this.mode === 'main') this.renderMainBody()
  }

  /**
   * Reopen Keep/Take if the wallet already paid for a pack and never settled.
   * @returns true when a pending win was shown
   */
  private async restorePendingWinIfAny(): Promise<boolean> {
    const addr = this.sessionAddress()
    if (!addr || !/^0x[a-fA-F0-9]{40}$/.test(addr)) return false
    if (this.pendingWin && !this.winModal.hidden) return true
    try {
      const hint = readStoredPendingPositionId(addr)
      const found = await findPendingWinForPurchaser(
        addr as `0x${string}`,
        undefined,
        hint ?? undefined
      )
      if (!found) {
        if (hint != null) clearStoredPendingPositionId(addr)
        return false
      }
      const fromShelf =
        this.pool?.positions.find((p) => p.positionId === found.positionId) ?? null
      const merged = mergeWinPosition(found.position, fromShelf)
      const win: PendingWin = {
        positionId: found.positionId,
        position: merged
      }
      this.removeWonPositionLocally(found.positionId)
      this.openWinModal(win)
      this.status = `Pos #${found.positionId} — Keep NFT or Take tokens`
      this.renderStatus()
      return true
    } catch {
      return false
    }
  }

  private renderSteps(): void {
    // Centered viewport overlay for all sign / meta-tx steps (2D + 3D).
    // Only while a step is active or errored — never leave "all Done / Working…".
    const active = this.steps.find((s) => s.status === 'active')
    const errored = this.steps.find((s) => s.status === 'error')
    const showOverlay = this.steps.length > 0 && (active != null || errored != null)

    if (showOverlay) {
      const title =
        this.mode === 'deposit'
          ? this.depositSource === 'creator'
            ? 'Stock into Loot Bag'
            : 'Deposit to Loot Bag'
          : this.steps.some((s) => /open loot pack|claim|pack cost|mMANA for pack/i.test(s.label))
            ? 'Claim Loot Pack'
            : this.steps.some((s) => /keep your prize|take the mana|settle/i.test(s.label))
              ? 'Settle claim'
              : this.steps.some((s) => /collect your rewards|withdraw/i.test(s.label))
                ? 'Collect rewards'
                : 'Loot Bag'
      const statusLine =
        active != null
          ? active.detail?.trim() || 'Confirm in your wallet…'
          : errored != null
            ? errored.detail?.trim() || 'Something went wrong'
            : 'Working…'
      // Pack cost / balance only for open-claim — irrelevant on settle (Keep/Take).
      const isClaimFlow =
        this.mode !== 'deposit' &&
        this.steps.some((s) => /open loot pack|claim|pack cost|mMANA for pack/i.test(s.label))
      const isSettleFlow =
        this.mode !== 'deposit' &&
        this.steps.some((s) => /keep your prize|take the mana|settle/i.test(s.label))
      syncLootBagSignOverlay({
        title,
        status: statusLine,
        meta: isClaimFlow && !isSettleFlow ? this.manaCostBalance().summary : undefined,
        steps: this.steps
      })
    } else {
      hideLootBagSignOverlay()
    }

    // Progress / errors live in the centered overlay only — never under the bag inventory.
    this.stepsEl.hidden = true
    this.stepsEl.innerHTML = ''
  }

  private renderStatus(): void {
    // Don't mirror claim/deposit notes or wallet errors into the bag panel footer.
    this.statusEl.hidden = true
    this.statusEl.textContent = ''
    this.statusEl.className = 'lootbag-panel__status'
  }

  private async onBodyClick(ev: MouseEvent): Promise<void> {
    const t = ev.target as HTMLElement

    if (this.mode === 'main') return

    // Deposit mode
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
      this.renderDepositBody()
      return
    }
    if (t.closest('[data-creator-up]')) {
      this.creatorBrowse = 'collections'
      this.selectedCreatorCollection = null
      this.creatorItems = []
      this.creatorPage = 0
      this.renderDepositBody()
      return
    }
    if (t.closest('[data-creator-prev]')) {
      if (this.creatorPage > 0) {
        this.creatorPage -= 1
        this.renderDepositBody()
      }
      return
    }
    if (t.closest('[data-creator-next]')) {
      const n =
        this.creatorBrowse === 'items' ? this.creatorItems.length : this.creatorCollections.length
      const totalPages = Math.max(1, Math.ceil(n / INV_PAGE_SIZE))
      if (this.creatorPage + 1 < totalPages) {
        this.creatorPage += 1
        this.renderDepositBody()
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
        void this.defaultStockDepositorFor(it.contractAddress)
        this.renderDepositBody()
      }
      return
    }
    if (t.closest('[data-stock-clear]')) {
      this.stockItem = null
      this.stockDepositor = ''
      this.renderDepositBody()
      return
    }
    if (t.closest('[data-stock-confirm]')) {
      await this.confirmStockFromCollection()
      return
    }
    if (t.closest('[data-inv-search-clear]')) {
      this.invSearch = ''
      this.invPage = 0
      this.renderDepositBody()
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
      const totalPages = Math.max(
        1,
        Math.ceil(filterInv(this.inventory, this.invSearch).length / INV_PAGE_SIZE)
      )
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
    if ('invSearch' in input.dataset) {
      this.invSearch = input.value
      this.invPage = 0
      this.renderDepositBody()
      const el =
        (this.headerDepositEl.querySelector('[data-inv-search]') as HTMLInputElement | null) ||
        (this.bodyEl.querySelector('[data-inv-search]') as HTMLInputElement | null)
      if (el) {
        el.focus()
        const len = el.value.length
        try {
          el.setSelectionRange(len, len)
        } catch {
          /* type=search may ignore selection in some browsers */
        }
      }
      return
    }
    if ('stockCount' in input.dataset) {
      this.stockMintCount = input.value
      return
    }
    if ('stockBacking' in input.dataset) {
      this.stockAvgBacking = input.value
      return
    }
    if ('stockDepositor' in input.dataset) {
      this.stockDepositor = input.value.trim()
      return
    }
    const prizeId = input.dataset.prizeId
    const backingId = input.dataset.backingId
    if (prizeId) {
      this.selections = this.selections.map((s) =>
        s.item.id === prizeId ? { ...s, packPrizeMana: input.value } : s
      )
      this.refreshDepositSendSummary()
    } else if (backingId) {
      this.selections = this.selections.map((s) =>
        s.item.id === backingId ? { ...s, backingMana: input.value } : s
      )
      this.refreshDepositSendSummary()
    }
  }

  private async ensureCreatorCollectionsLoaded(): Promise<void> {
    const addr = this.sessionAddress()
    if (!addr) {
      this.creatorLoadError = 'Connect a wallet'
      this.creatorCollections = []
      this.renderDepositBody()
      return
    }
    if (this.creatorLoading) return
    // Reload when empty or address changed context
    this.creatorAbort?.abort()
    this.creatorAbort = new AbortController()
    this.creatorLoading = true
    this.creatorLoadError = null
    this.creatorBrowse = 'collections'
    this.selectedCreatorCollection = null
    this.creatorItems = []
    this.creatorPage = 0
    this.renderDepositBody()
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
      if (this.mode === 'deposit' && this.depositSource === 'creator') this.renderDepositBody()
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
    this.renderDepositBody()
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
      if (this.mode === 'deposit' && this.depositSource === 'creator') this.renderDepositBody()
    }
  }

  /** Prefill depositor with on-chain collection.creator() when available. */
  private async defaultStockDepositorFor(collection: string): Promise<void> {
    const fallback = this.sessionAddress()?.toLowerCase() ?? ''
    this.stockDepositor = fallback
    try {
      const st = await getCollectionMinterStatus(collection, {
        account: this.sessionAddress()
      })
      if (st.creator) this.stockDepositor = st.creator
    } catch {
      /* keep wallet fallback */
    }
    if (this.mode === 'deposit' && this.depositSource === 'creator' && this.stockItem) {
      this.renderDepositBody()
    }
  }

  private async confirmStockFromCollection(): Promise<void> {
    if (this.busy) return
    if (!this.sessionAddress()) {
      this.error = 'Connect a wallet to stock'
      this.renderDepositBody()
      return
    }
    const item = this.stockItem
    if (!item) {
      this.error = 'Select an item from the grid'
      this.renderDepositBody()
      return
    }
    const mintCount = Math.floor(Number(this.stockMintCount))
    if (!Number.isFinite(mintCount) || mintCount < 1) {
      this.error = 'Mint count must be at least 1'
      this.renderDepositBody()
      return
    }
    const avg = Number(this.stockAvgBacking)
    if (!Number.isFinite(avg) || avg <= 0) {
      this.error = 'Avg backing must be greater than 0'
      this.renderDepositBody()
      return
    }
    const dep = this.stockDepositor.trim()
    if (dep && !/^0x[a-fA-F0-9]{40}$/.test(dep)) {
      this.error = 'Depositor must be a valid 0x wallet address'
      this.renderDepositBody()
      return
    }

    this.setBusy(true)
    this.error = null
    this.steps = []
    this.stepSeq = 0
    this.status = `Stocking ${mintCount}× ${item.name}…`
    this.renderDepositBody()
    try {
      await runStockFromCollection({
        sessionAddress: this.sessionAddress(),
        isGuest: this.options.getSession().isGuest(),
        collection: item.contractAddress,
        itemId: item.itemId,
        mintCount,
        avgBackingMana: this.stockAvgBacking,
        depositor: dep || this.sessionAddress(),
        api: this.flowApi(),
        waitForContinue: async ({ label }) => {
          await requestLootBagSignContinue({
            title: 'Stock into Loot Bag',
            status: label,
            steps: this.steps,
            buttonLabel: 'Continue'
          })
        }
      })
      this.steps = []
      hideLootBagSignOverlay()
      this.stockItem = null
      this.stockDepositor = ''
      await this.refresh()
      this.setBusy(false)
      await showLootBagSuccessOverlay({
        title: 'Stocked!',
        message: `${mintCount} item${mintCount === 1 ? '' : 's'} added to the Loot Bag.`,
        detail: item.name,
        buttonLabel: 'Back to Loot Bag'
      })
      this.setMode('main')
      this.status = `Stocked ${mintCount} into Loot Bag`
      this.renderStatus()
    } catch (e) {
      this.error = humanizeStockError(e)
      // Stay on deposit; keep failed step visible in overlay
      this.renderDepositBody()
      this.renderSteps()
      this.setBusy(false)
      if (this.mode === 'deposit') this.renderDepositBody()
      return
    }
    this.setBusy(false)
    if (this.mode === 'deposit') this.renderDepositBody()
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
            isGuest: this.options.getSession().isGuest(),
            packPrizeMana: sel.packPrizeMana || DEFAULT_PACK_PRIZE,
            backingMana: sel.backingMana,
            api: this.flowApi()
          })
          this.selections = this.selections.filter((s) => s.item.id !== sel.item.id)
        } else {
          await runDepositNft({
            sessionAddress: this.sessionAddress(),
            isGuest: this.options.getSession().isGuest(),
            collection: sel.item.collection as `0x${string}`,
            tokenId: BigInt(sel.item.tokenId),
            backingMana: sel.backingMana,
            api: this.flowApi()
          })
          this.inventory = this.inventory.filter((it) => it.id !== sel.item.id)
          this.selections = this.selections.filter((s) => s.item.id !== sel.item.id)
          if (this.wallet) {
            this.wallet = {
              ...this.wallet,
              ownedNfts: this.wallet.ownedNfts.filter((n) => n.id !== sel.item.id),
              ownedTokenIds: this.wallet.ownedTokenIds.filter((id) => String(id) !== sel.item.tokenId)
            }
          }
        }
      }
      this.status = 'Deposits locked in'
      this.steps = []
      await this.refresh()
      this.setMode('main')
      this.status = 'Deposits locked in — Loot Bag refreshed'
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
    if (this.busy || this.claiming || this.mode !== 'main') return
    // Already mid-settle — just re-show Keep/Take (same as 2D).
    if (this.pendingWin) {
      this.openWinModal(this.pendingWin)
      return
    }
    if (!this.sessionAddress()) {
      this.error = 'Connect a wallet to claim'
      this.renderStatus()
      return
    }

    // Fast path: chain may still hold an unsettled prize (refresh / leave).
    this.setBusy(true)
    this.claiming = true
    this.error = null
    try {
      const restored = await this.restorePendingWinIfAny()
      if (restored) {
        this.dismissSignOverlay()
        return
      }
    } finally {
      this.claiming = false
      this.setBusy(false)
    }

    const blockedReason = lootBagClaimingBlockedReason(this.pool)
    if (blockedReason) {
      this.error = blockedReason
      this.renderStatus()
      return
    }

    if (!this.pool || this.pool.positions.length === 0 || this.pool.activeCount === 0n) {
      this.error = 'Loot Bag is empty — deposit first'
      this.renderStatus()
      return
    }
    // UI pre-check (authoritative check is on-chain inside runPull)
    const fee = this.pool.acquisitionFee
    const bal = this.wallet?.mana ?? 0n
    if (fee > 0n && bal < fee) {
      this.error = `Not enough mMANA — need ${formatMana(fee)} for pack cost, balance ${formatMana(bal)}`
      this.renderStatus()
      return
    }

    this.setBusy(true)
    this.claiming = true
    this.error = null
    this.steps = []
    this.stepSeq = 0
    this.closeWinModal({ clearPending: true })
    this.renderSteps()
    this.status = 'Claiming from Loot Bag…'
    this.renderStatus()
    this.element.classList.add('is-claiming')

    try {
      // Shelf metadata for the item about to leave the active pool
      const shelfBefore = this.pool?.positions ?? []
      const hint = readStoredPendingPositionId(this.sessionAddress())
      const { win, alreadyPending } = await runPull({
        sessionAddress: this.sessionAddress(),
        isGuest: this.options.getSession().isGuest(),
        acquisitionFee: this.pool.acquisitionFee,
        api: this.flowApi(),
        hintPositionId: hint
      })

      this.dismissSignOverlay()
      this.claiming = false

      if (!win) {
        this.status = 'Claim confirmed'
        this.renderStatus()
        await this.refresh()
        return
      }

      const fromShelfBefore =
        shelfBefore.find((p) => p.positionId === win.positionId) ?? null
      const merged = mergeWinPosition(win.position, fromShelfBefore)
      const finalWin: PendingWin = { positionId: win.positionId, position: merged }
      this.removeWonPositionLocally(win.positionId)
      // Fee paid — refresh wallet balance only (not whole bag)
      if (!alreadyPending) {
        const addr = this.sessionAddress()
        if (addr && /^0x[a-fA-F0-9]{40}$/.test(addr)) {
          try {
            this.wallet = await fetchWalletSnapshot(addr as `0x${string}`)
            this.renderHeader()
          } catch {
            /* ignore balance refresh failures */
          }
        }
      }

      this.status = alreadyPending
        ? `Pos #${win.positionId} — Keep NFT or Take tokens`
        : `Selected pos #${win.positionId}`
      this.renderStatus()
      // Peer toast waits until Keep / Take (runSettle).
      this.openWinModal(finalWin)
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e)
      this.renderStatus()
      // Timeout after fee paid: keep storage hint if any; do not invent a fake win
      const hasError = this.steps.some((s) => s.status === 'error')
      if (!hasError) this.dismissSignOverlay()
    } finally {
      this.element.classList.remove('is-claiming')
      this.claiming = false
      if (!this.steps.some((s) => s.status === 'active' || s.status === 'error')) {
        this.dismissSignOverlay()
      }
      this.setBusy(false)
    }
  }

  /** Peers toast after the claimer settles (Keep / Take) — not when the pack first opens. */
  private async broadcastClaim(
    win: PendingWin,
    demo: boolean,
    keepPrize: boolean
  ): Promise<void> {
    const session = this.options.getSession()
    const p = win.position
    const isPack = p?.kind === 'manaPack'
    // Keep pack → full prize; take tokens → backing × depositorBidRateBps (default 85%).
    const bidBps = this.pool?.depositorBidRateBps
    const manaAmount = p
      ? keepPrize
        ? isPack && p.packMana > 0n
          ? formatMana(p.packMana)
          : null
        : p.backing > 0n
          ? formatMana(takeTokensNetWei(p.backing, bidBps))
          : null
      : null
    const label = !keepPrize
      ? manaAmount
        ? `Took ${manaAmount} mMANA`
        : 'Took MANA'
      : p
        ? isPack
          ? manaAmount
            ? `MANA Pack · ${manaAmount} mMANA`
            : 'MANA Pack'
          : p.name?.trim() || posIssueLabel(p)
        : `pos ${win.positionId}`
    const profile = session.getProfile()
    const displayName = profile?.displayName?.trim() || null
    await publishPoolClaim({
      identity: session.getAuthIdentity(),
      address: session.getAddress() ?? this.sessionAddress(),
      displayName,
      positionId: win.positionId,
      label,
      demo,
      imageUrl: p?.imageUrl ?? null,
      rarity: isPack ? 'legendary' : (p?.rarity ?? null),
      issueId: isPack
        ? null
        : p
          ? resolveIssuedId(p.tokenId, {
              collection: p.collection,
              knownIssuedId: p.issuedId
            })
          : null,
      itemName: isPack ? 'MANA Pack' : (p?.name?.trim() || null),
      kind: isPack ? 'pack' : 'nft',
      manaAmount,
      outcome: keepPrize ? 'keep' : 'take'
    })
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
      const settled = this.pendingWin
      await runSettle({
        sessionAddress: this.sessionAddress(),
        isGuest: this.options.getSession().isGuest(),
        positionId: settled.positionId,
        keepPrize,
        api: this.flowApi()
      })
      // Peer toast only after Keep / Take succeeds (real chain settle)
      void this.broadcastClaim(settled, false, keepPrize)
      this.closeWinModal({ clearPending: true })
      this.status = keepPrize ? 'Settled — prize is yours' : 'Settled — took the MANA bid'
      this.renderStatus()
      await this.refresh()
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e)
      this.renderStatus()
      if (this.pendingWin) this.openWinModal(this.pendingWin)
    } finally {
      if (!this.steps.some((s) => s.status === 'active' || s.status === 'error')) {
        this.dismissSignOverlay()
      }
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
        isGuest: this.options.getSession().isGuest(),
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
