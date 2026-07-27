import type { Address } from 'viem'
import { ADDRESSES, MAX_MOCK_WEARABLE_SCAN, MAX_POSITION_SCAN } from './config'
import { lootBagPoolAbi } from './abis/GachaPool'
import { mockManaAbi } from './abis/MockMANA'
import { mockWearableAbi } from './abis/MockWearable'
import { polygonPublicClient } from './polygonClient'
import type { LootBagPosition, PoolSnapshot, WalletOwnedNft, WalletSnapshot } from './types'
import { fetchWalletDepositNfts } from './walletInventory'
import { decodeCollectionV2TokenId, resolvePositionMedia } from './resolvePositionMedia'
import { fetchCollectionItems } from './creatorCollections'

const ZERO = '0x0000000000000000000000000000000000000000'

type RawPosition = {
  kind: number
  collection: Address
  tokenId: bigint
  depositor: Address
  backing: bigint
  packMana: bigint
  feeDebt: bigint
  fenwickIndex: number
  active: boolean
}

function normalizeRawPosition(pos: RawPosition | readonly unknown[]): RawPosition {
  if (Array.isArray(pos)) {
    return {
      kind: Number(pos[0]),
      collection: pos[1] as Address,
      tokenId: pos[2] as bigint,
      depositor: pos[3] as Address,
      backing: pos[4] as bigint,
      packMana: pos[5] as bigint,
      feeDebt: pos[6] as bigint,
      fenwickIndex: Number(pos[7]),
      active: Boolean(pos[8])
    }
  }
  return pos as RawPosition
}

function toPosition(id: number, pos: RawPosition): LootBagPosition {
  const kind: LootBagPosition['kind'] = Number(pos.kind) === 1 ? 'manaPack' : 'nft'
  const base: LootBagPosition = {
    positionId: id,
    kind,
    collection: pos.collection,
    tokenId: pos.tokenId.toString(),
    depositor: pos.depositor,
    backing: BigInt(pos.backing),
    packMana: BigInt(pos.packMana),
    active: Boolean(pos.active)
  }
  if (kind === 'nft') {
    try {
      const { itemId, issuedId } = decodeCollectionV2TokenId(pos.tokenId)
      base.itemId = itemId
      base.issuedId = issuedId.toString()
    } catch {
      /* ignore */
    }
  }
  base.imageUrl = resolvePositionMedia(base)
  return base
}

/** Attach marketplace names for unique DCL collections (best-effort). */
async function enrichPositionNames(positions: LootBagPosition[]): Promise<void> {
  const byCollection = new Map<string, LootBagPosition[]>()
  for (const p of positions) {
    if (p.kind !== 'nft') continue
    if (p.itemId == null) continue
    const c = p.collection.toLowerCase()
    if (c === ADDRESSES.mockWearable.toLowerCase()) continue
    const list = byCollection.get(c) ?? []
    list.push(p)
    byCollection.set(c, list)
  }
  await Promise.all(
    [...byCollection.entries()].map(async ([contract, list]) => {
      try {
        const items = await fetchCollectionItems(contract, { first: 100 })
        const byItem = new Map(items.map((it) => [it.itemId, it] as const))
        for (const p of list) {
          if (p.itemId == null) continue
          const it = byItem.get(p.itemId)
          if (!it) continue
          if (it.name) p.name = it.name
          if (it.thumbnail) p.imageUrl = it.thumbnail
          if (it.rarity) p.rarity = it.rarity.toLowerCase()
        }
      } catch {
        /* keep catalyst URL only */
      }
    })
  )
}

