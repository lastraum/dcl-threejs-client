import type { Address, Hex } from 'viem'

export type PositionKind = 'nft' | 'manaPack'

export type GachaPosition = {
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
}

export type PoolSnapshot = {
  acquisitionFee: bigint
  activeCount: bigint
  activeNftCount: bigint
  activePackCount: bigint
  nextPositionId: bigint
  paused: boolean
  testFulfillEnabled: boolean
  positions: GachaPosition[]
}

export type WalletSnapshot = {
  address: Address
  mana: bigint
  claimable: bigint
  ownedTokenIds: number[]
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
  position: GachaPosition | null
}
