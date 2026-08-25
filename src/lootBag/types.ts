import type { Address, Hex } from 'viem'

export type PositionKind = 'nft' | 'manaPack' | 'bundle'

export type BundleItemView = {
  collection: Address
  tokenId: string
  name?: string
  rarity?: string
  imageUrl?: string
  issuedId?: string
  itemId?: number
}

export type LootBagPosition = {
  positionId: number
  kind: PositionKind
  collection: Address
  tokenId: string
  depositor: Address
  backing: bigint
  packMana: bigint
  active: boolean
  /** Catalyst / marketplace thumbnail (DCL Collection V2) */
  imageUrl?: string
  /** Collection V2 item (design) id when decoded from tokenId */
  itemId?: number
  /** Issued edition within the item (1…maxSupply) */
  issuedId?: string
  /** Wearable name from marketplace when enriched */
  name?: string
  /** DCL rarity (common…unique) for card chrome */
  rarity?: string
  /** Multi-item prize payload when kind === 'bundle' */
  bundleItems?: BundleItemView[]
}

export type PoolSnapshot = {
  acquisitionFee: bigint
  activeCount: bigint
  activeNftCount: bigint
  activePackCount: bigint
  nextPositionId: bigint
  paused: boolean
  /** Operational: new pulls blocked; deposits still open. Independent of `paused`. */
  claimsPaused: boolean
  testFulfillEnabled: boolean
  /**
   * On-chain share of backing paid to claimer on Take MANA (bps, e.g. 8500 = 85%).
   * @see GachaPool.depositorBidRateBps
   */
  depositorBidRateBps: number
  /** Protocol cut on settlement (bps). */
  protocolSettlementCutBps: number
  positions: LootBagPosition[]
}

/** Emergency `paused` blocks deposits + claims. `claimsPaused` only blocks new pulls. */
export function lootBagClaimingBlocked(pool: PoolSnapshot | null | undefined): boolean {
  return Boolean(pool?.paused || pool?.claimsPaused)
}

export function lootBagClaimingBlockedReason(pool: PoolSnapshot | null | undefined): string | null {
  if (!pool) return null
  if (pool.paused) return 'Loot Bag is paused'
  if (pool.claimsPaused) return 'Claiming is paused — you can still add loot'
  return null
}

/** Depositable NFT from wallet (real Collection V2 or mock). */
export type WalletOwnedNft = {
  id: string
  collection: Address
  tokenId: string
  name: string
  rarity: string
  imageUrl?: string
  urn?: string
  itemId?: number
  issuedId?: string
}

export type WalletSnapshot = {
  address: Address
  mana: bigint
  claimable: bigint
  /** @deprecated Prefer ownedNfts — mock sequential ids only */
  ownedTokenIds: number[]
  /** Real + mock NFTs for deposit UI */
  ownedNfts: WalletOwnedNft[]
}

export type TxStepStatus = 'pending' | 'active' | 'done' | 'error'

export type TxStep = {
  id: string
  label: string
  status: TxStepStatus
  hash?: Hex
  detail?: string
}

export type FlowStatus = 'idle' | 'running' | 'success' | 'error'

export type PendingWin = {
  positionId: number
  position: LootBagPosition | null
}
