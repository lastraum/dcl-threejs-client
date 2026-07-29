/** Shared marketplace item model — Discover, category pages, Quick Shop later. */

export type MarketplaceKind = 'wearable' | 'emote' | 'name' | 'land' | 'other'

export type MarketplaceRarity =
  | 'common'
  | 'uncommon'
  | 'rare'
  | 'epic'
  | 'legendary'
  | 'mythic'
  | 'unique'
  | string

export type MarketplaceItem = {
  id: string
  urn: string
  name: string
  kind: MarketplaceKind
  /** Wearable slot / emote category string from API. */
  category: string
  rarity: MarketplaceRarity
  /** Raw MANA wei string from marketplace-api, or null. */
  priceWei: string | null
  /** Derived MANA float for display/sort. */
  priceMana: number | null
  isOnSale: boolean
  thumbnail: string | null
  creator: string | null
  contractAddress: string | null
  itemId: string | null
  network: string | null
  picks: number
  soldAt: number | null
  createdAt: number | null
  /** Item / wearable description when present. */
  description: string | null
  /** Remaining mint stock when primary sale. */
  available: number | null
  bodyShapes: string[]
  isSmart: boolean
}

export type MarketplaceSale = {
  id: string
  type: string
  priceWei: string | null
  priceMana: number | null
  seller: string | null
  buyer: string | null
  /** Unix ms when available. */
  timestamp: number | null
  tokenId: string | null
  txHash: string | null
}

/** Open secondary listing (orders API). */
export type MarketplaceListing = {
  id: string
  tokenId: string | null
  issuedId: string | null
  owner: string | null
  priceWei: string | null
  priceMana: number | null
  status: string
  /** Unix ms */
  expiresAt: number | null
  createdAt: number | null
}

/** Owned edition of an item design (nfts API). */
export type MarketplaceOwnerRow = {
  id: string
  tokenId: string | null
  issuedId: string | null
  owner: string | null
  hasActiveOrder: boolean
}

/** Bid / offer when the API returns any. */
export type MarketplaceOffer = {
  id: string
  bidder: string | null
  priceWei: string | null
  priceMana: number | null
  status: string
  expiresAt: number | null
  createdAt: number | null
  tokenId: string | null
}

export type MarketplaceItemDetailData = {
  item: MarketplaceItem
  sales: MarketplaceSale[]
  listings: MarketplaceListing[]
  owners: MarketplaceOwnerRow[]
  offers: MarketplaceOffer[]
  moreFromCollection: MarketplaceItem[]
}

export type MarketplaceFilters = {
  kind: MarketplaceKind | 'all'
}

export type DiscoverData = {
  trending: MarketplaceItem[]
  newest: MarketplaceItem[]
  rankings: MarketplaceItem[]
  byId: Map<string, MarketplaceItem>
  hero: MarketplaceItem | null
}

export type MarketplaceOrderBy =
  | 'newest'
  | 'recently_listed'
  | 'recently_sold'
  | 'cheapest'
  | 'name'

export type FetchItemsParams = {
  category?: 'wearable' | 'emote' | string
  /** Wearable slot e.g. hat, upper_body (marketplace-api `wearableCategory`). */
  wearableCategory?: string
  orderBy?: MarketplaceOrderBy
  first?: number
  skip?: number
  isOnSale?: boolean
  contractAddress?: string
  itemId?: string
  search?: string
  rarity?: string
  isSmart?: boolean
}

export type FetchItemsResult = {
  items: MarketplaceItem[]
  total: number | null
}
