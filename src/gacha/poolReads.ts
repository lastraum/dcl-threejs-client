import type { Address } from 'viem'
import { ADDRESSES, MAX_POSITION_SCAN } from './config'
import { gachaPoolAbi } from './abis/GachaPool'
import { mockManaAbi } from './abis/MockMANA'
import { mockWearableAbi } from './abis/MockWearable'
import { polygonPublicClient } from './polygonClient'
import type { GachaPosition, PoolSnapshot, WalletSnapshot } from './types'
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

function toPosition(id: number, pos: RawPosition): GachaPosition {
  const kind: GachaPosition['kind'] = pos.kind === 1 ? 'manaPack' : 'nft'
  const base: GachaPosition = {
    positionId: id,
    kind,
    collection: pos.collection,
    tokenId: pos.tokenId.toString(),
    depositor: pos.depositor,
    backing: BigInt(pos.backing),
    packMana: BigInt(pos.packMana),
    active: pos.active
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
async function enrichPositionNames(positions: GachaPosition[]): Promise<void> {
  const byCollection = new Map<string, GachaPosition[]>()
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
  const pool = ADDRESSES.gachaPool

  const [
    acquisitionFee,
    activeCount,
    activeNftCount,
    activePackCount,
    nextPositionId,
    paused,
    testFulfillEnabled
  ] = await Promise.all([
    client.readContract({ address: pool, abi: gachaPoolAbi, functionName: 'getAcquisitionFee' }),
    client.readContract({ address: pool, abi: gachaPoolAbi, functionName: 'activeCount' }),
    client.readContract({ address: pool, abi: gachaPoolAbi, functionName: 'activeNftCount' }),
    client.readContract({ address: pool, abi: gachaPoolAbi, functionName: 'activePackCount' }),
    client.readContract({ address: pool, abi: gachaPoolAbi, functionName: 'nextPositionId' }),
    client.readContract({ address: pool, abi: gachaPoolAbi, functionName: 'paused' }),
    client.readContract({ address: pool, abi: gachaPoolAbi, functionName: 'testFulfillEnabled' })
  ])

  const nextId = Number(nextPositionId as bigint)
  const maxScan = Math.min(nextId, MAX_POSITION_SCAN)
  const positions: GachaPosition[] = []

  // Parallel batches of 16 to keep RPC load reasonable
  const batchSize = 16
  for (let start = 1; start < maxScan; start += batchSize) {
    const ids: number[] = []
    for (let id = start; id < Math.min(start + batchSize, maxScan); id++) ids.push(id)
    const rows = await Promise.all(
      ids.map(async (id) => {
        try {
          const pos = (await client.readContract({
            address: pool,
            abi: gachaPoolAbi,
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
      const p = toPosition(row.id, row.pos)
      if (!p.active) continue
      if (p.depositor.toLowerCase() === ZERO && p.backing === 0n) continue
      positions.push(p)
    }
  }

  await enrichPositionNames(positions)

  return {
    acquisitionFee: acquisitionFee as bigint,
    activeCount: activeCount as bigint,
    activeNftCount: activeNftCount as bigint,
    activePackCount: activePackCount as bigint,
    nextPositionId: nextPositionId as bigint,
    paused: paused as boolean,
    testFulfillEnabled: testFulfillEnabled as boolean,
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
      address: ADDRESSES.gachaPool,
      abi: gachaPoolAbi,
      functionName: 'claimable',
      args: [address]
    })
  ])

  // Mock collection is small — probe token IDs 1..40 (admin pattern)
  const ownedTokenIds: number[] = []
  for (let id = 1; id <= 40; id++) {
    try {
      const o = (await client.readContract({
        address: ADDRESSES.mockWearable,
        abi: mockWearableAbi,
        functionName: 'ownerOf',
        args: [BigInt(id)]
      })) as Address
      if (o.toLowerCase() === address.toLowerCase()) ownedTokenIds.push(id)
    } catch {
      /* not minted */
    }
  }

  return {
    address,
    mana: mana as bigint,
    claimable: claimable as bigint,
    ownedTokenIds
  }
}

export async function findPendingWinForPurchaser(
  purchaser: Address,
  maxId?: number
): Promise<{ positionId: number; position: GachaPosition | null } | null> {
  const client = polygonPublicClient
  const pool = ADDRESSES.gachaPool
  let nextId = maxId
  if (nextId == null) {
    nextId = Number(
      (await client.readContract({
        address: pool,
        abi: gachaPoolAbi,
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
        abi: gachaPoolAbi,
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

      let position: GachaPosition | null = null
      try {
        const pos = (await client.readContract({
          address: pool,
          abi: gachaPoolAbi,
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
