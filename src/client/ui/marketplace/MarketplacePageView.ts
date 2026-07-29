import type { LoginResult } from '../../../auth/AuthClient'
import type { MarketplaceSectionId, RouteTarget } from '../../../dcl/content/route'
import { itemRefFromMarketplaceItem, type MarketplaceItem } from '../../../marketplace'
import { landRefFromListing, type LandListing } from '../../../marketplace/landApi'
import { SocialShellTopNav, type SocialShellChromeHandlers, type SocialShellTab } from '../explore/SocialShellTopNav'
import { CollectiblesView } from './CollectiblesView'
import { LandDetailView } from './LandDetailView'
import { LandView } from './LandView'
import { MarketplaceSectionTabs } from './components/MarketplaceSectionTabs'
import { DiscoverView } from './DiscoverView'
import { MarketplaceItemDetailView } from './MarketplaceItemDetailView'
import { MarketplaceSectionPlaceholder } from './MarketplaceSectionPlaceholder'

export type MarketplacePageViewOptions = SocialShellChromeHandlers & {
  login: LoginResult
  onNavigate: (tab: SocialShellTab) => void
  route: Extract<RouteTarget, { kind: 'marketplace' }>
  onMarketplaceRoute: (route: Extract<RouteTarget, { kind: 'marketplace' }>) => void
  /** Jump to Genesis parcel from Land section. */
  onJumpInParcel?: (px: number, py: number) => void
}

/** Full-page Marketplace shell — sections + wearable/land detail. */
export class MarketplacePageView {
  readonly root: HTMLElement

  private readonly topNav: SocialShellTopNav
  private readonly sectionTabs: MarketplaceSectionTabs
  private readonly mainEl: HTMLElement
  private discover: DiscoverView | null = null
  private collectibles: CollectiblesView | null = null
  private land: LandView | null = null
  private placeholder: MarketplaceSectionPlaceholder | null = null
  private detail: MarketplaceItemDetailView | null = null
  private landDetail: LandDetailView | null = null
  private route: Extract<RouteTarget, { kind: 'marketplace' }>

  constructor(private readonly opts: MarketplacePageViewOptions) {
    this.route = opts.route
    this.root = document.createElement('div')
    this.root.className = 'marketplace-page-view'

    this.topNav = new SocialShellTopNav({
      activeTab: 'marketplace',
      login: opts.login,
      onNavigate: opts.onNavigate,
      onLoginChange: opts.onLoginChange,
      onSignOut: opts.onSignOut,
      onOpenSettings: opts.onOpenSettings,
      onOpenBackpack: opts.onOpenBackpack,
      onEnter3D: opts.onEnter3D,
      onOpenProfile: opts.onOpenProfile,
      onOpenWhatsNew: opts.onOpenWhatsNew
    })

    this.sectionTabs = new MarketplaceSectionTabs({
      active: this.sectionFromRoute(opts.route),
      onChange: (section) => {
        this.opts.onMarketplaceRoute({ kind: 'marketplace', view: 'home', section })
      }
    })

    this.mainEl = document.createElement('main')
    this.mainEl.className = 'marketplace-page-view__main'

    this.root.appendChild(this.topNav.el)
    this.root.appendChild(this.sectionTabs.root)
    this.root.appendChild(this.mainEl)
  }

  mount(container: HTMLElement): void {
    document.body.classList.add('marketplace-route')
    container.innerHTML = ''
    container.appendChild(this.root)
    this.topNav.mount()
    this.renderBody()
  }

  setRoute(route: Extract<RouteTarget, { kind: 'marketplace' }>): void {
    this.route = route
    this.sectionTabs.setActive(this.sectionFromRoute(route))
    this.renderBody()
  }

  setLogin(login: LoginResult): void {
    this.topNav.setLogin(login)
  }

  dispose(): void {
    document.body.classList.remove('marketplace-route')
    this.clearBody()
    this.topNav.dispose()
    this.root.remove()
  }

  private sectionFromRoute(route: Extract<RouteTarget, { kind: 'marketplace' }>): MarketplaceSectionId {
    if (route.view === 'home') return route.section
    if (route.view === 'land') return 'land'
    return 'collectibles'
  }

  private clearBody(): void {
    this.discover?.dispose()
    this.discover = null
    this.collectibles?.dispose()
    this.collectibles = null
    this.land?.dispose()
    this.land = null
    this.placeholder?.dispose()
    this.placeholder = null
    this.detail?.dispose()
    this.detail = null
    this.landDetail?.dispose()
    this.landDetail = null
    this.mainEl.replaceChildren()
  }

  private renderBody(): void {
    this.clearBody()
    const onDetail = this.route.view === 'item' || this.route.view === 'land'
    this.sectionTabs.root.hidden = onDetail
    this.root.classList.toggle('marketplace-page-view--detail', onDetail)

    if (this.route.view === 'item') {
      this.detail = new MarketplaceItemDetailView({
        contractAddress: this.route.contractAddress,
        itemId: this.route.itemId,
        onBack: () =>
          this.opts.onMarketplaceRoute({
            kind: 'marketplace',
            view: 'home',
            section: 'collectibles'
          }),
        onOpenItem: (item) => this.openItem(item)
      })
      this.mainEl.appendChild(this.detail.root)
      this.detail.mount()
      return
    }

    if (this.route.view === 'land') {
      this.landDetail = new LandDetailView({
        contractAddress: this.route.contractAddress,
        tokenId: this.route.tokenId,
        onBack: () =>
          this.opts.onMarketplaceRoute({
            kind: 'marketplace',
            view: 'home',
            section: 'land'
          }),
        onOpenLand: (listing) => this.openLand(listing),
        onJumpInParcel: (px, py) => this.opts.onJumpInParcel?.(px, py)
      })
      this.mainEl.appendChild(this.landDetail.root)
      this.landDetail.mount()
      return
    }

    const section = this.route.section
    if (section === 'overview') {
      this.discover = new DiscoverView({ onOpenItem: (item) => this.openItem(item) })
      this.mainEl.appendChild(this.discover.root)
      this.discover.mount()
      return
    }

    if (section === 'collectibles') {
      this.collectibles = new CollectiblesView({ onOpenItem: (item) => this.openItem(item) })
      this.mainEl.appendChild(this.collectibles.root)
      this.collectibles.mount()
      return
    }

    if (section === 'land') {
      this.land = new LandView({
        onOpenLand: (listing) => this.openLand(listing),
        onJumpInParcel: (px, py) => this.opts.onJumpInParcel?.(px, py)
      })
      this.mainEl.appendChild(this.land.root)
      this.land.mount()
      return
    }

    this.placeholder = new MarketplaceSectionPlaceholder(section)
    this.mainEl.appendChild(this.placeholder.root)
  }

  private openItem(item: MarketplaceItem): void {
    const ref = itemRefFromMarketplaceItem(item)
    if (!ref) {
      console.warn('[marketplace] cannot route item — missing contract/itemId', item.id)
      return
    }
    this.opts.onMarketplaceRoute({
      kind: 'marketplace',
      view: 'item',
      contractAddress: ref.contractAddress,
      itemId: ref.itemId
    })
  }

  private openLand(listing: LandListing): void {
    const ref = landRefFromListing(listing)
    if (!ref) {
      console.warn('[marketplace] cannot route land — missing contract/tokenId', listing.id)
      return
    }
    this.opts.onMarketplaceRoute({
      kind: 'marketplace',
      view: 'land',
      contractAddress: ref.contractAddress,
      tokenId: ref.tokenId
    })
  }
}
