import type { Address } from 'viem'
import { formatMana, shortAddr } from '../../../lootBag/format'
import type { SessionIdentity } from '../../../network/SessionIdentity'
import {
  classifyCartSource,
  fetchCatalog,
  fetchCatalogItem,
  collectionCoverUrl,
  fetchCollectionInfo,
  fetchManaBalances,
  fetchManaUsdRate,
  fetchOpenOrders,
  fetchOwners,
  fetchSales,
  isBatchableSource,
  itemHasPrimary,
  itemHasSecondary,
  listingPayWei,
  manaWeiToShopCredits,
  usesShopCredits,
  type CatalogItem,
  type CatalogQuery,
  type ManaUsdRate,
  type MarketplaceOrder
} from './marketplaceApi'
import { checkoutBatchableCart, type CartLine } from './marketplaceCheckout'
import { fetchUserCredits } from '../../../social/creditsApi'
import { fetchProfileCached, fetchProfileFaceUrl } from '../../../avatar/peerApi'
import { publishMarketplacePurchase } from '../../../social/publishMarketplacePurchase'
import type { MarketplaceItemIntent } from '../../../social/marketplacePurchaseWire'

export type InWorldMarketplacePanelOptions = {
  getSession: () => SessionIdentity
  onClose?: () => void
}

const PAGE = 24
/** Skip Collection Store / marketplace accept — still PM-broadcasts purchase toasts. */
const TEST_SKIP_CHARGE = true
const RARITIES = ['unique', 'mythic', 'exotic', 'legendary', 'epic', 'rare', 'uncommon', 'common']
const WEARABLE_CATS = [
  'eyebrows',
  'eyes',
  'facial_hair',
  'hair',
  'mouth',
  'upper_body',
  'lower_body',
  'feet',
  'earring',
  'eyewear',
  'hat',
  'helmet',
  'mask',
  'tiara',
  'top_head',
  'skin',
  'hands_wear',
  'body_shape'
]
const EMOTE_CATS = ['dance', 'stunt', 'greetings', 'fun', 'poses', 'reactions', 'horror', 'miscellaneous']
const GENDERS = ['male', 'female', 'unisex']

