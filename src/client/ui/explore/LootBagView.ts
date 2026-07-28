/**
 * 2D Loot Bag — bag contents + Loot Pack claim.
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
  takeTokensNetWei,
  runDepositManaPack,
  runDepositNft,
  runStockFromCollection,
  runPull,
  runSettle,
  runWithdrawRewards,
  shortAddr,
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
  type PoolSnapshot,
  type TxStep,
  type WalletSnapshot
} from '../../../lootBag'
import { publishPoolClaim } from '../../../social/publishPoolClaim'

export type LootBagViewOptions = {
  login: LoginResult
  getLogin?: () => LoginResult
}

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
  issuedId?: string
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

function itemLabel(p: LootBagPosition): string {
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
    issuedId: n.issuedId
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
      const hay = [
        i.name,
        i.rarity,
        i.tokenId,
        i.issuedId ?? '',
        i.collection,
        i.id
      ]
        .join(' ')
        .toLowerCase()
      return hay.includes(q)
    })
  }
  nfts.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
  const showPack =
    !!pack &&
    (!q ||
      pack.name.toLowerCase().includes(q) ||
      q === 'pack' ||
      q.includes('mana'))
  return showPack && pack ? [pack, ...nfts] : nfts
}

/** Centered loading status while pool snapshot loads (no skeleton cards). */
function shelfLoadingHtml(label: string): string {
  return `
    <div class="lootbag-shelf-skel lootbag-shelf-skel--text-only" role="status" aria-live="polite" aria-busy="true">
      <div class="lootbag-shelf-skel__footer">
        <span class="lootbag-shelf-skel__spin" aria-hidden="true"></span>
        <p class="lootbag-shelf-skel__label">${escapeHtml(label)}</p>
      </div>
    </div>`
}

export class LootBagView {
  readonly root: HTMLElement

  private login: LoginResult
  private pool: PoolSnapshot | null = null
  private wallet: WalletSnapshot | null = null
  private inventory: InvItem[] = []
  private selections: DepositSelection[] = []
  /** Wallet inventory search (name / rarity / issue / collection) */
  private invSearch = ''
  private depositSource: DepositSource = 'wallet'
  private creatorBrowse: 'collections' | 'items' = 'collections'
  private creatorCollections: CreatorCollection[] = []
  private creatorItems: CreatorCollectionItem[] = []
  private creatorLoading = false
  private creatorLoadError: string | null = null
  private selectedCreatorCollection: CreatorCollection | null = null
  private stockItem: CreatorCollectionItem | null = null
  private stockMintCount = DEFAULT_STOCK_COUNT
  private stockAvgBacking = DEFAULT_BACKING
  /** Take MANA NFT return / Keep fee credits — prefer collection creator */
  private stockDepositor = ''
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
  private packPhase: 'idle' | 'tearing' | 'revealed' = 'idle'
  private packImg: HTMLImageElement | null = null
  private packImgReady: Promise<HTMLImageElement> | null = null
  private packAnimRaf = 0

  private readonly marqueeEl: HTMLElement
  private readonly playBodyEl: HTMLElement
  private readonly depositBodyEl: HTMLElement
  private readonly feeEl: HTMLElement
  private readonly balEl: HTMLElement
  private readonly claimableChipBtn: HTMLButtonElement
  private readonly poolCountEl: HTMLElement
  private readonly shelfEl: HTMLElement
  private readonly statusEl: HTMLElement
  private readonly stepsEl: HTMLElement
  private readonly claimBtn: HTMLButtonElement
  private readonly depositBtn: HTMLButtonElement
  private readonly refreshBtn: HTMLButtonElement
  private readonly feesModalEl: HTMLElement
  private readonly winModal: HTMLElement
  private readonly packStageEl: HTMLElement
  private readonly packCanvas: HTMLCanvasElement
  private readonly packPrizeEl: HTMLElement
  private readonly settleKeepBtn: HTMLButtonElement
  private readonly settleTakeBtn: HTMLButtonElement

  constructor(opts: LootBagViewOptions) {
    this.login = opts.login

    this.root = document.createElement('div')
    this.root.className = 'lootbag lootbag--vitrine'
    this.root.innerHTML = `
      <div class="lootbag__stage">
        <div class="lootbag__machine lootbag__machine--vitrine">
          <div class="lootbag__play" data-play>
            <!-- 2 columns: left 2/3 Loot Bag · right 1/3 Loot Pack. Each column is its own card. -->
            <div class="lootbag__columns">
              <section class="lootbag__col lootbag__col--bag" aria-label="Loot Bag">
                <div class="lootbag__hud">
                  <div class="lootbag__hud-stats">
                    <h1 class="lootbag__title" data-marquee>Loot Bag</h1>
                    <div class="lootbag__in-bag">
                      <span class="lootbag__in-bag-count" data-pool-count>—</span>
                      <button type="button" class="lootbag__chip-refresh" data-refresh title="Refresh Loot Bag" aria-label="Refresh">↻</button>
                      <button type="button" class="lootbag__btn lootbag__btn--add-loot" data-deposit-btn>
                        Add Loot
                      </button>
                    </div>
                  </div>
                  <div class="lootbag__hud-actions">
                    <button type="button" class="lootbag__btn lootbag__btn--rewards" data-claimable-chip title="Your pool rewards from Loot Pack fees">
                      Rewards
                    </button>
                  </div>
                </div>

                <div class="lootbag__vitrine" data-vitrine>
                  <div class="lootbag__vitrine-glass" aria-hidden="true"></div>
                  <div class="lootbag__vitrine-ledge" aria-hidden="true"></div>
                  <div class="lootbag__shelf" data-shelf></div>
                </div>

                <div class="lootbag__steps" data-steps hidden></div>
                <p class="lootbag__status" data-status></p>
              </section>

              <section class="lootbag__col lootbag__col--pack" aria-label="Loot Pack" data-pack-col>
                <div class="lootbag__pack-cost">
                  <span class="lootbag__pack-cost-label">Pack cost</span>
                  <div class="lootbag__pack-cost-row">
                    <span class="lootbag__pack-cost-value" data-fee>—</span>
                    <span class="lootbag__pack-cost-bal" data-bal></span>
                  </div>
                </div>
                <div class="lootbag-pack-stage" data-pack-stage>
                  <div class="lootbag-pack-stage__prize" data-pack-prize aria-live="polite"></div>
                  <canvas class="lootbag-pack-stage__canvas" data-pack-canvas aria-label="Loot Pack"></canvas>
                </div>
                <div class="lootbag__col-actions" data-pack-actions>
                  <button type="button" class="lootbag__btn lootbag__btn--claim" data-claim>
                    <span class="lootbag__claim-label">Claim Loot Pack</span>
                  </button>
                  <button type="button" class="lootbag__btn lootbag__btn--keep" data-settle-keep hidden>
                    Keep NFT
                  </button>
                  <button type="button" class="lootbag__btn lootbag__btn--take" data-settle-take hidden>
                    Take tokens
                  </button>
                </div>
              </section>
            </div>
          </div>

          <div class="lootbag__deposit-view" data-deposit-view hidden></div>
        </div>
      </div>

      <div class="lootbag-fees-modal" data-fees-modal hidden>
        <div class="lootbag-fees-modal__backdrop" data-fees-close></div>
        <div class="lootbag-fees-modal__card" role="dialog" aria-modal="true" aria-labelledby="lootbag-fees-title">
          <button type="button" class="lootbag-fees-modal__x" data-fees-close aria-label="Close">×</button>
          <div class="lootbag-fees-modal__kicker">Loot Bag</div>
          <h2 class="lootbag-fees-modal__title" id="lootbag-fees-title">Rewards</h2>
          <p class="lootbag-fees-modal__amount" data-fees-amount>—</p>
          <div class="lootbag-fees-modal__body">
            <p>When someone pays the <strong>pack cost</strong> to claim a Loot Pack, most of that fee is shared equally across every active deposit.</p>
            <p>If you have items in the Loot Bag (or recently did), your share builds up here as <strong>claimable mMANA</strong>.</p>
            <p>Withdraw sends that balance to your wallet via a gasless meta-transaction.</p>
          </div>
          <p class="lootbag-fees-modal__error" data-fees-error hidden></p>
          <button type="button" class="lootbag__btn lootbag__btn--claim lootbag-fees-modal__withdraw" data-fees-withdraw>
            Withdraw rewards
          </button>
        </div>
      </div>
    `

    this.winModal = document.createElement('div')
    this.winModal.className = 'lootbag-win-modal'
    this.winModal.hidden = true
    this.winModal.setAttribute('role', 'dialog')
    this.winModal.setAttribute('aria-modal', 'true')
    this.winModal.setAttribute('aria-label', 'Loot Pack result')
    this.winModal.innerHTML = `
      <div class="lootbag-win-modal__backdrop" data-win-backdrop></div>
      <div class="lootbag-win-modal__card" data-win-card></div>
    `
    document.body.appendChild(this.winModal)

    this.marqueeEl = this.root.querySelector('[data-marquee]')!
    this.playBodyEl = this.root.querySelector('[data-play]')!
    this.depositBodyEl = this.root.querySelector('[data-deposit-view]')!
    this.feeEl = this.root.querySelector('[data-fee]')!
    this.balEl = this.root.querySelector('[data-bal]')!
    this.claimableChipBtn = this.root.querySelector('[data-claimable-chip]')!
    this.poolCountEl = this.root.querySelector('[data-pool-count]')!
    this.shelfEl = this.root.querySelector('[data-shelf]')!
    this.statusEl = this.root.querySelector('[data-status]')!
    this.stepsEl = this.root.querySelector('[data-steps]')!
    this.claimBtn = this.root.querySelector('[data-claim]')!
    this.depositBtn = this.root.querySelector('[data-deposit-btn]')!
    this.refreshBtn = this.root.querySelector('[data-refresh]')!
    this.feesModalEl = this.root.querySelector('[data-fees-modal]')!
    this.packStageEl = this.root.querySelector('[data-pack-stage]')!
    this.packCanvas = this.root.querySelector('[data-pack-canvas]')!
    this.packPrizeEl = this.root.querySelector('[data-pack-prize]')!
    this.settleKeepBtn = this.root.querySelector('[data-settle-keep]')!
    this.settleTakeBtn = this.root.querySelector('[data-settle-take]')!

    this.claimBtn.addEventListener('click', () => void this.onClaim())
    this.settleKeepBtn.addEventListener('click', () => void this.runSettle(true))
    this.settleTakeBtn.addEventListener('click', () => void this.runSettle(false))
    this.depositBtn.addEventListener('click', () => this.openDeposit())
    this.refreshBtn.addEventListener('click', () => void this.refresh())
    this.claimableChipBtn.addEventListener('click', () => this.openFeesModal())
    this.feesModalEl.addEventListener('click', (ev) => void this.onFeesModalClick(ev))
    this.winModal.addEventListener('click', (ev) => void this.onWinModalClick(ev))
    this.depositBodyEl.addEventListener('click', (ev) => void this.onDepositViewClick(ev))
    this.depositBodyEl.addEventListener('input', (ev) => this.onDepositViewInput(ev))
  }

