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
  /** Optional media for carousel (empty on mock stack) */
  imageUrl?: string
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