const RARITY_CLASS: Record<string, string> = {
  unique: 'rarity-unique',
  mythic: 'rarity-mythic',
  exotic: 'rarity-exotic',
  legendary: 'rarity-legendary',
  epic: 'rarity-epic',
  rare: 'rarity-rare',
  uncommon: 'rarity-uncommon',
  common: 'rarity-common'
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function rarityClass(r: string): string {
  return RARITY_CLASS[r.toLowerCase()] ?? ''
}

type Layer = 'browse' | 'filters' | 'item' | 'cart' | 'collection' | 'creator' | 'done'

type ReceiptLine = {
  id: string
  item: CatalogItem
  lane: string
  price: string
}

type PurchaseReceipt = {
  lines: ReceiptLine[]
  pay: string
  test: boolean
}

type NavSnap = {
  layer: Layer
  items: CatalogItem[]
  total: number
  skip: number
  collectionContract: string
  collectionTitle: string
  creatorWallet: string
  creatorTitle: string
  detail: CatalogItem | null
  detailTab: 'overview' | 'listings' | 'owners' | 'sales'
  preview3d: boolean
  itemFrom: 'browse' | 'collection' | 'creator'
  detailCreatorName: string
  detailCreatorFace: string
  detailCollectionImage: string
}

export class InWorldMarketplacePanel {
  readonly element: HTMLDivElement
  private visible = false
  private layer: Layer = 'browse'
  private items: CatalogItem[] = []
  private total = 0
  private loading = false
  private skip = 0
  private query: CatalogQuery = { category: 'wearable', isOnSale: true, sortBy: 'newest' }
  private search = ''
  private rarities = new Set<string>()
  private wearableCategory = ''
  private emoteCategory = ''
  private saleType: '' | 'primary' | 'secondary' = ''
  private network: '' | 'ETHEREUM' | 'MATIC' = ''
  private genders = new Set<string>()
  private emotePlayMode = ''
  private minPrice = ''
  private maxPrice = ''
  private withCredits = false
  private onlySmart = false
  private emoteHasSound = false
  private emoteHasGeometry = false
  private creditsTotal = 0
  private manaRate: ManaUsdRate | null = null
  private ethManaWei = 0n
  private polyManaWei = 0n
  private detail: CatalogItem | null = null
  private detailTab: 'overview' | 'listings' | 'owners' | 'sales' = 'overview'
  private preview3d = false
  private orders: MarketplaceOrder[] = []
  private sales: { type?: string; price: string; buyer?: string; tokenId?: string }[] = []
  private owners: { tokenId: string; owner: string }[] = []
  private cart: CartLine[] = []
  private receipt: PurchaseReceipt | null = null
  private buying = false
  private adding = false
  private addTimer: ReturnType<typeof setTimeout> | 0 = 0
  private status = ''
  private detailCreatorName = ''
  private detailCreatorFace = ''
  private detailCollectionImage = ''
  private collectionContract = ''
  private collectionTitle = ''
  private creatorWallet = ''
  private creatorTitle = ''
  private readonly creatorNames = new Map<string, string>()
  private itemFrom: 'browse' | 'collection' | 'creator' = 'browse'
  private filtersFrom: Layer = 'browse'
  private readonly navStack: NavSnap[] = []
  private readonly onKey: (ev: KeyboardEvent) => void

  constructor(private readonly options: InWorldMarketplacePanelOptions) {
    this.element = document.createElement('div')
    this.element.className = 'iwm-panel'
    this.element.hidden = true
    this.element.setAttribute('role', 'dialog')
    this.element.setAttribute('aria-label', 'Marketplace')
    this.element.innerHTML = this.shell()
    this.bind()
    this.onKey = (ev) => {
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
    window.addEventListener('keydown', this.onKey)
    if (this.items.length === 0) await this.reload()
    else this.render()
    void this.refreshWallet()
    if (!this.manaRate) void this.loadManaRate()
  }

  hide(): void {
    this.stopAdding(false)
    this.visible = false
    this.element.hidden = true
    window.removeEventListener('keydown', this.onKey)
    this.options.onClose?.()
  }

  /** Toast / deep-link: open this item's details page. */
  async openFromIntent(intent: MarketplaceItemIntent): Promise<void> {
    this.status = ''
    await this.show()
    const contractAddress = intent.contractAddress.toLowerCase()
    const itemId = intent.itemId
    const stub: CatalogItem = {
      id: intent.catalogId || `${contractAddress}-${itemId}`,
      name: intent.name || 'Collectible',
      thumbnail: intent.thumbnail || '',
      url: '',
      category: 'wearable',
      contractAddress,
      itemId,
      rarity: intent.rarity || 'common',
      price: '0',
      available: 0,
      isOnSale: true,
      tradeId: null
    }
    this.pushNav()
    this.itemFrom = 'browse'
    this.detail = stub
    this.detailTab = 'overview'
    this.preview3d = false
    this.orders = []
    this.sales = []
    this.owners = []
    this.layer = 'item'
    this.render()
    await this.hydrateDetail(stub)
  }

  dispose(): void {
    this.hide()
    this.element.remove()
  }

  private shell(): string {
    return `
      <header class="iwm-hd">
        <div class="iwm-hd__row">
          <h1>MARKETPLACE</h1>
          <button type="button" class="iwm-cart-btn" data-iwm="cart" title="Cart" aria-label="Cart">
            <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M6 6h15l-1.5 9h-12L5 3H2" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><circle cx="9" cy="20" r="1.4" fill="currentColor"/><circle cx="18" cy="20" r="1.4" fill="currentColor"/></svg>
            <span class="iwm-cart-badge" data-iwm-badge hidden>0</span>
          </button>
          <button type="button" class="iwm-icon-btn" data-iwm="filters" title="Filters">☰</button>
          <button type="button" class="iwm-icon-btn" data-iwm="close" aria-label="Close">×</button>
        </div>
        <div class="iwm-wallet" data-iwm-wallet hidden>
          <span class="iwm-coin iwm-coin--cr" data-iwm-credits title="Shop credits (1 credit = $0.10)">© 0</span>
          <span class="iwm-coin iwm-coin--eth" data-iwm-eth-mana title="Ethereum MANA">ETH —</span>
          <span class="iwm-coin iwm-coin--poly" data-iwm-poly-mana title="Polygon MANA">POLY —</span>
        </div>
      </header>
      <div class="iwm-body" data-iwm-body></div>
    `
  }

  private bind(): void {
    this.element.addEventListener('click', (ev) => {
      const t = ev.target as HTMLElement | null
      if (!t) return
      if (t.closest('[data-iwm="close"]')) {
        this.hide()
        return
      }
      if (t.closest('[data-iwm="cart"]')) {
        this.layer = this.layer === 'cart' ? 'browse' : 'cart'
        this.render()
        if (this.layer === 'cart') void this.hydrateCartCreators()
        return
      }
      if (t.closest('[data-iwm="filters"]')) {
        if (this.layer === 'filters') this.layer = this.filtersFrom
        else {
          this.filtersFrom = this.layer
          this.layer = 'filters'
        }
        this.render()
        return
      }
      if (t.closest('[data-iwm="back"]')) {
        this.goBack()
        return
      }
      const col = t.closest('[data-collection]') as HTMLElement | null
      if (col?.dataset.collection) {
        void this.openCollection(col.dataset.collection, col.dataset.collectionName || '')
        return
      }
      const creator = t.closest('[data-creator]') as HTMLElement | null
      if (creator?.dataset.creator) {
        void this.openCreator(creator.dataset.creator, creator.dataset.creatorName || '')
        return
      }
      const tab = t.closest('[data-cat]') as HTMLElement | null
      if (tab?.dataset.cat) {
        this.query.category = tab.dataset.cat as 'wearable' | 'emote'
        void this.reload()
        return
      }
      const card = t.closest('[data-item]') as HTMLElement | null
      if (card?.dataset.item) {
        void this.openItem(card.dataset.item)
        return
      }
      if (t.closest('[data-add]')) {
        ev.stopPropagation()
        if (this.detail) this.addToCart(this.detail)
        return
      }
      if (t.closest('[data-preview]')) {
        const mode = (t.closest('[data-preview]') as HTMLElement).dataset.preview
        this.preview3d = mode === '3d'
        this.render()
        return
      }
      const dtab = t.closest('[data-dtab]') as HTMLElement | null
      if (dtab?.dataset.dtab) {
        this.detailTab = dtab.dataset.dtab as 'overview' | 'listings' | 'owners' | 'sales'
        this.render()
        return
      }
      const inc = t.closest('[data-qty-inc]') as HTMLElement | null
      if (inc?.dataset.qtyInc) {
        this.bumpCartQty(inc.dataset.qtyInc, 1)
        return
      }
      const dec = t.closest('[data-qty-dec]') as HTMLElement | null
      if (dec?.dataset.qtyDec) {
        this.bumpCartQty(dec.dataset.qtyDec, -1)
        return
      }
      const rm = t.closest('[data-rm]') as HTMLElement | null
      if (rm?.dataset.rm) {
        this.cart = this.cart.filter((l) => l.key !== rm.dataset.rm)
        this.render()
        return
      }
      if (t.closest('[data-buy-cart]')) {
        void this.buyCart()
        return
      }
      if (t.closest('[data-keep-shopping]')) {
        this.keepShopping()
        return
      }
      const rar = t.closest('[data-rar]') as HTMLElement | null
      if (rar?.dataset.rar) {
        if (this.rarities.has(rar.dataset.rar)) this.rarities.delete(rar.dataset.rar)
        else this.rarities.add(rar.dataset.rar)
        this.render()
        return
      }
      const wcat = t.closest('[data-wcat]') as HTMLElement | null
      if (wcat?.dataset.wcat) {
        this.wearableCategory = this.wearableCategory === wcat.dataset.wcat ? '' : wcat.dataset.wcat
        this.render()
        return
      }
      const ecat = t.closest('[data-ecat]') as HTMLElement | null
      if (ecat?.dataset.ecat) {
        this.emoteCategory = this.emoteCategory === ecat.dataset.ecat ? '' : ecat.dataset.ecat
        this.render()
        return
      }
      const sale = t.closest('[data-sale]') as HTMLElement | null
      if (sale?.dataset.sale != null) {
        const v = sale.dataset.sale as '' | 'primary' | 'secondary'
        this.saleType = this.saleType === v ? '' : v
        if (this.saleType === 'secondary') this.withCredits = false
        this.render()
        return
      }
      const net = t.closest('[data-net]') as HTMLElement | null
      if (net?.dataset.net != null) {
        const v = net.dataset.net as '' | 'ETHEREUM' | 'MATIC'
        this.network = this.network === v ? '' : v
        this.render()
        return
      }
      const gen = t.closest('[data-gender]') as HTMLElement | null
      if (gen?.dataset.gender) {
        if (this.genders.has(gen.dataset.gender)) this.genders.delete(gen.dataset.gender)
        else this.genders.add(gen.dataset.gender)
        this.render()
        return
      }
      const play = t.closest('[data-play]') as HTMLElement | null
      if (play?.dataset.play != null) {
        this.emotePlayMode = this.emotePlayMode === play.dataset.play ? '' : play.dataset.play
        this.render()
        return
      }
      if (t.closest('[data-apply-filters]')) {
        this.commitFilters()
        this.layer =
          this.filtersFrom === 'collection' && this.collectionContract
            ? 'collection'
            : this.filtersFrom === 'creator' && this.creatorWallet
              ? 'creator'
              : 'browse'
        void this.reload()
        return
      }
      if (t.closest('[data-clear-filters]')) {
        this.clearFilters()
        this.render()
        return
      }
    })
    this.element.addEventListener('change', (ev) => {
      const t = ev.target as HTMLSelectElement | HTMLInputElement | null
      if (!t) return
      if (t.name === 'sort') {
        this.query.sortBy = t.value
        void this.reload()
      }
      if (t.name === 'onsale') this.query.isOnSale = (t as HTMLInputElement).checked
      if (t.name === 'credits') {
        this.withCredits = (t as HTMLInputElement).checked
        if (this.withCredits) this.saleType = 'primary'
        this.render()
      }
      if (t.name === 'smart') this.onlySmart = (t as HTMLInputElement).checked
      if (t.name === 'sound') this.emoteHasSound = (t as HTMLInputElement).checked
      if (t.name === 'geometry') this.emoteHasGeometry = (t as HTMLInputElement).checked
      if (t.name === 'minPrice') this.minPrice = t.value.trim()
      if (t.name === 'maxPrice') this.maxPrice = t.value.trim()
    })
    this.element.addEventListener('input', (ev) => {
      const t = ev.target as HTMLInputElement | null
      if (!t) return
      if (t.name === 'search') {
        this.search = t.value
      }
      if (t.name === 'beneficiary') this.renderBadgeOnly()
    })
    this.element.addEventListener('keydown', (ev) => {
      const t = ev.target as HTMLInputElement | null
      if (ev.key === 'Enter' && t?.name === 'search') {
        this.query.search = this.search
        void this.reload()
      }
    })
    this.element.addEventListener('scroll', (ev) => {
      const body = ev.target as HTMLElement
      if (!body.classList.contains('iwm-grid')) return
      if (this.loading || this.items.length >= this.total) return
      if (body.scrollTop + body.clientHeight >= body.scrollHeight - 80) void this.loadMore()
    }, true)
  }

  private sessionAddr(): string {
    return (this.options.getSession().getAddress() || '').toLowerCase()
  }

  private commitFilters(): void {
    this.query.rarities = [...this.rarities]
    this.query.wearableCategory = this.wearableCategory || undefined
    this.query.emoteCategory = this.emoteCategory || undefined
    this.query.onlyMinting = this.saleType === 'primary' || this.withCredits
    this.query.onlyListing = this.saleType === 'secondary' && !this.withCredits
    this.query.network = this.withCredits ? 'MATIC' : this.network || undefined
    this.query.wearableGenders = [...this.genders]
    this.query.emotePlayMode = this.emotePlayMode || undefined
    this.query.emoteHasSound = this.emoteHasSound || undefined
    this.query.emoteHasGeometry = this.emoteHasGeometry || undefined
    this.query.isWearableSmart = this.onlySmart || undefined
    const min = this.withCredits
      ? String(Math.max(1, Number(this.minPrice) || 1))
      : this.minPrice
    this.query.minPrice = min || undefined
    this.query.maxPrice = this.maxPrice || undefined
    if (this.withCredits) this.query.isOnSale = true
  }

  private clearFilters(): void {
    this.rarities.clear()
    this.wearableCategory = ''
    this.emoteCategory = ''
    this.saleType = ''
    this.network = ''
    this.genders.clear()
    this.emotePlayMode = ''
    this.minPrice = ''
    this.maxPrice = ''
    this.withCredits = false
    this.onlySmart = false
    this.emoteHasSound = false
    this.emoteHasGeometry = false
    this.query.rarities = []
    this.query.wearableCategory = undefined
    this.query.emoteCategory = undefined
    this.query.onlyMinting = undefined
    this.query.onlyListing = undefined
    this.query.network = undefined
    this.query.wearableGenders = undefined
    this.query.emotePlayMode = undefined
    this.query.emoteHasSound = undefined
    this.query.emoteHasGeometry = undefined
    this.query.isWearableSmart = undefined
    this.query.minPrice = undefined
    this.query.maxPrice = undefined
    this.query.isOnSale = true
  }

  private async loadManaRate(): Promise<void> {
    const rate = await fetchManaUsdRate()
    if (!rate) return
    this.manaRate = rate
    if (this.visible) this.render()
  }

  private async refreshWallet(): Promise<void> {
    const addr = this.sessionAddr()
    if (!addr) {
      this.creditsTotal = 0
      this.ethManaWei = 0n
      this.polyManaWei = 0n
      this.renderWallet()
      return
    }
    const [credits, mana, rate] = await Promise.all([
      fetchUserCredits(addr, { identity: this.options.getSession().getAuthIdentity() }).catch(() => null),
      fetchManaBalances(addr).catch(() => ({ ethWei: 0n, polyWei: 0n })),
      this.manaRate ? Promise.resolve(this.manaRate) : fetchManaUsdRate()
    ])
    this.creditsTotal =
      credits && credits.ok ? (credits.data.usd?.credits ?? 0) : 0
    this.ethManaWei = mana.ethWei
    this.polyManaWei = mana.polyWei
    if (rate) this.manaRate = rate
    this.renderWallet()
  }

  private renderWallet(): void {
    const row = this.element.querySelector('[data-iwm-wallet]') as HTMLElement | null
    const cr = this.element.querySelector('[data-iwm-credits]') as HTMLElement | null
    const eth = this.element.querySelector('[data-iwm-eth-mana]') as HTMLElement | null
    const poly = this.element.querySelector('[data-iwm-poly-mana]') as HTMLElement | null
    if (!row || !cr || !eth || !poly) return
    const signed = Boolean(this.sessionAddr())
    row.hidden = !signed
    cr.textContent = `© ${this.creditsTotal}`
    eth.textContent = `ETH ${formatMana(this.ethManaWei)}`
    poly.textContent = `POLY ${formatMana(this.polyManaWei)}`
  }

  private shopCreditsForWei(wei: string | bigint | null | undefined): number {
    if (!this.manaRate || wei == null || wei === '') return 0
    return manaWeiToShopCredits(wei, this.manaRate)
  }

  private salePrefer(): 'primary' | 'secondary' | 'auto' {
    if (this.query.onlyListing || this.saleType === 'secondary') return 'secondary'
    if (this.query.onlyMinting || this.saleType === 'primary') return 'primary'
    return 'auto'
  }

  private manaLabel(wei: string | bigint | null | undefined): string {
    try {
      const w = typeof wei === 'bigint' ? wei : BigInt(wei || '0')
      return w > 0n ? `${formatMana(w)} MANA` : '—'
    } catch {
      return '—'
    }
  }

  private shopPriceLabel(wei: string | bigint | null | undefined): string {
    const n = this.shopCreditsForWei(wei)
    if (n <= 0) return this.manaLabel(wei)
    return `© ${n}`
  }

  private priceLabel(
    item: CatalogItem,
    prefer: 'primary' | 'secondary' | 'auto' = this.salePrefer(),
    order?: MarketplaceOrder | null
  ): string {
    if (!usesShopCredits(item, prefer)) return this.manaLabel(listingPayWei(item, order))
    return this.shopPriceLabel(item.price)
  }

  private linePriceLabel(line: CartLine): string {
    const qty = Math.max(1, line.quantity || 1)
    if (line.source === 'store' && usesShopCredits(line.item, 'primary')) {
      const unit = this.shopCreditsForWei(line.item.price)
      if (unit > 0) return qty > 1 ? `© ${unit * qty}` : `© ${unit}`
      try {
        return this.manaLabel(BigInt(line.item.price || '0') * BigInt(qty))
      } catch {
        return this.manaLabel(line.item.price)
      }
    }
    return this.manaLabel(listingPayWei(line.item))
  }

  private cartPayLabel(lines: CartLine[]): string {
    let credits = 0
    let manaWei = 0n
    for (const l of lines) {
      const qty = Math.max(1, l.quantity || 1)
      if (l.source === 'store' && usesShopCredits(l.item, 'primary')) {
        const unit = this.shopCreditsForWei(l.item.price)
        if (unit > 0) {
          credits += unit * qty
          continue
        }
        try {
          manaWei += BigInt(l.item.price || '0') * BigInt(qty)
        } catch {
          /* ignore */
        }
        continue
      }
      try {
        manaWei += BigInt(listingPayWei(l.item) || '0') * BigInt(qty)
      } catch {
        /* ignore */
      }
    }
    const parts: string[] = []
    if (credits > 0) parts.push(`© ${credits}`)
    if (manaWei > 0n) parts.push(`${formatMana(manaWei)} MANA`)
    return parts.join(' + ')
  }

  private addButtonLabel(it: CatalogItem): string {
    const order = this.layer === 'item' ? this.orders[0] ?? null : null
    return `Add to cart · ${this.priceLabel(it, this.salePrefer(), order)}`
  }

  private cartStockCap(line: CartLine): number {
    if (line.source !== 'store') return 1
    const avail = Number(line.item.available)
    return Number.isFinite(avail) && avail > 0 ? Math.floor(avail) : 1
  }

  private cartUnits(): number {
    return this.cart.reduce((n, l) => n + Math.max(1, l.quantity || 1), 0)
  }

  private filterSaleType(items: CatalogItem[]): CatalogItem[] {
    if (this.saleType === 'secondary') return items.filter(itemHasSecondary)
    if (this.saleType === 'primary') return items.filter(itemHasPrimary)
    return items
  }

  private cartCreatorLabel(line: CartLine): string {
    const named = line.creatorName?.trim()
    if (named) return named
    const wallet = (line.item.creator || '').toLowerCase()
    return this.creatorNames.get(wallet) || (wallet ? shortAddr(wallet) : '')
  }

  private async hydrateCartCreators(): Promise<void> {
    const pending = this.cart.filter((l) => {
      const wallet = (l.item.creator || '').toLowerCase()
      return wallet && !l.creatorName && !this.creatorNames.has(wallet)
    })
    if (pending.length === 0) return
    await Promise.all(
      pending.map(async (l) => {
        const wallet = (l.item.creator || '').toLowerCase()
        const profile = await fetchProfileCached(wallet).catch(() => null)
        const name = profile?.displayName?.trim()
        if (name) {
          this.creatorNames.set(wallet, name)
          l.creatorName = name
        }
      })
    )
    if (this.layer === 'cart' && this.visible) this.render()
  }

  private bumpCartQty(key: string, delta: number): void {
    const line = this.cart.find((l) => l.key === key)
    if (!line || line.source !== 'store') return
    const next = Math.max(1, Math.min(this.cartStockCap(line), (line.quantity || 1) + delta))
    if (next === line.quantity) return
    line.quantity = next
    this.render()
  }

  private catalogQuery(skip: number): CatalogQuery {
    const q: CatalogQuery = { ...this.query, search: this.search, first: PAGE, skip }
    if (this.collectionContract) {
      q.contractAddress = this.collectionContract
      q.category = undefined
    }
    if (this.creatorWallet) q.creator = this.creatorWallet
    return q
  }

  private pushNav(): void {
    this.navStack.push({
      layer: this.layer,
      items: this.items.slice(),
      total: this.total,
      skip: this.skip,
      collectionContract: this.collectionContract,
      collectionTitle: this.collectionTitle,
      creatorWallet: this.creatorWallet,
      creatorTitle: this.creatorTitle,
      detail: this.detail,
      detailTab: this.detailTab,
      preview3d: this.preview3d,
      itemFrom: this.itemFrom,
      detailCreatorName: this.detailCreatorName,
      detailCreatorFace: this.detailCreatorFace,
      detailCollectionImage: this.detailCollectionImage
    })
    if (this.navStack.length > 16) this.navStack.shift()
  }

  private restoreNav(snap: NavSnap): void {
    this.layer = snap.layer
    this.items = snap.items
    this.total = snap.total
    this.skip = snap.skip
    this.collectionContract = snap.collectionContract
    this.collectionTitle = snap.collectionTitle
    this.creatorWallet = snap.creatorWallet
    this.creatorTitle = snap.creatorTitle
    this.detail = snap.detail
    this.detailTab = snap.detailTab
    this.preview3d = snap.preview3d
    this.itemFrom = snap.itemFrom
    this.detailCreatorName = snap.detailCreatorName
    this.detailCreatorFace = snap.detailCreatorFace
    this.detailCollectionImage = snap.detailCollectionImage
    this.status = ''
  }

  private goBack(): void {
    if (this.layer === 'filters') {
      this.layer = this.filtersFrom === 'filters' ? 'browse' : this.filtersFrom
      this.render()
      return
    }
    if (this.layer === 'done') {
      this.keepShopping()
      return
    }
    const prev = this.navStack.pop()
    if (!prev) {
      this.layer = 'browse'
      this.collectionContract = ''
      this.creatorWallet = ''
      this.render()
      return
    }
    this.restoreNav(prev)
    this.render()
  }

  private async openCollection(contractAddress: string, name: string): Promise<void> {
    const addr = contractAddress.toLowerCase()
    if (!/^0x[a-f0-9]{40}$/.test(addr)) return
    this.status = ''
    this.pushNav()
    this.creatorWallet = ''
    this.creatorTitle = ''
    this.collectionContract = addr
    this.collectionTitle = name.trim() || this.detail?.collectionName || 'Collection'
    this.layer = 'collection'
    if (!name.trim() || name.trim() === 'Collection') {
      const fetched = await fetchCollectionInfo(addr)
      if (fetched?.name) this.collectionTitle = fetched.name
      if (fetched?.image) this.detailCollectionImage = fetched.image
    }
    await this.reload()
  }

  private async openCreator(address: string, name: string): Promise<void> {
    const addr = address.toLowerCase()
    if (!/^0x[a-f0-9]{40}$/.test(addr)) return
    this.status = ''
    this.pushNav()
    this.collectionContract = ''
    this.collectionTitle = ''
    this.creatorWallet = addr
    this.creatorTitle = name.trim() || this.detailCreatorName || shortAddr(addr)
    if (this.creatorTitle && !this.creatorTitle.startsWith('0x')) this.creatorNames.set(addr, this.creatorTitle)
    this.layer = 'creator'
    await this.reload()
  }

  private async reload(): Promise<void> {
    this.skip = 0
    this.loading = true
    this.status = ''
    this.render()
    try {
      const { items, total } = await fetchCatalog(this.catalogQuery(0))
      this.items = this.filterSaleType(items)
      this.total = total
    } catch (err) {
      this.status = err instanceof Error ? err.message : 'Failed to load catalog'
    } finally {
      this.loading = false
      this.render()
    }
  }

  private async loadMore(): Promise<void> {
    this.loading = true
    this.skip += PAGE
    try {
      const { items, total } = await fetchCatalog(this.catalogQuery(this.skip))
      this.items = [...this.items, ...this.filterSaleType(items)]
      this.total = total
    } catch {
      this.skip -= PAGE
    } finally {
      this.loading = false
      this.render()
    }
  }

  private async openItem(id: string): Promise<void> {
    this.status = ''
    this.pushNav()
    this.itemFrom =
      this.layer === 'collection' ? 'collection' : this.layer === 'creator' ? 'creator' : 'browse'
    const fromGrid = this.items.find((i) => i.id === id)
    const fromReceipt = this.receipt?.lines.find((l) => l.id === id)?.item
    this.detail = fromGrid ?? fromReceipt ?? null
    this.detailTab = 'overview'
    this.preview3d = false
    this.orders = []
    this.sales = []
    this.owners = []
    this.layer = 'item'
    this.render()
    if (!this.detail) return
    await this.hydrateDetail(this.detail)
  }

  private async hydrateDetail(seed: CatalogItem): Promise<void> {
    this.detailCreatorName = ''
    this.detailCreatorFace = ''
    this.detailCollectionImage = collectionCoverUrl(seed.contractAddress, seed.urn) || seed.thumbnail || ''
    const creator = (seed.creator || '').toLowerCase()
    const [full, orders, sales, owners, collectionInfo, profile, faceUrl] = await Promise.all([
      fetchCatalogItem(seed.contractAddress, seed.itemId),
      fetchOpenOrders(seed.contractAddress, seed.itemId),
      fetchSales(seed.contractAddress, seed.itemId),
      fetchOwners(seed.contractAddress, seed.itemId),
      fetchCollectionInfo(seed.contractAddress),
      creator ? fetchProfileCached(creator).catch(() => null) : Promise.resolve(null),
      creator ? fetchProfileFaceUrl(creator).catch(() => null) : Promise.resolve(null)
    ])
    const merged = full ? { ...seed, ...full } : { ...seed }
    if (collectionInfo?.name) merged.collectionName = collectionInfo.name
    if (listingPayWei(merged) === '0' && seed.minListingPrice) merged.minListingPrice = seed.minListingPrice
    if ((merged.listings ?? 0) === 0 && seed.listings) merged.listings = seed.listings
    orders.sort((a, b) => {
      try {
        const aw = BigInt(a.price || '0')
        const bw = BigInt(b.price || '0')
        return aw < bw ? -1 : aw > bw ? 1 : 0
      } catch {
        return 0
      }
    })
    if (orders.length) {
      const listed = listingPayWei(merged, orders[0])
      if (listed !== '0') merged.minListingPrice = listed
      if (merged.listings == null || merged.listings < orders.length) merged.listings = orders.length
    }
    this.detail = merged
    this.detailCreatorName = profile?.displayName?.trim() || ''
    if (creator && this.detailCreatorName) this.creatorNames.set(creator, this.detailCreatorName)
    this.detailCreatorFace = faceUrl || ''
    this.detailCollectionImage =
      collectionInfo?.image || collectionCoverUrl(merged.contractAddress, merged.urn) || merged.thumbnail || ''
    this.orders = orders
    this.sales = sales
    this.owners = owners
    if (this.layer === 'item' && this.visible && !this.adding) this.render()
  }

  private stopAdding(render: boolean): void {
    if (this.addTimer) {
      clearTimeout(this.addTimer)
      this.addTimer = 0
    }
    const was = this.adding
    this.adding = false
    if (was && render) this.render()
  }

  private addToCart(item: CatalogItem): void {
    if (this.adding) return
    const key = `${item.contractAddress}:${item.itemId}`
    const prefer = this.salePrefer()
    const order = this.orders[0] ?? null
    const source = classifyCartSource(item, order, prefer)
    const existing = this.cart.find((l) => l.key === key)
    if (existing) {
      if (existing.source === 'store') {
        const cap = this.cartStockCap(existing)
        if (existing.quantity >= cap) {
          this.status = 'No more in stock'
          this.render()
          return
        }
        existing.quantity += 1
      } else {
        this.status = 'Already in cart'
        this.render()
        return
      }
    } else {
      const creator = (item.creator || '').toLowerCase()
      const listed = listingPayWei(item, order)
      this.cart.push({
        key,
        item: source === 'store' ? item : { ...item, minListingPrice: listed === '0' ? item.minListingPrice : listed },
        source,
        tradeId:
          source === 'store'
            ? item.tradeId ?? null
            : order?.tradeId ?? item.tradeId ?? this.orders.find((o) => o.tradeId)?.tradeId ?? null,
        quantity: 1,
        creatorName: this.detailCreatorName.trim() || this.creatorNames.get(creator) || undefined
      })
    }
    this.renderBadgeOnly()

    const btn = this.element.querySelector('[data-add]') as HTMLButtonElement | null
    if (!btn || this.layer !== 'item') {
      this.render()
      return
    }

    this.adding = true
    btn.disabled = true
    btn.textContent = 'Adding...'
    btn.classList.add('is-adding')
    btn.setAttribute('aria-busy', 'true')
    this.addTimer = setTimeout(() => {
      this.addTimer = 0
      this.adding = false
      this.render()
    }, 800)
  }

  private liveCart(): CartLine[] {
    return this.cart.filter((l) => isBatchableSource(l.source))
  }

  private async buyCart(): Promise<void> {
    if (this.buying) return
    const session = this.options.getSession()
    const sessionAddress = this.sessionAddr()
    if (!sessionAddress) {
      this.status = 'Sign in to buy'
      this.render()
      return
    }
    const purchased = this.liveCart().length ? this.liveCart() : this.cart
    if (purchased.length === 0) {
      this.status = 'Cart is empty'
      this.render()
      return
    }

    if (TEST_SKIP_CHARGE) {
      this.showReceipt(purchased, true)
      void this.announcePurchases(purchased, session)
      return
    }

    const addr = (this.element.querySelector('[name="beneficiary"]') as HTMLInputElement | null)?.value.trim() ?? ''
    if (!/^0x[a-fA-F0-9]{40}$/.test(addr)) {
      this.status = 'Enter a valid 0x wallet'
      this.render()
      return
    }
    this.buying = true
    this.status = 'Checking out…'
    this.render()
    try {
      await checkoutBatchableCart({
        lines: purchased,
        beneficiary: addr.toLowerCase() as Address,
        sessionAddress,
        isGuest: session.isGuest(),
        note: (m) => {
          this.status = m
          this.render()
        }
      })
      this.showReceipt(purchased, false)
      void this.announcePurchases(purchased, session)
    } catch (err) {
      this.buying = false
      this.status = err instanceof Error ? err.message : 'Checkout failed'
      this.render()
    } finally {
      this.buying = false
    }
  }

  private showReceipt(purchased: CartLine[], test: boolean): void {
    this.buying = false
    const units = purchased.reduce((n, l) => n + Math.max(1, l.quantity || 1), 0)
    const lines = purchased.map((l) => ({
      id: l.item.id,
      item: l.item,
      lane: l.source === 'store' ? 'Primary' : 'Secondary',
      price: this.linePriceLabel(l)
    }))
    const bought = new Set(purchased.map((l) => l.key))
    this.receipt = {
      lines,
      pay: this.cartPayLabel(purchased) || `${units} item${units === 1 ? '' : 's'}`,
      test
    }
    this.cart = this.cart.filter((l) => !bought.has(l.key))
    this.status = ''
    this.layer = 'done'
    this.render()
    void this.refreshWallet()
  }

  private keepShopping(): void {
    this.receipt = null
    this.status = ''
    this.layer = this.collectionContract
      ? 'collection'
      : this.creatorWallet
        ? 'creator'
        : 'browse'
    this.render()
  }

  private async announcePurchases(lines: CartLine[], session: SessionIdentity): Promise<void> {
    const identity = session.getAuthIdentity()
    const address = session.getAddress()
    const displayName = session.getProfile()?.displayName ?? null
    for (const line of lines.slice(0, 4)) {
      await publishMarketplacePurchase({
        identity,
        address,
        displayName,
        itemName: line.item.name,
        contractAddress: line.item.contractAddress,
        itemId: line.item.itemId,
        catalogId: line.item.id,
        imageUrl: line.item.thumbnail,
        rarity: line.item.rarity
      })
    }
  }

  private renderBadgeOnly(): void {
    const badge = this.element.querySelector('[data-iwm-badge]') as HTMLElement | null
    if (!badge) return
    const n = this.cartUnits()
    badge.hidden = n === 0
    badge.textContent = String(n)
  }

  private render(): void {
    if (this.adding && this.layer !== 'item') this.stopAdding(false)
    const body = this.element.querySelector('[data-iwm-body]')
    if (!body) return
    const cartBtn = this.element.querySelector('[data-iwm="cart"]') as HTMLElement | null
    cartBtn?.classList.toggle('is-on', this.layer === 'cart')
    this.renderBadgeOnly()
    this.renderWallet()
    if (this.adding) return
    if (this.layer === 'filters') body.innerHTML = this.filtersHtml()
    else if (this.layer === 'item' && this.detail) body.innerHTML = this.itemHtml(this.detail)
    else if (this.layer === 'item') body.innerHTML = this.loadingHtml('Loading item…')
    else if (this.layer === 'cart') body.innerHTML = this.cartHtml()
    else if (this.layer === 'done') body.innerHTML = this.doneHtml()
    else if (this.loading && this.skip === 0) {
      body.innerHTML = this.loadingHtml(
        this.layer === 'collection'
          ? 'Loading collection items…'
          : this.layer === 'creator'
            ? 'Loading creator items…'
            : 'Loading catalog…'
      )
    } else if (this.layer === 'collection') body.innerHTML = this.collectionHtml()
    else if (this.layer === 'creator') body.innerHTML = this.creatorHtml()
    else body.innerHTML = this.browseHtml()
  }

  private loadingHtml(label: string): string {
    return `<div class="iwm-loading" role="status" aria-live="polite"><span class="iwm-spinner" aria-hidden="true"></span><span>${esc(label)}</span></div>`
  }

  private cardsHtml(): string {
    const prefer = this.salePrefer()
    const cards = this.items
      .map((it) => {
        const rc = rarityClass(it.rarity)
        const price = this.priceLabel(it, prefer)
        const priceClass = price.startsWith('©') ? ' iwm-card__meta--credits' : ''
        const stock = itemHasPrimary(it) ? String(it.available) : it.listings != null ? `${it.listings}` : '—'
        const primary = itemHasPrimary(it)
        const secondary = itemHasSecondary(it)
        const lanes = [
          primary ? '<span class="iwm-lane iwm-lane--primary">Primary</span>' : '',
          secondary ? '<span class="iwm-lane iwm-lane--secondary">Secondary</span>' : ''
        ].join('')
        return `<button type="button" class="iwm-card ${rc}" data-item="${esc(it.id)}">
          <div class="iwm-card__img" style="background-image:url('${esc(it.thumbnail)}')"></div>
          <div class="iwm-card__body">
            <div class="iwm-card__name">${esc(it.name)}</div>
            ${lanes ? `<div class="iwm-lanes">${lanes}</div>` : ''}
            <div class="iwm-card__meta${priceClass}"><span>${esc(price)}</span><span>${esc(stock)}</span></div>
          </div>
        </button>`
      })
      .join('')
    const more = this.loading
      ? '<div class="iwm-more">Loading…</div>'
      : this.items.length < this.total
        ? '<div class="iwm-more">Scroll for more</div>'
        : ''
    return `${cards}${more}`
  }

  private browseHtml(): string {
    return `
      <div class="iwm-search"><input name="search" type="search" placeholder="Search wearables, emotes, creators…" value="${esc(this.search)}" /></div>
      <div class="iwm-tabs">
        <button type="button" data-cat="wearable" class="${this.query.category !== 'emote' ? 'is-on' : ''}">Wearables</button>
        <button type="button" data-cat="emote" class="${this.query.category === 'emote' ? 'is-on' : ''}">Emotes</button>
      </div>
      <div class="iwm-toolbar">
        <select name="sort">
          <option value="newest" ${this.query.sortBy === 'newest' ? 'selected' : ''}>Newest</option>
          <option value="cheapest" ${this.query.sortBy === 'cheapest' ? 'selected' : ''}>Cheapest</option>
          <option value="most_expensive" ${this.query.sortBy === 'most_expensive' ? 'selected' : ''}>Most expensive</option>
          <option value="recently_listed" ${this.query.sortBy === 'recently_listed' ? 'selected' : ''}>Recently listed</option>
          <option value="recently_sold" ${this.query.sortBy === 'recently_sold' ? 'selected' : ''}>Recently sold</option>
        </select>
        <span class="iwm-count">${this.total.toLocaleString()} results</span>
      </div>
      ${this.status ? `<div class="iwm-status">${esc(this.status)}</div>` : ''}
      <div class="iwm-grid">${this.cardsHtml()}</div>
    `
  }

  private catalogBar(kicker: string, title: string, icon = ''): string {
    return `<div class="iwm-layer-bar"><button type="button" class="iwm-icon-btn" data-iwm="back">←</button>${icon}<h2 class="iwm-layer-bar__title"><span class="iwm-layer-bar__kicker">${esc(kicker)}</span><span>${esc(title)}</span></h2></div>`
  }

  private collectionHtml(): string {
    const cover =
      this.detailCollectionImage ||
      collectionCoverUrl(this.collectionContract, this.items[0]?.urn) ||
      this.items[0]?.thumbnail ||
      ''
    const icon = cover
      ? `<img class="iwm-layer-bar__icon" src="${esc(cover)}" alt="" width="32" height="32" />`
      : ''
    return `
      ${this.catalogBar('Collection items', this.collectionTitle || 'Collection', icon)}
      ${this.status ? `<div class="iwm-status">${esc(this.status)}</div>` : ''}
      <div class="iwm-grid">${this.cardsHtml()}</div>
    `
  }

  private creatorHtml(): string {
    const face = this.detailCreatorFace
      ? `<img class="iwm-layer-bar__icon iwm-layer-bar__icon--face" src="${esc(this.detailCreatorFace)}" alt="" width="32" height="32" />`
      : ''
    return `
      ${this.catalogBar('Creator items', this.creatorTitle || 'Creator', face)}
      <div class="iwm-tabs">
        <button type="button" data-cat="wearable" class="${this.query.category !== 'emote' ? 'is-on' : ''}">Wearables</button>
        <button type="button" data-cat="emote" class="${this.query.category === 'emote' ? 'is-on' : ''}">Emotes</button>
      </div>
      ${this.status ? `<div class="iwm-status">${esc(this.status)}</div>` : ''}
      <div class="iwm-grid">${this.cardsHtml()}</div>
    `
  }

  private filtersHtml(): string {
    const rar = RARITIES.map(
      (r) =>
        `<button type="button" data-rar="${r}" class="${this.rarities.has(r) ? 'is-on' : ''}">${esc(r)}</button>`
    ).join('')
    const wcats = WEARABLE_CATS.map(
      (c) =>
        `<button type="button" data-wcat="${c}" class="${this.wearableCategory === c ? 'is-on' : ''}">${esc(c.replace(/_/g, ' '))}</button>`
    ).join('')
    const ecats = EMOTE_CATS.map(
      (c) =>
        `<button type="button" data-ecat="${c}" class="${this.emoteCategory === c ? 'is-on' : ''}">${esc(c)}</button>`
    ).join('')
    const gens = GENDERS.map(
      (g) =>
        `<button type="button" data-gender="${g}" class="${this.genders.has(g) ? 'is-on' : ''}">${esc(g)}</button>`
    ).join('')
    const emotes = this.query.category === 'emote'
    return `
      <div class="iwm-layer-bar"><button type="button" class="iwm-icon-btn" data-iwm="back">←</button><h2>Filters</h2></div>
      <div class="iwm-layer-body">
        <h3>Sale type</h3>
        <div class="iwm-pills">
          <button type="button" data-sale="primary" class="${this.saleType === 'primary' ? 'is-on' : ''}">Primary</button>
          <button type="button" data-sale="secondary" class="${this.saleType === 'secondary' ? 'is-on' : ''}">Secondary</button>
        </div>
        <h3>Special</h3>
        <label class="iwm-toggle">On sale <input type="checkbox" name="onsale" ${this.query.isOnSale !== false ? 'checked' : ''} /></label>
        <label class="iwm-toggle">Get with Credits <input type="checkbox" name="credits" ${this.withCredits ? 'checked' : ''} /></label>
        ${emotes ? '' : `<label class="iwm-toggle">Smart wearable <input type="checkbox" name="smart" ${this.onlySmart ? 'checked' : ''} /></label>`}
        <h3>Network</h3>
        <div class="iwm-pills">
          <button type="button" data-net="MATIC" class="${this.network === 'MATIC' ? 'is-on' : ''}">Polygon</button>
          <button type="button" data-net="ETHEREUM" class="${this.network === 'ETHEREUM' ? 'is-on' : ''}">Ethereum</button>
        </div>
        <h3>Price (MANA)</h3>
        <div class="iwm-price-row">
          <input name="minPrice" type="number" min="0" step="1" placeholder="Min" value="${esc(this.minPrice)}" />
          <input name="maxPrice" type="number" min="0" step="1" placeholder="Max" value="${esc(this.maxPrice)}" />
        </div>
        <h3>Rarity</h3>
        <div class="iwm-pills">${rar}</div>
        <h3>${emotes ? 'Emote category' : 'Wearable category'}</h3>
        <div class="iwm-pills">${emotes ? ecats : wcats}</div>
        <h3>Body shape</h3>
        <div class="iwm-pills">${gens}</div>
        ${
          emotes
            ? `<h3>Play mode</h3>
        <div class="iwm-pills">
          <button type="button" data-play="simple" class="${this.emotePlayMode === 'simple' ? 'is-on' : ''}">Once</button>
          <button type="button" data-play="loop" class="${this.emotePlayMode === 'loop' ? 'is-on' : ''}">Loop</button>
        </div>
        <label class="iwm-toggle">Has sound <input type="checkbox" name="sound" ${this.emoteHasSound ? 'checked' : ''} /></label>
        <label class="iwm-toggle">Has geometry <input type="checkbox" name="geometry" ${this.emoteHasGeometry ? 'checked' : ''} /></label>`
            : ''
        }
      </div>
      <div class="iwm-layer-foot">
        <button type="button" class="iwm-buy" data-apply-filters>Apply filters</button>
        <button type="button" class="iwm-ghost" data-clear-filters>Clear all</button>
      </div>
    `
  }

  private itemHtml(it: CatalogItem): string {
    const rc = rarityClass(it.rarity)
    const slot = it.data?.wearable?.category ?? it.category
    const desc = it.data?.wearable?.description || it.data?.emote?.description || ''
    const payLabel = this.priceLabel(it, this.salePrefer(), this.orders[0] ?? null)
    const urn = it.urn ?? `urn:decentraland:matic:collections-v2:${it.contractAddress}:${it.itemId}`
    const preview = this.preview3d
      ? `<iframe class="iwm-hero-frame" src="https://wearable-preview.decentraland.org/?urn=${encodeURIComponent(urn)}&background=0e0a18" title="Wearable preview" allow="autoplay"></iframe>`
      : `<img src="${esc(it.thumbnail)}" alt="${esc(it.name)}" />`
    const fav = it.picks?.count ?? 0
    const collectionName = it.collectionName?.trim() || 'Collection'
    const creatorLabel = this.detailCreatorName.trim() || shortAddr(it.creator)
    const creatorInitial = (this.detailCreatorName.trim() || creatorLabel).charAt(0).toUpperCase() || '?'
    const face = this.detailCreatorFace
      ? `<img class="iwm-who__face" src="${esc(this.detailCreatorFace)}" alt="" width="36" height="36" />`
      : `<span class="iwm-who__face iwm-who__face--fallback" aria-hidden="true">${esc(creatorInitial)}</span>`
    const collectionCover =
      this.detailCollectionImage || collectionCoverUrl(it.contractAddress, it.urn) || it.thumbnail
    const collectionInitial = collectionName.charAt(0).toUpperCase() || 'C'
    const thumbFallback =
      it.thumbnail && it.thumbnail !== collectionCover
        ? ` onerror="this.onerror=null;this.src='${esc(it.thumbnail)}'"`
        : ''
    const collectionIcon = collectionCover
      ? `<img class="iwm-who__face iwm-who__face--sq" src="${esc(collectionCover)}" alt="" width="36" height="36"${thumbFallback} />`
      : `<span class="iwm-who__face iwm-who__face--sq iwm-who__face--fallback" aria-hidden="true">${esc(collectionInitial)}</span>`
    return `
      <div class="iwm-layer-bar"><button type="button" class="iwm-icon-btn" data-iwm="back">←</button><h2>Details</h2></div>
      <div class="iwm-layer-body">
        <h3 class="iwm-title">${esc(it.name)}</h3>
        <div class="iwm-hero ${rc}">
          ${preview}
          <div class="iwm-hero-tools">
            <span class="iwm-fav">♡ ${fav}</span>
            <div class="iwm-mode">
              <button type="button" data-preview="img" class="${this.preview3d ? '' : 'is-on'}">Image</button>
              <button type="button" data-preview="3d" class="${this.preview3d ? 'is-on' : ''}">3D</button>
            </div>
          </div>
        </div>
        <div class="iwm-badges">
          ${itemHasPrimary(it) ? '<span class="iwm-badge iwm-badge--lane">Primary</span>' : ''}
          ${itemHasSecondary(it) ? '<span class="iwm-badge iwm-badge--lane iwm-badge--secondary">Secondary</span>' : ''}
          <span class="iwm-badge ${rc}">${esc(it.rarity)}</span>
          <span class="iwm-badge">${esc(slot.replace(/_/g, ' '))}</span>
          <span class="iwm-badge">${esc(it.network || 'MATIC')}</span>
        </div>
        <div class="iwm-who">
          <div>
            <small>Creator</small>
            <button type="button" class="iwm-who__person" data-creator="${esc(it.creator || '')}" data-creator-name="${esc(creatorLabel)}">${face}<b>${esc(creatorLabel)}</b></button>
          </div>
          <div>
            <small>Collection</small>
            <button type="button" class="iwm-who__person" data-collection="${esc(it.contractAddress)}" data-collection-name="${esc(collectionName)}">${collectionIcon}<b>${esc(collectionName)}</b></button>
          </div>
        </div>
        <div class="iwm-pricebox">
          <div><small>You pay</small><strong>${esc(payLabel)}</strong></div>
          <div><small>Available</small><strong>${esc(String(it.available))}</strong></div>
        </div>
        <div class="iwm-dtabs">
          <button type="button" data-dtab="overview" class="${this.detailTab === 'overview' ? 'is-on' : ''}">Overview</button>
          <button type="button" data-dtab="listings" class="${this.detailTab === 'listings' ? 'is-on' : ''}">Listings</button>
          <button type="button" data-dtab="owners" class="${this.detailTab === 'owners' ? 'is-on' : ''}">Owners</button>
          <button type="button" data-dtab="sales" class="${this.detailTab === 'sales' ? 'is-on' : ''}">Sales</button>
        </div>
        ${this.detailPane(it, desc)}
        ${this.status ? `<div class="iwm-status">${esc(this.status)}</div>` : ''}
      </div>
      <div class="iwm-layer-foot">
        <button type="button" class="iwm-buy${this.adding ? ' is-adding' : ''}" data-add ${this.adding ? 'disabled' : ''}>${
          this.adding ? 'Adding...' : esc(this.addButtonLabel(it))
        }</button>
      </div>
    `
  }

  private detailPane(it: CatalogItem, desc: string): string {
    if (this.detailTab === 'listings') {
      const rows = this.orders.length
        ? this.orders
            .map(
              (o) =>
                `<div class="iwm-row"><div><b>Token #${esc(o.tokenId)}</b><small>${esc(shortAddr(o.owner))}</small></div><div>${esc(formatMana(o.price))} MANA</div></div>`
            )
            .join('')
        : '<p class="iwm-muted">No secondary listings. Store mint is available if in stock.</p>'
      return `<div class="iwm-pane">${rows}</div>`
    }
    if (this.detailTab === 'owners') {
      const rows = this.owners
        .map((o) => `<div class="iwm-row"><div><b>${esc(shortAddr(o.owner))}</b><small>#${esc(o.tokenId)}</small></div></div>`)
        .join('')
      return `<div class="iwm-pane">${rows || '<p class="iwm-muted">No owners indexed yet.</p>'}</div>`
    }
    if (this.detailTab === 'sales') {
      const rows = this.sales
        .map(
          (s) =>
            `<div class="iwm-row"><div><b>${esc(s.type || 'sale')}</b><small>${esc(shortAddr(s.buyer))} · #${esc(s.tokenId || '')}</small></div><div>${esc(formatMana(s.price))} MANA</div></div>`
        )
        .join('')
      return `<div class="iwm-pane">${rows || '<p class="iwm-muted">No sales yet.</p>'}</div>`
    }
    void it
    return `<div class="iwm-pane"><p class="iwm-muted">${desc ? esc(desc) : 'No description from the creator.'}</p></div>`
  }

  private cartHtml(): string {
    const me = this.sessionAddr()
    const live = this.liveCart()
    const rows = this.cart
      .map((l) => {
        const off = !isBatchableSource(l.source)
        const qty = Math.max(1, l.quantity || 1)
        const linePrice = this.linePriceLabel(l)
        const creator = this.cartCreatorLabel(l)
        const cap = this.cartStockCap(l)
        const canStep = l.source === 'store' && !off
        const stepper = canStep
          ? `<div class="iwm-qty">
              <button type="button" class="iwm-qty__btn" data-qty-dec="${esc(l.key)}" ${qty <= 1 ? 'disabled' : ''} aria-label="Fewer">−</button>
              <span class="iwm-qty__n">${qty}</span>
              <button type="button" class="iwm-qty__btn" data-qty-inc="${esc(l.key)}" ${qty >= cap ? 'disabled' : ''} aria-label="More">+</button>
            </div>`
          : ''
        return `<div class="iwm-cart-line ${off ? 'is-off' : ''} ${rarityClass(l.item.rarity)}">
          <img src="${esc(l.item.thumbnail)}" alt="" />
          <div class="iwm-cart-line__info">
            <b>${esc(l.item.name)}</b>
            ${creator ? `<small>By ${esc(creator)}</small>` : ''}
            ${off ? '<span class="iwm-note-off">Open on Marketplace</span>' : ''}
            ${stepper}
          </div>
          <div class="iwm-cart-line__side">
            <button type="button" class="iwm-rm" data-rm="${esc(l.key)}" aria-label="Remove">×</button>
            <div class="iwm-mana">${esc(linePrice)}</div>
          </div>
        </div>`
      })
      .join('')
    const you = me ? ` (you)` : ''
    const units = live.reduce((n, l) => n + Math.max(1, l.quantity || 1), 0)
    const pay = this.cartPayLabel(live) || (this.cart.length ? '—' : '© 0')
    return `
      <div class="iwm-layer-bar"><button type="button" class="iwm-icon-btn" data-iwm="back">←</button><h2>Cart</h2></div>
      <div class="iwm-layer-body">${rows || '<p class="iwm-muted">Cart is empty.</p>'}</div>
      <div class="iwm-layer-foot">
        <div class="iwm-label">Beneficiary<span data-you-tag>${you}</span></div>
        <div class="iwm-ben"><input name="beneficiary" spellcheck="false" value="${esc(me)}" placeholder="0x…" /></div>
        ${this.status ? `<div class="iwm-status">${esc(this.status)}</div>` : ''}
        <div class="iwm-summary">${units} item${units === 1 ? '' : 's'} · ${esc(pay)}</div>
        <button type="button" class="iwm-buy" data-buy-cart ${live.length === 0 || this.buying ? 'disabled' : ''}>${this.buying ? 'Checking out…' : `Buy ${units} item${units === 1 ? '' : 's'} · ${esc(pay)}`}</button>
      </div>
    `
  }

  private doneHtml(): string {
    const rec = this.receipt
    if (!rec || rec.lines.length === 0) {
      return `
        <div class="iwm-layer-bar"><button type="button" class="iwm-icon-btn" data-iwm="back">←</button><h2>Purchased</h2></div>
        <div class="iwm-layer-body"><p class="iwm-muted">Nothing to show.</p></div>
        <div class="iwm-layer-foot"><button type="button" class="iwm-buy" data-keep-shopping>Keep shopping</button></div>
      `
    }
    const n = rec.lines.length
    const one = rec.lines[0]
    const lead =
      n === 1
        ? `You just bought ${one.item.name}.`
        : `You just bought ${n} items.`
    const backpack =
      n === 1
        ? "It's in your backpack. Wear it from your avatar."
        : "They're in your backpack. Wear them from your avatar."
    const gallery =
      n === 1
        ? `<button type="button" class="iwm-done__hero ${rarityClass(one.item.rarity)}" data-item="${esc(one.id)}" aria-label="${esc(one.item.name)}">
            <img src="${esc(one.item.thumbnail)}" alt="" />
          </button>
          <div class="iwm-done__name">${esc(one.item.name)}</div>
          <div class="iwm-done__meta"><span>${esc(one.lane)}</span><span>${esc(one.price)}</span></div>`
        : `<div class="iwm-done__stack" aria-hidden="true">${rec.lines
            .slice(0, 5)
            .map(
              (l, i) =>
                `<img class="${rarityClass(l.item.rarity)}" src="${esc(l.item.thumbnail)}" alt="" style="z-index:${10 - i}" />`
            )
            .join('')}</div>
          <div class="iwm-done__list">${rec.lines
            .map(
              (l) =>
                `<button type="button" class="iwm-cart-line ${rarityClass(l.item.rarity)}" data-item="${esc(l.id)}">
                  <img src="${esc(l.item.thumbnail)}" alt="" />
                  <div><b>${esc(l.item.name)}</b><small>${esc(l.lane)}</small></div>
                  <div class="iwm-mana">${esc(l.price)}</div>
                </button>`
            )
            .join('')}</div>`
    return `
      <div class="iwm-layer-bar"><button type="button" class="iwm-icon-btn" data-iwm="back">←</button><h2>Purchased</h2></div>
      <div class="iwm-layer-body">
        <div class="iwm-done${n === 1 ? ' iwm-done--one' : ''}">
          <div class="iwm-done__check" aria-hidden="true">✓</div>
          <p class="iwm-done__title">Congratulations</p>
          <p class="iwm-done__lead">${esc(lead)}</p>
          <p class="iwm-done__sub">${esc(backpack)}</p>
          ${gallery}
        </div>
      </div>
      <div class="iwm-layer-foot">
        <div class="iwm-summary">${n} item${n === 1 ? '' : 's'} · ${esc(rec.pay)}</div>
        <button type="button" class="iwm-buy" data-keep-shopping>Keep shopping</button>
        ${rec.test ? '<p class="iwm-done__note">Test purchase — no MANA charged</p>' : ''}
      </div>
    `
  }
}