  mount(): void {
    this.renderShelfLoading()
    void this.ensurePackImage()
    this.drawPackIdle()
    void this.refresh()
    window.addEventListener('resize', this.onPackResize)
  }

  setLogin(login: LoginResult): void {
    this.login = login
    void this.refresh()
  }

  dispose(): void {
    window.removeEventListener('resize', this.onPackResize)
    if (this.packAnimRaf) cancelAnimationFrame(this.packAnimRaf)
    this.closeFeesModal()
    this.closeWinModal({ clearPending: true })
    this.winModal.remove()
    this.root.remove()
  }

  private onPackResize = (): void => {
    if (this.packPhase === 'idle') this.drawPackIdle()
  }

  private ensurePackImage(): Promise<HTMLImageElement> {
    if (this.packImg?.complete && this.packImg.naturalWidth > 0) {
      return Promise.resolve(this.packImg)
    }
    if (this.packImgReady) return this.packImgReady
    this.packImgReady = new Promise((resolve, reject) => {
      const img = new Image()
      img.decoding = 'async'
      img.onload = () => {
        this.packImg = img
        resolve(img)
      }
      img.onerror = () => reject(new Error('Failed to load loot pack art'))
      img.src = '/media/lootbag/lootpack.png?v=5'
    })
    return this.packImgReady
  }

  private sizePackCanvas(): { w: number; h: number; dpr: number } {
    const rect = this.packStageEl.getBoundingClientRect()
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const w = Math.max(1, Math.floor(rect.width))
    const h = Math.max(1, Math.floor(rect.height))
    const cw = Math.floor(w * dpr)
    const ch = Math.floor(h * dpr)
    if (this.packCanvas.width !== cw || this.packCanvas.height !== ch) {
      this.packCanvas.width = cw
      this.packCanvas.height = ch
      this.packCanvas.style.width = `${w}px`
      this.packCanvas.style.height = `${h}px`
    }
    return { w, h, dpr }
  }

  private packDrawLayout(img: HTMLImageElement, w: number, h: number) {
    const pad = 14
    const maxW = w - pad * 2
    const maxH = h - pad * 2
    const scale = Math.min(maxW / img.naturalWidth, maxH / img.naturalHeight)
    const dw = img.naturalWidth * scale
    const dh = img.naturalHeight * scale
    const x = (w - dw) / 2
    const y = (h - dh) / 2
    return { x, y, dw, dh }
  }