export async function fetchPoolSnapshot(): Promise<PoolSnapshot> {
  const client = polygonPublicClient
  const pool = ADDRESSES.lootBagPool

  const [
    acquisitionFee,
    activeCount,
    activeNftCount,
    activePackCount,
    nextPositionId,
    paused,
    testFulfillEnabled,
    depositorBidRateBpsRaw,
    protocolSettlementCutBpsRaw
  ] = await Promise.all([
    client.readContract({ address: pool, abi: lootBagPoolAbi, functionName: 'getAcquisitionFee' }),
    client.readContract({ address: pool, abi: lootBagPoolAbi, functionName: 'activeCount' }),
    client.readContract({ address: pool, abi: lootBagPoolAbi, functionName: 'activeNftCount' }),
    client.readContract({ address: pool, abi: lootBagPoolAbi, functionName: 'activePackCount' }),
    client.readContract({ address: pool, abi: lootBagPoolAbi, functionName: 'nextPositionId' }),
    client.readContract({ address: pool, abi: lootBagPoolAbi, functionName: 'paused' }),
    client.readContract({ address: pool, abi: lootBagPoolAbi, functionName: 'testFulfillEnabled' }),
    client.readContract({ address: pool, abi: lootBagPoolAbi, functionName: 'depositorBidRateBps' }),
    client.readContract({ address: pool, abi: lootBagPoolAbi, functionName: 'protocolSettlementCutBps' })
  ])

  // nextPositionId = next free id → valid positions are 1 … nextId-1
  const nextId = Number(nextPositionId as bigint)
  const lastId = Math.max(0, nextId - 1)
  // Prefer the most recent window when history is huge so new deposits always appear
  const scanEnd = lastId + 1 // exclusive
  const scanStart =
    lastId > MAX_POSITION_SCAN ? lastId - MAX_POSITION_SCAN + 1 : 1
  const positions: LootBagPosition[] = []

  // Smaller batches to avoid public RPC 429s
  const batchSize = 8
  for (let start = scanStart; start < scanEnd; start += batchSize) {
    const ids: number[] = []
    for (let id = start; id < Math.min(start + batchSize, scanEnd); id++) ids.push(id)
    const rows = await Promise.all(
      ids.map(async (id) => {
        try {
          const pos = (await client.readContract({
            address: pool,
            abi: lootBagPoolAbi,
            functionName: 'getPosition',
            args: [BigInt(id)]
          })) as RawPosition
          return { id, pos }
        } catch {
          return null
        }
      })
    )
    for (const row of rows) {
      if (!row) continue
      // viem may return a tuple array or a named struct
      const raw = row.pos as RawPosition & unknown[]
      const active = typeof raw.active === 'boolean' ? raw.active : Boolean((raw as unknown[])[8])
      if (!active) continue
      const p = toPosition(row.id, normalizeRawPosition(raw))
      if (p.depositor.toLowerCase() === ZERO && p.backing === 0n) continue
      positions.push(p)
    }
  }

  // Oldest → newest (new deposits land at the end of the shelf)
  positions.sort((a, b) => a.positionId - b.positionId)

  await enrichPositionNames(positions)

  const depositorBidRateBps = Math.min(
    10_000,
    Math.max(0, Number(depositorBidRateBpsRaw as number | bigint))
  )
  const protocolSettlementCutBps = Math.min(
    10_000,
    Math.max(0, Number(protocolSettlementCutBpsRaw as number | bigint))
  )

  return {
    acquisitionFee: acquisitionFee as bigint,
    activeCount: activeCount as bigint,
    activeNftCount: activeNftCount as bigint,
    activePackCount: activePackCount as bigint,
    nextPositionId: nextPositionId as bigint,
    paused: paused as boolean,
    testFulfillEnabled: testFulfillEnabled as boolean,
    depositorBidRateBps: Number.isFinite(depositorBidRateBps)
      ? depositorBidRateBps
      : 8500,
    protocolSettlementCutBps: Number.isFinite(protocolSettlementCutBps)
      ? protocolSettlementCutBps
      : 1500,
    positions
  }
}