  /** Idle sealed pack — canvas fully covers stage so prize never shows through. */
  private drawPackIdle(): void {
    const ctx = this.packCanvas.getContext('2d')
    if (!ctx) return
    const { w, h, dpr } = this.sizePackCanvas()
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, h)
    // Opaque stage fill (same as panel) — no see-through
    ctx.fillStyle = '#0a0614'
    ctx.fillRect(0, 0, w, h)
    const img = this.packImg
    if (!img?.complete || img.naturalWidth <= 0) {
      void this.ensurePackImage().then(() => {
        if (this.packPhase === 'idle') this.drawPackIdle()
      })
      return
    }
    const { x, y, dw, dh } = this.packDrawLayout(img, w, h)
    ctx.drawImage(img, x, y, dw, dh)
    this.packCanvas.hidden = false
  }

  /**
   * Canvas unzip: jagged tear across pack top, then fully-opaque pack falls.
   * During the fall, only the pack (+ solid backplate) is drawn so empty canvas
   * pixels reveal the prize underneath — no semi-transparent foil.
   */
  private playPackTearAnimation(): Promise<void> {
    return new Promise((resolve, reject) => {
      void this.ensurePackImage()
        .then((img) => {
          this.packPhase = 'tearing'
          this.packStageEl.classList.remove('is-revealed')
          this.packStageEl.classList.add('is-tearing')
          this.packCanvas.hidden = false
          // Prize sits under canvas; shown as pack moves down
          this.packPrizeEl.hidden = false

          const TEAR_MS = 480
          const FALL_MS = 1050
          const TOTAL = TEAR_MS + FALL_MS
          const t0 = performance.now()
          let revealed = false

          const frame = (now: number) => {
            const elapsed = now - t0
            const ctx = this.packCanvas.getContext('2d')
            if (!ctx) {
              resolve()
              return
            }
            const { w, h, dpr } = this.sizePackCanvas()
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
            ctx.clearRect(0, 0, w, h)

            const layout = this.packDrawLayout(img, w, h)
            const { x, dw, dh } = layout
            let packY = layout.y
            let tearT = 0
            const falling = elapsed >= TEAR_MS

            if (!falling) {
              // Sealed phase: solid cover so prize cannot show
              ctx.fillStyle = '#0a0614'
              ctx.fillRect(0, 0, w, h)
              tearT = Math.min(1, elapsed / TEAR_MS)
              tearT = 1 - (1 - tearT) * (1 - tearT)
            } else {
              // Falling: transparent canvas except opaque pack plate
              if (!revealed) {
                this.packStageEl.classList.add('is-revealed')
                revealed = true
              }
              const fallT = Math.min(1, (elapsed - TEAR_MS) / FALL_MS)
              const eased = fallT * fallT
              packY = layout.y + eased * (h + dh * 0.2)
              tearT = 1
            }

            // Solid backplate under pack art (covers prize wherever the pack is)
            ctx.globalAlpha = 1
            ctx.fillStyle = '#0a0614'
            const platePad = 6
            ctx.fillRect(x - platePad, packY - platePad, dw + platePad * 2, dh + platePad * 2)
            ctx.drawImage(img, x, packY, dw, dh)

            // Horizontal jagged tear near top of pack (during tear phase)
            if (tearT > 0.02 && elapsed < TEAR_MS + 60) {
              const tearY = packY + dh * 0.12
              const tearW = dw * tearT
              const segs = 20
              ctx.beginPath()
              ctx.moveTo(x, tearY)
              for (let i = 1; i <= segs; i++) {
                const px = x + (tearW * i) / segs
                const jag = (i % 2 === 0 ? 1 : -1) * (2 + (i % 3))
                ctx.lineTo(px, tearY + jag)
              }
              ctx.strokeStyle = 'rgba(255,255,255,0.95)'
              ctx.lineWidth = 2.4
              ctx.lineCap = 'round'
              ctx.shadowColor = 'rgba(255,255,255,0.75)'
              ctx.shadowBlur = 10
              ctx.stroke()
              ctx.shadowBlur = 0
              ctx.beginPath()
              ctx.moveTo(x, tearY + 2.5)
              for (let i = 1; i <= segs; i++) {
                const px = x + (tearW * i) / segs
                const jag = (i % 2 === 0 ? 1 : -1) * (2 + (i % 3))
                ctx.lineTo(px, tearY + jag + 2.5)
              }
              ctx.strokeStyle = 'rgba(0,0,0,0.5)'
              ctx.lineWidth = 1.6
              ctx.stroke()
            }

            if (elapsed < TOTAL) {
              this.packAnimRaf = requestAnimationFrame(frame)
            } else {
              ctx.clearRect(0, 0, w, h)
              this.packCanvas.hidden = true
              this.packStageEl.classList.remove('is-tearing')
              this.packStageEl.classList.add('is-revealed')
              this.packPhase = 'revealed'
              this.packAnimRaf = 0
              resolve()
            }
          }

          this.packAnimRaf = requestAnimationFrame(frame)
        })
        .catch(reject)
    })
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

  /** Force-dismiss claim/sign modal (success path must never leave it up). */
  private dismissSignOverlay(): void {
    this.steps = []
    hideLootBagSignOverlay()
    this.stepsEl.hidden = true
    this.stepsEl.innerHTML = ''
  }

  private setBusy(on: boolean): void {
    this.busy = on
    this.claimBtn.disabled = on || this.claiming || this.packPhase === 'tearing'
    this.depositBtn.disabled = on
    this.refreshBtn.disabled = on
    this.claimableChipBtn.disabled = on || this.claiming
    this.settleKeepBtn.disabled = on
    this.settleTakeBtn.disabled = on
    this.root.classList.toggle('is-busy', on)
    // Always drop the overlay when work ends with no in-flight / error steps
    if (!on) {
      const inFlight = this.steps.some((s) => s.status === 'active' || s.status === 'error')
      if (!inFlight) this.dismissSignOverlay()
    }
    if (this.mode === 'deposit') this.renderDepositView()
    if (!this.feesModalEl.hidden) this.syncFeesModal()
    this.winModal
      .querySelectorAll<HTMLButtonElement>('[data-settle-keep], [data-settle-take]')
      .forEach((b) => {
        b.disabled = on
      })
  }

  private setMode(mode: ViewMode): void {
    this.mode = mode
    this.root.classList.toggle('is-deposit-mode', mode === 'deposit')
    this.playBodyEl.hidden = mode !== 'play'
    this.depositBodyEl.hidden = mode !== 'deposit'
    if (mode === 'deposit') {
      this.marqueeEl.textContent = 'Deposit to Loot Bag'
      this.renderDepositView()
    } else {
      this.marqueeEl.textContent = this.pendingWin ? 'Loot Pack ready to settle' : 'Loot Bag'
    }
  }

  private openDeposit(): void {
    if (this.busy || this.claiming) return
    this.error = null
    this.depositSource = 'wallet'
    this.syncInventoryFromWallet()
    const owned = new Set(this.inventory.map((i) => i.id))
    this.selections = this.selections.filter((s) => owned.has(s.item.id))
    this.invSearch = ''
    this.setMode('deposit')
  }

  private closeDeposit(): void {
    if (this.busy) return
    this.setMode('play')
    this.renderStatus()
  }

  private syncInventoryFromWallet(): void {
    this.inventory = walletNftsToInventory(this.wallet?.ownedNfts ?? [])
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
        this.status =
          this.pool.positions.length > 0 || this.pool.activeCount > 0n
            ? this.pendingWin
              ? this.status
              : ''
            : 'Empty Loot Bag — deposit a wearable or MANA pack to fill the Loot Bag'
        this.renderStatus()
      } else {
        this.renderDepositView()
      }
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e)
      this.renderStatus()
      if (this.mode === 'play') {
        this.shelfEl.innerHTML = `<div class="lootbag__error">${escapeHtml(this.error)}</div>`
      }
    }
  }

  private renderHud(): void {
    this.feeEl.textContent = this.pool ? `${formatMana(this.pool.acquisitionFee)} mMANA` : '—'
    this.balEl.textContent = this.wallet ? `(${formatMana(this.wallet.mana)} mMANA)` : ''
    const claimable = this.wallet?.claimable ?? 0n
    // Amount lives in the centered Rewards modal — button is label-only
    this.claimableChipBtn.classList.toggle('has-balance', claimable > 0n)
    // Prefer on-chain activeCount (truth); fall back to loaded shelf rows
    const n =
      this.pool != null
        ? Math.max(Number(this.pool.activeCount), this.pool.positions.length)
        : 0
    this.poolCountEl.textContent = n === 1 ? '1 item' : `${n} items`
    // Keep fees modal amount in sync if open
    if (!this.feesModalEl.hidden) this.syncFeesModal()
  }

  private openFeesModal(): void {
    if (this.busy || this.claiming) return
    this.syncFeesModal()
    this.feesModalEl.hidden = false
    document.documentElement.classList.add('lootbag-fees-open')
  }

  private closeFeesModal(): void {
    this.feesModalEl.hidden = true
    document.documentElement.classList.remove('lootbag-fees-open')
    const err = this.feesModalEl.querySelector('[data-fees-error]') as HTMLElement | null
    if (err) {
      err.hidden = true
      err.textContent = ''
    }
  }

  private syncFeesModal(): void {
    const amountEl = this.feesModalEl.querySelector('[data-fees-amount]') as HTMLElement | null
    const withdrawBtn = this.feesModalEl.querySelector(
      '[data-fees-withdraw]'
    ) as HTMLButtonElement | null
    const claimable = this.wallet?.claimable ?? 0n
    if (amountEl) {
      amountEl.textContent = this.wallet
        ? `${formatMana(claimable)} mMANA claimable`
        : 'Connect a wallet to see rewards'
    }
    if (withdrawBtn) {
      withdrawBtn.disabled = this.busy || !this.wallet || claimable <= 0n
      withdrawBtn.textContent =
        claimable > 0n ? 'Withdraw rewards' : 'Nothing to withdraw yet'
    }
  }

  private async onFeesModalClick(ev: MouseEvent): Promise<void> {
    const t = ev.target as HTMLElement
    if (t.closest('[data-fees-close]')) {
      this.closeFeesModal()
      return
    }
    if (t.closest('[data-fees-withdraw]')) {
      await this.onWithdrawFees()
    }
  }

  private async onWithdrawFees(): Promise<void> {
    if (this.busy || this.claiming) return
    if (!this.addr()) {
      this.setFeesModalError('Connect a wallet to withdraw')
      return
    }
    const claimable = this.wallet?.claimable ?? 0n
    if (claimable <= 0n) {
      this.setFeesModalError('No loot to withdraw yet')
      return
    }

    this.setBusy(true)
    this.error = null
    this.steps = []
    this.stepSeq = 0
    this.setFeesModalError(null)
    this.renderSteps()
    try {
      await runWithdrawRewards({
        sessionAddress: this.addr(),
        api: this.flowApi()
      })
      this.steps = []
      hideLootBagSignOverlay()
      await this.refresh()
      this.setBusy(false)
      this.closeFeesModal()
      await showLootBagSuccessOverlay({
        title: 'Fees withdrawn!',
        message: `${formatMana(claimable)} mMANA sent to your wallet.`,
        buttonLabel: 'Back to Loot Bag'
      })
      this.status = 'Rewards withdrawn'
      this.renderStatus()
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      this.setFeesModalError(msg)
      this.error = msg
      this.renderStatus()
      this.renderSteps()
      this.setBusy(false)
    }
  }

  private setFeesModalError(msg: string | null): void {
    const err = this.feesModalEl.querySelector('[data-fees-error]') as HTMLElement | null
    if (!err) return
    if (!msg) {
      err.hidden = true
      err.textContent = ''
      return
    }
    err.hidden = false
    err.textContent = msg
  }

  // ── Display shelf ─────────────────────────────────────────────────────────

  private renderShelfLoading(): void {
    this.shelfEl.classList.add('is-empty', 'is-loading')
    this.shelfEl.innerHTML = shelfLoadingHtml('Opening the Loot Bag…')
  }

  private renderShelf(positions: LootBagPosition[], opts?: { scrollToEnd?: boolean }): void {
    this.shelfEl.innerHTML = ''
    this.shelfEl.classList.toggle('is-empty', positions.length === 0)
    this.shelfEl.classList.remove('is-loading')

    if (positions.length === 0) {
      this.shelfEl.innerHTML = `
        <div class="lootbag-vitrine__empty">
          <div class="lootbag-vitrine__empty-icon" aria-hidden="true">◈</div>
          <p class="lootbag-vitrine__empty-title">Loot Bag is empty</p>
          <p class="lootbag-vitrine__empty-hint">Deposit a wearable or MANA pack to fill the Loot Bag</p>
          <p class="lootbag-vitrine__empty-hint lootbag-vitrine__empty-hint--soft">Weighted chance shows once items are in the Loot Bag</p>
        </div>`
      return
    }

    // positions are oldest → newest; new deposits sit at the end
    const chances = computeClaimChanceLabels(positions)
    const track = document.createElement('div')
    track.className = 'lootbag-vitrine__track'
    for (const p of positions) {
      track.appendChild(this.makeShelfCard(p, chances.get(p.positionId) ?? '—'))
    }
    this.shelfEl.appendChild(track)

    // Scroll highlighted card into view after claim, else jump to newest (bottom of grid)
    requestAnimationFrame(() => {
      if (this.highlightPosId != null) {
        const card = this.shelfEl.querySelector(
          `[data-pos="${this.highlightPosId}"]`
        ) as HTMLElement | null
        card?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' })
        return
      }
      if (opts?.scrollToEnd) {
        this.shelfEl.scrollTo({ top: this.shelfEl.scrollHeight, behavior: 'smooth' })
      }
    })
  }

  private makeShelfCard(p: LootBagPosition, chanceLabel: string): HTMLElement {
    const el = document.createElement('article')
    const isPack = p.kind === 'manaPack'
    const lit = this.highlightPosId === p.positionId
    const rarity = isPack ? 'legendary' : (p.rarity || 'common').toLowerCase()
    el.className = `lootbag-vitrine__card${isPack ? ' is-pack' : ''}${lit ? ' is-spotlight' : ''} lootbag-rarity--${rarity}`
    el.dataset.pos = String(p.positionId)
    el.dataset.rarity = rarity
    const glyph = isPack ? '◈' : '✦'
    const img = p.imageUrl
      ? `<img class="lootbag-vitrine__card-img" src="${escapeHtml(p.imageUrl)}" alt="" loading="lazy" decoding="async" />`
      : `<div class="lootbag-vitrine__card-glyph" aria-hidden="true">${glyph}</div>`
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
      <div class="lootbag-vitrine__card-art lootbag-rarity-bg--${escapeHtml(rarity)}">${img}</div>
      <div class="lootbag-vitrine__card-body">
        <div class="lootbag-vitrine__card-line lootbag-vitrine__card-line--title" title="${escapeHtml(title)}">${escapeHtml(title)}</div>
        <div class="lootbag-vitrine__card-line">${escapeHtml(detail)}</div>
        <div class="lootbag-vitrine__card-line lootbag-vitrine__card-line--rarity is-${escapeHtml(rarity)}">${escapeHtml(rarityLabel)}</div>
        <div class="lootbag-vitrine__card-line">${escapeHtml(backing)}</div>
        <div class="lootbag-vitrine__card-line lootbag-vitrine__card-line--chance">${chance}</div>
      </div>
    `
    return el
  }

  // ── Deposit view ──────────────────────────────────────────────────────────

  private renderCreatorDepositHtml(balLabel: string, tabs: string): string {
    const count = Math.max(0, Math.floor(Number(this.stockMintCount) || 0))
    const avg = Number(this.stockAvgBacking) || 0
    const lockEst = this.stockItem && count > 0 && avg > 0 ? formatManaDisplay(count * avg) : '0'
    const browsingItems = this.creatorBrowse === 'items'
    const gridList = browsingItems ? this.creatorItems : this.creatorCollections

    const selBlock = !this.stockItem
      ? `<p class="lootbag-dep__empty">Pick a collection, then an item →</p>`
      : `
        <div class="lootbag-dep__stock-card">
          <button type="button" class="lootbag-dep__stock-clear" data-stock-clear aria-label="Clear selection" ${this.busy ? 'disabled' : ''}>×</button>
          <div class="lootbag-dep__stock-top">
            <div class="lootbag-dep__stock-thumb lootbag-dep__thumb--${escapeHtml(this.stockItem.rarity)}">
              ${
                this.stockItem.thumbnail
                  ? `<img src="${escapeHtml(this.stockItem.thumbnail)}" alt="" loading="lazy" decoding="async" />`
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
        : `<div class="lootbag-dep__empty lootbag-dep__empty--center">No Polygon collections for this wallet<br/><span class="lootbag-dep__creator-note">Indexed via marketplace (published Collection V2)</span></div>`
    } else {
      const parts: string[] = []
      for (const row of gridList) {
        if (browsingItems) {
          const it = row as CreatorCollectionItem
          const on =
            this.stockItem?.contractAddress === it.contractAddress &&
            this.stockItem?.itemId === it.itemId
          const avail = it.available != null ? `${it.available} left` : `Item #${it.itemId}`
          const rarity = (it.rarity || 'common').toLowerCase()
          const art = it.thumbnail
            ? `<img class="lootbag-vitrine__card-img" src="${escapeHtml(it.thumbnail)}" alt="" loading="lazy" decoding="async" />`
            : `<div class="lootbag-vitrine__card-glyph" aria-hidden="true">✦</div>`
          parts.push(`
            <button type="button" class="lootbag-vitrine__card lootbag-dep__pick${on ? ' is-selected' : ''} lootbag-rarity--${escapeHtml(rarity)}" data-creator-item="${it.itemId}" ${this.busy ? 'disabled' : ''}>
              <div class="lootbag-vitrine__card-art lootbag-rarity-bg--${escapeHtml(rarity)}">${art}</div>
              <div class="lootbag-vitrine__card-body">
                <div class="lootbag-vitrine__card-line lootbag-vitrine__card-line--title" title="${escapeHtml(it.name)}">${escapeHtml(it.name)}</div>
                <div class="lootbag-vitrine__card-line">${escapeHtml(avail)}</div>
                <div class="lootbag-vitrine__card-line lootbag-vitrine__card-line--rarity is-${escapeHtml(rarity)}">${escapeHtml(rarity)}</div>
              </div>
            </button>`)
        } else {
          const col = row as CreatorCollection
          const on =
            this.selectedCreatorCollection?.contractAddress === col.contractAddress
          const art = col.thumbnail
            ? `<img class="lootbag-vitrine__card-img" src="${escapeHtml(col.thumbnail)}" alt="" loading="lazy" decoding="async" />`
            : `<div class="lootbag-vitrine__card-glyph" aria-hidden="true">COL</div>`
          parts.push(`
            <button type="button" class="lootbag-vitrine__card lootbag-dep__pick${on ? ' is-selected' : ''} lootbag-rarity--epic" data-creator-col="${escapeHtml(col.contractAddress)}" ${this.busy ? 'disabled' : ''}>
              <div class="lootbag-vitrine__card-art lootbag-rarity-bg--epic">${art}</div>
              <div class="lootbag-vitrine__card-body">
                <div class="lootbag-vitrine__card-line lootbag-vitrine__card-line--title" title="${escapeHtml(col.name)}">${escapeHtml(col.name)}</div>
                <div class="lootbag-vitrine__card-line">${col.size} item${col.size === 1 ? '' : 's'}</div>
                <div class="lootbag-vitrine__card-line">${escapeHtml(shortAddr(col.contractAddress))}</div>
              </div>
            </button>`)
        }
      }
      cells = parts.join('')
    }

    const invTitle = browsingItems
      ? `${this.selectedCreatorCollection?.name ?? 'Items'} · ${this.creatorItems.length}`
      : `Your collections · ${this.creatorCollections.length}`
    const upBtn = browsingItems
      ? `<button type="button" class="lootbag-dep__up-btn" data-creator-up ${this.busy ? 'disabled' : ''} title="Back to collections">↑ Collections</button>`
      : ''

    // Same shell as play: lootbag__columns · col--bag (2/3) · col--pack (1/3)
    return `
      <div class="lootbag__columns lootbag-dep lootbag-dep--creator">
        <section class="lootbag__col lootbag__col--bag" aria-label="Creator collection">
          <div class="lootbag__hud lootbag__hud--deposit">
            <div class="lootbag__hud-left">
              <h1 class="lootbag__title">Add Loot</h1>
              <button type="button" class="lootbag__btn lootbag__btn--ghost lootbag-dep__back" data-dep-back ${this.busy ? 'disabled' : ''}>← Back</button>
            </div>
            <div class="lootbag__hud-center">
              <span class="lootbag-dep__stat lootbag-dep__stat--ok">${escapeHtml(balLabel)} mMANA</span>
            </div>
            <div class="lootbag__hud-right">${tabs}</div>
          </div>
          <div class="lootbag-dep__inv-head">
            <h3 class="lootbag-dep__section-title">${escapeHtml(invTitle)}</h3>
            ${upBtn}
          </div>
          <div class="lootbag-vitrine__track lootbag-dep__track">${cells}</div>
          ${
            this.error || (this.status && this.mode === 'deposit')
              ? `<p class="lootbag__status is-error">${escapeHtml(this.error || this.status)}</p>`
              : ''
          }
        </section>

        <section class="lootbag__col lootbag__col--pack" aria-label="To stock">
          <div class="lootbag__pack-cost">
            <span class="lootbag__pack-cost-label">To stock</span>
            <div class="lootbag__pack-cost-row">
              <span class="lootbag__pack-cost-value">Lock ~${escapeHtml(lockEst)}</span>
              <span class="lootbag__pack-cost-bal">mMANA</span>
            </div>
          </div>
          <div class="lootbag-dep__list lootbag-dep__list--fill">${selBlock}</div>
          <div class="lootbag__col-actions">
            <button type="button" class="lootbag__btn lootbag__btn--claim lootbag-dep__confirm" data-stock-confirm ${this.busy || !this.stockItem ? 'disabled' : ''}>
              <span class="lootbag__claim-label">Stock into Loot Bag</span>
            </button>
          </div>
        </section>
        <div class="lootbag__steps lootbag-dep__steps" data-dep-steps ${this.steps.length && this.mode === 'deposit' ? '' : 'hidden'}></div>
      </div>`
  }

  private renderDepositView(): void {
    const balLabel = this.wallet ? formatMana(this.wallet.mana) : '—'
    const tabs = `
      <div class="lootbag-dep__tabs lootbag-dep__tabs--header" role="tablist">
        <button type="button" class="lootbag-dep__tab${this.depositSource === 'wallet' ? ' is-active' : ''}" data-dep-source="wallet" ${this.busy ? 'disabled' : ''}>Your wallet</button>
        <button type="button" class="lootbag-dep__tab${this.depositSource === 'creator' ? ' is-active' : ''}" data-dep-source="creator" ${this.busy ? 'disabled' : ''}>Creator collection</button>
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
    const filtered = filterInv(this.inventory, this.invSearch)
    const invTotal = filtered.length
    const selectedIds = new Set(this.selections.map((s) => s.item.id))
    const totalLock = this.totalLockMana()
    const packCount = this.selections.filter((s) => this.isPackSel(s)).length
    const nftSelCount = this.selections.length - packCount
    const selectedLabel =
      this.selections.length === 0
        ? 'Selected: 0'
        : `Selected: ${nftSelCount ? `${nftSelCount} NFT` : ''}${nftSelCount && packCount ? ' · ' : ''}${packCount ? `${packCount} pack` : ''}`
    const searchLabel = this.invSearch.trim()
      ? `${invTotal} match${invTotal === 1 ? '' : 'es'}`
      : `${nftCount} NFT${nftCount === 1 ? '' : 's'} + pack`

    const selRows =
      this.selections.length === 0
        ? `<p class="lootbag-dep__empty">${
            nftCount === 0
              ? 'No Polygon wearables in this wallet · use Creator collection to mint, or buy Collection V2 items'
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
              const issuePill = sel.item.issuedId
                ? `<span class="lootbag-dep__pill">Issue #${escapeHtml(sel.item.issuedId)}</span>`
                : ''
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
                <a class="lootbag-dep__pill lootbag-dep__pill--view" href="${escapeHtml(marketUrl)}" target="_blank" rel="noopener noreferrer" title="Token #${escapeHtml(sel.item.tokenId)}">View</a>
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

    // Same card chrome as main Loot Bag shelf (lootbag-vitrine__*) — full grid, images lazy-load
    const cells: string[] = []
    for (const item of filtered) {
      const on = selectedIds.has(item.id)
      const isPack = item.kind === 'pack'
      const rarity = isPack ? 'legendary' : (item.rarity || 'common').toLowerCase()
      const glyph = isPack ? '◈' : '✦'
      const img = item.imageUrl && !isPack
        ? `<img class="lootbag-vitrine__card-img" src="${escapeHtml(item.imageUrl)}" alt="" loading="lazy" decoding="async" />`
        : `<div class="lootbag-vitrine__card-glyph" aria-hidden="true">${glyph}</div>`
      const detail = isPack
        ? 'Always available'
        : item.issuedId
          ? `Issue #${escapeHtml(item.issuedId)}`
          : `Token #${escapeHtml(item.tokenId)}`
      const rarityLabel = isPack ? 'pack' : rarity
      cells.push(`
        <button type="button" class="lootbag-vitrine__card lootbag-dep__pick${on ? ' is-selected' : ''}${isPack ? ' is-pack' : ''} lootbag-rarity--${escapeHtml(rarity)}" data-pick="${escapeHtml(item.id)}" ${this.busy ? 'disabled' : ''}>
          <div class="lootbag-vitrine__card-art lootbag-rarity-bg--${escapeHtml(rarity)}">${img}</div>
          <div class="lootbag-vitrine__card-body">
            <div class="lootbag-vitrine__card-line lootbag-vitrine__card-line--title" title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</div>
            <div class="lootbag-vitrine__card-line">${detail}</div>
            <div class="lootbag-vitrine__card-line lootbag-vitrine__card-line--rarity is-${escapeHtml(rarity)}">${escapeHtml(rarityLabel)}</div>
          </div>
        </button>`)
    }

    // Same shell as play: lootbag__columns · col--bag (2/3) · col--pack (1/3)
    this.depositBodyEl.innerHTML = `
      <div class="lootbag__columns lootbag-dep">
        <section class="lootbag__col lootbag__col--bag" aria-label="Inventory">
          <div class="lootbag__hud lootbag__hud--deposit">
            <div class="lootbag__hud-left">
              <h1 class="lootbag__title">Add Loot</h1>
              <button type="button" class="lootbag__btn lootbag__btn--ghost lootbag-dep__back" data-dep-back ${this.busy ? 'disabled' : ''}>← Back</button>
            </div>
            <div class="lootbag__hud-center">
              <span class="lootbag-dep__stat lootbag-dep__stat--ok">${escapeHtml(balLabel)} mMANA</span>
            </div>
            <div class="lootbag__hud-right">${tabs}</div>
          </div>
          <div class="lootbag-dep__inv-head">
            <h3 class="lootbag-dep__section-title">Inventory · ${escapeHtml(searchLabel)} · A–Z</h3>
          </div>
          <div class="lootbag-dep__search-row">
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
          </div>
          <div class="lootbag-vitrine__track lootbag-dep__track">${
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
          ${
            this.error || (this.status && this.mode === 'deposit')
              ? `<p class="lootbag__status is-error">${escapeHtml(this.error || this.status)}</p>`
              : ''
          }
        </section>

        <section class="lootbag__col lootbag__col--pack" aria-label="To deposit">
          <div class="lootbag__pack-cost">
            <span class="lootbag__pack-cost-label">To deposit</span>
            <div class="lootbag__pack-cost-row">
              <span class="lootbag__pack-cost-value">Lock ${escapeHtml(formatManaDisplay(totalLock))}</span>
              <span class="lootbag__pack-cost-bal">mMANA · ${escapeHtml(selectedLabel)}</span>
            </div>
          </div>
          <div class="lootbag-dep__list lootbag-dep__list--fill">${selRows}</div>
          <div class="lootbag__col-actions">
            <button type="button" class="lootbag__btn lootbag__btn--claim lootbag-dep__confirm" data-dep-confirm ${this.busy || this.selections.length === 0 ? 'disabled' : ''}>
              <span class="lootbag__claim-label">Confirm deposit${this.selections.length ? ` (${this.selections.length})` : ''}</span>
            </button>
          </div>
        </section>
        <div class="lootbag__steps lootbag-dep__steps" data-dep-steps ${this.steps.length && this.mode === 'deposit' ? '' : 'hidden'}></div>
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
    return `<ol class="lootbag__step-list">${this.steps
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
      this.renderDepositView()
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
        this.renderDepositView()
      }
      return
    }
    if (t.closest('[data-stock-clear]')) {
      this.stockItem = null
      this.stockDepositor = ''
      this.renderDepositView()
      return
    }
    if (t.closest('[data-stock-confirm]')) {
      void this.confirmStockFromCollection()
      return
    }
    if (t.closest('[data-inv-search-clear]')) {
      this.invSearch = ''
      this.renderDepositView()
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
    if ('invSearch' in input.dataset) {
      this.invSearch = input.value
      this.renderDepositView()
      const el = this.depositBodyEl.querySelector('[data-inv-search]') as HTMLInputElement | null
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
      this.updateCreatorLockStat()
      return
    }
    if ('stockBacking' in input.dataset) {
      this.stockAvgBacking = input.value
      this.updateCreatorLockStat()
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
    } else if (backingId) {
      this.selections = this.selections.map((s) =>
        s.item.id === backingId ? { ...s, backingMana: input.value } : s
      )
    } else {
      return
    }
    const gold = this.depositBodyEl.querySelector('.lootbag-dep__stat--gold')
    if (gold) gold.textContent = `Lock: ${formatManaDisplay(this.totalLockMana())} mMANA`
  }

  private updateCreatorLockStat(): void {
    const gold = this.depositBodyEl.querySelector('.lootbag-dep__stat--gold')
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

  /** Prefill depositor with on-chain collection.creator() when available. */
  private async defaultStockDepositorFor(collection: string): Promise<void> {
    const fallback = this.addr()?.toLowerCase() ?? ''
    this.stockDepositor = fallback
    try {
      const st = await getCollectionMinterStatus(collection, { account: this.addr() })
      if (st.creator) this.stockDepositor = st.creator
    } catch {
      /* keep wallet fallback */
    }
    if (this.mode === 'deposit' && this.depositSource === 'creator' && this.stockItem) {
      this.renderDepositView()
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
    const dep = this.stockDepositor.trim()
    if (dep && !/^0x[a-fA-F0-9]{40}$/.test(dep)) {
      this.error = 'Depositor must be a valid 0x wallet address'
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
        depositor: dep || this.addr(),
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
      this.setMode('play')
      this.status = `Stocked ${mintCount} into Loot Bag`
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
      this.setMode('play')
      this.status = 'Deposits locked in — Loot Bag refreshed'
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
      this.statusEl.className = 'lootbag__status is-error'
      this.statusEl.textContent = this.error
      return
    }
    this.statusEl.className = 'lootbag__status'
    this.statusEl.textContent = this.status
  }

  private renderSteps(): void {
    // Centered viewport overlay for sign / meta-tx (2D + 3D).
    // ONLY while a step is active or errored — never leave a "all Done / Working…" corpse.
    const active = this.steps.find((s) => s.status === 'active')
    const errored = this.steps.find((s) => s.status === 'error')
    const showOverlay = this.steps.length > 0 && (active != null || errored != null)

    if (showOverlay) {
      const title =
        this.mode === 'deposit'
          ? this.depositSource === 'creator'
            ? 'Stock into Loot Bag'
            : 'Deposit to Loot Bag'
          : this.claiming ||
              this.steps.some((s) => /open loot pack|claim|pack cost|mMANA for pack/i.test(s.label))
            ? 'Claim Loot Pack'
            : this.steps.some((s) => /keep your prize|take the mana|settle/i.test(s.label)) ||
                this.pendingWin
              ? 'Settle claim'
              : this.steps.some((s) => /collect your rewards|withdraw|grab fees|your loot/i.test(s.label))
                ? 'Collect rewards'
                : 'Loot Bag'
      const statusLine =
        active != null
          ? active.detail?.trim() || 'Confirm in your wallet…'
          : errored != null
            ? errored.detail?.trim() || 'Something went wrong'
            : 'Working…'
      const fee = this.pool ? formatMana(this.pool.acquisitionFee) : '—'
      const bal = this.wallet ? formatMana(this.wallet.mana) : '—'
      const manaMeta = `Pack cost ${fee} mMANA | Balance ${bal}`
      const showManaMeta =
        this.mode !== 'deposit' &&
        (this.claiming ||
          this.pendingWin != null ||
          this.steps.some((s) =>
            /open loot pack|claim|pack cost|mMANA for pack|keep your prize|take the mana|settle/i.test(
              s.label
            )
          ))
      syncLootBagSignOverlay({
        title,
        status: statusLine,
        meta: showManaMeta ? manaMeta : undefined,
        steps: this.steps
      })
    } else {
      hideLootBagSignOverlay()
    }

    // Inline list only for play while something is in-flight; deposit uses overlay only.
    const host = this.depositBodyEl.querySelector('[data-dep-steps]') as HTMLElement | null
    if (host) {
      host.hidden = true
      host.innerHTML = ''
    }
    if (!showOverlay) {
      this.stepsEl.hidden = true
      this.stepsEl.innerHTML = ''
      return
    }
    this.stepsEl.hidden = this.mode !== 'play'
    this.stepsEl.innerHTML = this.mode === 'play' ? this.buildStepsHtml() : ''
  }

  private closeWinModal(opts: { clearPending: boolean }): void {
    this.winModal.hidden = true
    document.documentElement.classList.remove('lootbag-win-open')
    const card = this.winModal.querySelector('[data-win-card]')
    if (card) card.innerHTML = ''
    if (opts.clearPending) {
      this.pendingWin = null
    }
  }

  private async onWinModalClick(ev: MouseEvent): Promise<void> {
    const t = ev.target as HTMLElement
    if (t.closest('[data-win-close]') || t.closest('[data-win-backdrop]')) {
      // Keep pending win so user can reopen settle after refresh if needed
      this.closeWinModal({ clearPending: false })
      if (this.pendingWin) {
        this.status = `Claim pending settle · pos #${this.pendingWin.positionId} — claim again to reopen`
        this.renderStatus()
      }
      return
    }
    if (t.closest('[data-settle-keep]')) await this.runSettle(true)
    else if (t.closest('[data-settle-take]')) await this.runSettle(false)
  }

  private resetPackStage(): void {
    if (this.packAnimRaf) {
      cancelAnimationFrame(this.packAnimRaf)
      this.packAnimRaf = 0
    }
    this.packPhase = 'idle'
    this.packStageEl.classList.remove('is-tearing', 'is-revealed')
    this.packPrizeEl.innerHTML = ''
    this.packPrizeEl.hidden = true
    this.claimBtn.hidden = false
    this.settleKeepBtn.hidden = true
    this.settleTakeBtn.hidden = true
    this.settleKeepBtn.textContent = 'Keep NFT'
    this.settleTakeBtn.innerHTML = '<span class="lootbag__claim-label">Take tokens</span>'
    this.settleTakeBtn.removeAttribute('title')
    this.drawPackIdle()
  }

  /** Net MANA received if you Take tokens (backing × depositorBidRateBps, default 85%). */
  private takeTokensAmount(win: PendingWin | null): bigint {
    const backing = win?.position?.backing ?? 0n
    return takeTokensNetWei(backing, this.pool?.depositorBidRateBps)
  }

  private renderPackPrize(win: PendingWin): void {
    const p = win.position
    const isPack = p?.kind === 'manaPack'
    const rarity = normalizeRarityClass(isPack ? 'legendary' : p?.rarity)
    const title = p
      ? isPack
        ? 'MANA Pack'
        : p.name?.trim() || (p.issuedId ? `Issue #${p.issuedId}` : `Token #${p.tokenId}`)
      : `Position #${win.positionId}`
    const detail = p
      ? isPack
        ? `Prize ${formatMana(p.packMana)} mMANA`
        : p.issuedId
          ? `Issue #${p.issuedId}`
          : `Token #${p.tokenId}`
      : ''
    const backingLabel = p ? `Backed by ${formatMana(p.backing)} mMANA` : ''
    const art =
      p?.imageUrl && !isPack
        ? `<img class="lootbag-pack-stage__prize-img" src="${escapeHtml(p.imageUrl)}" alt="" />`
        : `<div class="lootbag-pack-stage__prize-glyph" aria-hidden="true">${isPack ? '◈' : '✦'}</div>`
    this.packPrizeEl.innerHTML = `
      <div class="lootbag-pack-stage__prize-art lootbag-rarity-bg--${escapeHtml(rarity)}" data-rarity="${escapeHtml(rarity)}">${art}</div>
      <div class="lootbag-pack-stage__prize-name">${escapeHtml(title)}</div>
      ${detail ? `<div class="lootbag-pack-stage__prize-detail">${escapeHtml(detail)}</div>` : ''}
      <div class="lootbag-pack-stage__prize-rarity lootbag-vitrine__card-line--rarity is-${escapeHtml(rarity)}">${escapeHtml(isPack ? 'pack' : rarity)}</div>
      ${
        backingLabel
          ? `<div class="lootbag-pack-stage__prize-backing">${escapeHtml(backingLabel)}</div>`
          : ''
      }
    `
    this.packPrizeEl.hidden = false
    this.updateSettleButtonLabels(win)
  }

  private updateSettleButtonLabels(win: PendingWin | null): void {
    const isPack = win?.position?.kind === 'manaPack'
    this.settleKeepBtn.textContent = isPack ? 'Keep prize' : 'Keep NFT'
    const takeAmt = this.takeTokensAmount(win)
    const takeLabel =
      takeAmt > 0n
        ? `Take tokens · ${formatMana(takeAmt)} mMANA`
        : 'Take tokens'
    this.settleTakeBtn.innerHTML = `<span class="lootbag__claim-label">${escapeHtml(takeLabel)}</span>`
    const bidPct = Math.round((this.pool?.depositorBidRateBps ?? 8500) / 100)
    this.settleTakeBtn.title =
      takeAmt > 0n
        ? `Net ${formatMana(takeAmt)} mMANA (${bidPct}% of backing after protocol cut) instead of the item`
        : 'Take the MANA bid instead of the item'
  }

  private showSettleActions(): void {
    this.updateSettleButtonLabels(this.pendingWin)
    this.claimBtn.hidden = true
    this.settleKeepBtn.hidden = false
    this.settleTakeBtn.hidden = false
  }

  private async onClaim(): Promise<void> {
    if (this.busy || this.claiming || this.mode !== 'play') return
    if (this.packPhase === 'revealed' && this.pendingWin) {
      this.showSettleActions()
      return
    }
    if (this.packPhase !== 'idle') return

    if (!this.addr()) {
      this.error = 'Connect a wallet to claim a Loot Pack'
      this.renderStatus()
      return
    }
    if (!this.pool || this.pool.activeCount === 0n || (this.pool.positions?.length ?? 0) === 0) {
      this.error = 'Empty Loot Bag — deposit first'
      this.renderStatus()
      return
    }

    this.setBusy(true)
    this.claiming = true
    this.error = null
    this.closeWinModal({ clearPending: true })
    this.pendingWin = null
    this.highlightPosId = null
    this.steps = []
    this.stepSeq = 0
    this.renderSteps()
    this.marqueeEl.textContent = 'Claiming Loot Pack…'
    this.root.classList.add('is-claiming')
    this.status = 'Claiming from Loot Bag…'
    this.renderStatus()
    this.claimBtn.disabled = true
    this.claimBtn.hidden = true
    this.settleKeepBtn.hidden = true
    this.settleTakeBtn.hidden = true

    try {
      // Shelf still has marketplace rarity/name for the item about to leave the active pool
      const shelfBefore = this.pool?.positions ?? []
      const { win } = await runPull({
        sessionAddress: this.addr(),
        acquisitionFee: this.pool.acquisitionFee,
        api: this.flowApi()
      })

      // ALWAYS kill the sign modal the instant open-tx flow returns
      this.dismissSignOverlay()
      this.claiming = false

      this.highlightPosId = win?.positionId ?? null
      const keepHi = this.highlightPosId
      await this.refresh()
      this.highlightPosId = keepHi
      this.renderShelf(this.pool?.positions ?? [])

      if (!win) {
        this.marqueeEl.textContent = 'Loot Bag'
        this.status = 'Claim confirmed'
        this.renderStatus()
        this.resetPackStage()
        return
      }

      // Prefer pre-claim shelf metadata (rarity/name/thumb). After pull the position is
      // usually inactive and gone from the refreshed active shelf.
      const fromShelfBefore = shelfBefore.find((p) => p.positionId === win.positionId) ?? null
      const fromShelfAfter =
        this.pool?.positions.find((p) => p.positionId === win.positionId) ?? null
      const merged = mergeWinPosition(win.position, fromShelfBefore, fromShelfAfter)
      const finalWin: PendingWin = { positionId: win.positionId, position: merged }
      this.pendingWin = finalWin
      this.highlightPosId = win.positionId

      this.marqueeEl.textContent = 'Opening Loot Pack…'
      this.status = `Selected pos #${win.positionId}`
      this.renderStatus()
      this.renderPackPrize(finalWin)
      await this.playPackTearAnimation()

      this.marqueeEl.textContent = 'Loot Pack ready to settle'
      this.status = `Pos #${win.positionId} — Keep NFT or Take tokens`
      this.renderStatus()
      this.showSettleActions()
      // Peer toast waits until Keep prize / Take MANA (runSettle).
    } catch (e) {
      this.marqueeEl.textContent = 'Loot Bag'
      this.error = e instanceof Error ? e.message : String(e)
      this.renderStatus()
      this.resetPackStage()
      this.pendingWin = null
      // Keep overlay only if a step is in error state; otherwise nuke it
      const hasError = this.steps.some((s) => s.status === 'error')
      if (!hasError) this.dismissSignOverlay()
    } finally {
      this.root.classList.remove('is-claiming')
      this.claiming = false
      // Belt-and-suspenders: never leave a completed claim modal up
      if (!this.steps.some((s) => s.status === 'active' || s.status === 'error')) {
        this.dismissSignOverlay()
      }
      this.setBusy(false)
      this.claimBtn.disabled = false
    }
  }

  private async runSettle(keep: boolean): Promise<void> {
    if (this.busy || !this.pendingWin) return
    this.setBusy(true)
    this.error = null
    this.steps = []
    this.stepSeq = 0
    this.renderSteps()
    try {
      const settled = this.pendingWin
      await runSettle({
        sessionAddress: this.addr(),
        positionId: settled.positionId,
        keepPrize: keep,
        api: this.flowApi()
      })
      // Peer toast only after Keep / Take succeeds
      const p = settled.position
      const isPack = p?.kind === 'manaPack'
      const manaAmount = p
        ? keep
          ? isPack && p.packMana > 0n
            ? formatMana(p.packMana)
            : null
          : p.backing > 0n
            ? formatMana(takeTokensNetWei(p.backing, this.pool?.depositorBidRateBps))
            : null
        : null
      const label = !keep
        ? manaAmount
          ? `Took ${manaAmount} mMANA`
          : 'Took MANA'
        : p
          ? isPack
            ? manaAmount
              ? `MANA Pack · ${manaAmount} mMANA`
              : 'MANA Pack'
            : p.name?.trim() || (p.issuedId ? `Issue #${p.issuedId}` : `Token #${p.tokenId}`)
          : `pos ${settled.positionId}`
      const displayName = this.login.kind === 'guest' ? this.login.displayName : null
      void publishPoolClaim({
        identity: this.login.identity,
        address: this.addr(),
        displayName,
        positionId: settled.positionId,
        label,
        demo: false,
        imageUrl: p?.imageUrl ?? null,
        rarity: isPack ? 'legendary' : (p?.rarity ?? null),
        issueId: isPack ? null : (p?.issuedId ?? null),
        itemName: isPack ? 'MANA Pack' : (p?.name?.trim() || null),
        kind: isPack ? 'pack' : 'nft',
        manaAmount,
        outcome: keep ? 'keep' : 'take'
      })
      this.dismissSignOverlay()
      this.closeWinModal({ clearPending: true })
      this.pendingWin = null
      this.highlightPosId = null
      this.marqueeEl.textContent = 'Loot Bag'
      this.status = keep ? 'Settled — prize is yours' : 'Settled — took the MANA bid'
      this.renderStatus()
      this.resetPackStage()
      await this.refresh()
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e)
      this.renderStatus()
      if (this.pendingWin) this.showSettleActions()
    } finally {
      if (!this.steps.some((s) => s.status === 'active' || s.status === 'error')) {
        this.dismissSignOverlay()
      }
      this.setBusy(false)
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

const KNOWN_RARITIES = new Set([
  'common',
  'uncommon',
  'rare',
  'epic',
  'legendary',
  'mythic',
  'unique',
  'exotic'
])

/** CSS suffix for lootbag-rarity-bg--* / is-* classes */
function normalizeRarityClass(raw?: string | null): string {
  const r = (raw || 'common').trim().toLowerCase()
  return KNOWN_RARITIES.has(r) ? r : 'common'
}

/** Merge chain win position with shelf metadata (rarity/name/image) from before/after pull. */
function mergeWinPosition(
  fromChain: LootBagPosition | null,
  fromShelfBefore: LootBagPosition | null,
  fromShelfAfter: LootBagPosition | null
): LootBagPosition | null {
  if (!fromChain && !fromShelfBefore && !fromShelfAfter) return null
  const base = fromChain ?? fromShelfBefore ?? fromShelfAfter!
  const meta = fromShelfBefore ?? fromShelfAfter
  if (!meta) return base
  return {
    ...base,
    name: base.name?.trim() || meta.name,
    rarity: base.rarity || meta.rarity,
    imageUrl: base.imageUrl || meta.imageUrl,
    itemId: base.itemId ?? meta.itemId,
    issuedId: base.issuedId ?? meta.issuedId
  }
}