export async function fetchWalletSnapshot(address: Address): Promise<WalletSnapshot> {
  const client = polygonPublicClient
  const [mana, claimable] = await Promise.all([
    client.readContract({
      address: ADDRESSES.mockMana,
      abi: mockManaAbi,
      functionName: 'balanceOf',
      args: [address]
    }),
    client.readContract({
      address: ADDRESSES.lootBagPool,
      abi: lootBagPoolAbi,
      functionName: 'claimable',
      args: [address]
    })
  ])

  const ownedTokenIds = await fetchMockWearableIds(address)

  // Real Catalyst inventory (Collection V2 + remaining mocks)
  let ownedNfts: WalletOwnedNft[] = []
  try {
    const items = await fetchWalletDepositNfts(address)
    ownedNfts = items.map((it) => ({
      id: it.id,
      collection: it.collection,
      tokenId: it.tokenId,
      name: it.name,
      rarity: it.rarity,
      imageUrl: it.imageUrl,
      urn: it.urn,
      itemId: it.itemId,
      issuedId: it.issuedId
    }))
  } catch {
    // Fallback: mock ids only
    ownedNfts = ownedTokenIds.map((id) => ({
      id: `${ADDRESSES.mockWearable.toLowerCase()}:${id}`,
      collection: ADDRESSES.mockWearable as Address,
      tokenId: String(id),
      name: `Mock Wearable #${id}`,
      rarity:
        id % 5 === 0 ? 'legendary' : id % 3 === 0 ? 'epic' : id % 2 === 0 ? 'rare' : 'common'
    }))
  }

  return {
    address,
    mana: mana as bigint,
    claimable: claimable as bigint,
    ownedTokenIds,
    ownedNfts
  }
}

/** MockWearable ownerOf scan (no enumerable). Exported for wallet inventory merge. */
export async function fetchMockWearableIds(address: Address): Promise<number[]> {
  const client = polygonPublicClient
  const me = address.toLowerCase()
  let bal = 0
  try {
    bal = Number(
      (await client.readContract({
        address: ADDRESSES.mockWearable,
        abi: mockWearableAbi,
        functionName: 'balanceOf',
        args: [address]
      })) as bigint
    )
  } catch {
    bal = 0
  }

  const ownedTokenIds: number[] = []
  if (bal <= 0) return ownedTokenIds

  const batchSize = 16
  for (let start = 1; start <= MAX_MOCK_WEARABLE_SCAN && ownedTokenIds.length < bal; start += batchSize) {
    const ids: number[] = []
    for (let id = start; id < start + batchSize && id <= MAX_MOCK_WEARABLE_SCAN; id++) ids.push(id)
    const rows = await Promise.all(
      ids.map(async (id) => {
        try {
          const o = (await client.readContract({
            address: ADDRESSES.mockWearable,
            abi: mockWearableAbi,
            functionName: 'ownerOf',
            args: [BigInt(id)]
          })) as Address
          return o.toLowerCase() === me ? id : null
        } catch {
          return null
        }
      })
    )
    for (const id of rows) {
      if (id != null) ownedTokenIds.push(id)
    }
  }
  ownedTokenIds.sort((a, b) => a - b)
  return ownedTokenIds
}

export async function findPendingWinForPurchaser(
  purchaser: Address,
  maxId?: number
): Promise<{ positionId: number; position: LootBagPosition | null } | null> {
  const client = polygonPublicClient
  const pool = ADDRESSES.lootBagPool
  let nextId = maxId
  if (nextId == null) {
    nextId = Number(
      (await client.readContract({
        address: pool,
        abi: lootBagPoolAbi,
        functionName: 'nextPositionId'
      })) as bigint
    )
  }
  const maxScan = Math.min(nextId, MAX_POSITION_SCAN)
  const me = purchaser.toLowerCase()

  for (let id = 1; id < maxScan; id++) {
    try {
      const raw = await client.readContract({
        address: pool,
        abi: lootBagPoolAbi,
        functionName: 'pendingByPosition',
        args: [BigInt(id)]
      })

      // viem may return a tuple array or a named object depending on ABI shape
      let purchaser: Address
      let exists: boolean
      if (Array.isArray(raw)) {
        purchaser = raw[0] as Address
        exists = Boolean(raw[2])
      } else {
        const o = raw as { purchaser: Address; exists: boolean }
        purchaser = o.purchaser
        exists = o.exists
      }

      if (!exists) continue
      if (purchaser.toLowerCase() !== me) continue

      let position: LootBagPosition | null = null
      try {
        const pos = (await client.readContract({
          address: pool,
          abi: lootBagPoolAbi,
          functionName: 'getPosition',
          args: [BigInt(id)]
        })) as RawPosition
        position = toPosition(id, pos)
      } catch {
        position = null
      }
      return { positionId: id, position }
    } catch {
      /* skip */
    }
  }
  return null
}
