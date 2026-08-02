import type { Address } from 'viem'
import { ADDRESSES, MAX_MOCK_WEARABLE_SCAN, MAX_POSITION_SCAN } from './config'
import { lootBagPoolAbi } from './abis/GachaPool'
import { mockManaAbi } from './abis/MockMANA'
import { mockWearableAbi } from './abis/MockWearable'
import { polygonPublicClient } from './polygonClient'
import type { LootBagPosition, PoolSnapshot, WalletOwnedNft, WalletSnapshot } from './types'
import { fetchWalletDepositNfts } from './walletInventory'
import {
  decodeCollectionV2TokenId,
  resolveIssuedId,
  resolvePositionMedia
} from './resolvePositionMedia'
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

function positionKindFromRaw(kind: number): LootBagPosition['kind'] {
  if (kind === 1) return 'manaPack'
  if (kind === 2) return 'bundle'
  return 'nft'
}

function toPosition(id: number, pos: RawPosition): LootBagPosition {
  const kind = positionKindFromRaw(Number(pos.kind))
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
  if (kind === 'nft' || kind === 'bundle') {
    try {
      const { itemId } = decodeCollectionV2TokenId(pos.tokenId)
      base.itemId = itemId
      const issue = resolveIssuedId(pos.tokenId, { collection: pos.collection })
      if (issue != null) base.issuedId = issue
    } catch {
      /* ignore */
    }
  }
  base.imageUrl = resolvePositionMedia(base)
  return base
}

async function loadBundleItems(positionId: number): Promise<LootBagPosition['bundleItems']> {
  try {
    const raw = (await polygonPublicClient.readContract({
      address: ADDRESSES.lootBagPool,
      abi: lootBagPoolAbi,
      functionName: 'getBundleItems',
      args: [BigInt(positionId)]
    })) as readonly { collection: Address; tokenId: bigint }[]
    return raw.map((it) => {
      const item: NonNullable<LootBagPosition['bundleItems']>[number] = {
        collection: it.collection,
        tokenId: it.tokenId.toString()
      }
      try {
        const { itemId } = decodeCollectionV2TokenId(it.tokenId)
        item.itemId = itemId
        const issue = resolveIssuedId(it.tokenId, { collection: it.collection })
        if (issue != null) item.issuedId = issue
      } catch {
        /* ignore */
      }
      return item
    })
  } catch {
    return undefined
  }
}

/** Attach marketplace names / rarity / thumbs for DCL Collection V2 (best-effort). */
export async function enrichLootBagPositions(positions: LootBagPosition[]): Promise<void> {
  // Load bundle item lists first
  await Promise.all(
    positions.map(async (p) => {
      if (p.kind !== 'bundle') return
      p.bundleItems = await loadBundleItems(p.positionId)
      if (p.bundleItems?.length) {
        p.name = p.name || `Bundle · ${p.bundleItems.length} items`
      }
    })
  )

  type EnrichTarget = {
    collection: string
    itemId: number
    apply: (name?: string, thumb?: string, rarity?: string) => void
  }
  const targets: EnrichTarget[] = []
  for (const p of positions) {
    if (p.kind === 'nft') {
      if (p.itemId == null) continue
      const c = p.collection.toLowerCase()
      if (c === ADDRESSES.mockWearable.toLowerCase()) {
        if (!p.rarity) p.rarity = 'epic'
        if (!p.name) p.name = `Mock wearable #${p.tokenId}`
        continue
      }
      targets.push({
        collection: c,
        itemId: p.itemId,
        apply: (name, thumb, rarity) => {
          if (name) p.name = name
          if (thumb) p.imageUrl = thumb
          if (rarity) p.rarity = rarity
        }
      })
    } else if (p.kind === 'bundle' && p.bundleItems) {
      for (const bi of p.bundleItems) {
        if (bi.itemId == null) continue
        const c = bi.collection.toLowerCase()
        if (c === ADDRESSES.mockWearable.toLowerCase()) {
          if (!bi.rarity) bi.rarity = 'epic'
          if (!bi.name) bi.name = `Mock wearable #${bi.tokenId}`
          continue
        }
        targets.push({
          collection: c,
          itemId: bi.itemId,
          apply: (name, thumb, rarity) => {
            if (name) bi.name = name
            if (thumb) bi.imageUrl = thumb
            if (rarity) bi.rarity = rarity
          }
        })
      }
      // Primary card chrome from first enriched item
      const first = p.bundleItems[0]
      if (first) {
        if (first.imageUrl) p.imageUrl = first.imageUrl
        if (first.rarity) p.rarity = first.rarity
        if (first.name) p.name = `Bundle · ${p.bundleItems.length} · ${first.name}`
      }
    }
  }

  const byCollection = new Map<string, EnrichTarget[]>()
  for (const t of targets) {
    const list = byCollection.get(t.collection) ?? []
    list.push(t)
    byCollection.set(t.collection, list)
  }
  await Promise.all(
    [...byCollection.entries()].map(async ([contract, list]) => {
      try {
        const items = await fetchCollectionItems(contract, { first: 100 })
        const byItem = new Map(items.map((it) => [it.itemId, it] as const))
        for (const t of list) {
          const it = byItem.get(t.itemId)
          if (!it) continue
          t.apply(
            it.name ?? undefined,
            it.thumbnail ?? undefined,
            it.rarity ? it.rarity.toLowerCase() : undefined
          )
        }
      } catch {
        /* keep catalyst URL only */
      }
    })
  )
  // Re-apply primary chrome after enrichment
  for (const p of positions) {
    if (p.kind !== 'bundle' || !p.bundleItems?.length) continue
    const first = p.bundleItems[0]
    if (first?.imageUrl) p.imageUrl = first.imageUrl
    if (first?.rarity) p.rarity = first.rarity
    const n = p.bundleItems.length
    p.name = first?.name ? `Bundle · ${n} · ${first.name}` : `Bundle · ${n} items`
  }
}

/** @deprecated use enrichLootBagPositions */
async function enrichPositionNames(positions: LootBagPosition[]): Promise<void> {
  return enrichLootBagPositions(positions)
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

/** Read `pendingByPosition[id]` without scanning the whole id space. */
export async function readPendingByPosition(
  positionId: number
): Promise<{ purchaser: Address; exists: boolean } | null> {
  if (!Number.isFinite(positionId) || positionId < 1) return null
  try {
    const raw = await polygonPublicClient.readContract({
      address: ADDRESSES.lootBagPool,
      abi: lootBagPoolAbi,
      functionName: 'pendingByPosition',
      args: [BigInt(positionId)]
    })
    if (Array.isArray(raw)) {
      return { purchaser: raw[0] as Address, exists: Boolean(raw[2]) }
    }
    const o = raw as { purchaser: Address; exists: boolean }
    return { purchaser: o.purchaser, exists: Boolean(o.exists) }
  } catch {
    return null
  }
}

async function loadPositionForPending(positionId: number): Promise<LootBagPosition | null> {
  try {
    const pos = (await polygonPublicClient.readContract({
      address: ADDRESSES.lootBagPool,
      abi: lootBagPoolAbi,
      functionName: 'getPosition',
      args: [BigInt(positionId)]
    })) as RawPosition
    const position = toPosition(positionId, normalizeRawPosition(pos))
    // Win is often inactive → not on the active shelf; enrich name/rarity here
    await enrichLootBagPositions([position])
    return position
  } catch {
    return null
  }
}

/**
 * Find an unsettled win for `purchaser`.
 * Prefer on-chain `pendingPositionOf` (O(1) after upgrade) → session hint → scan fallback.
 */
export async function findPendingWinForPurchaser(
  purchaser: Address,
  maxId?: number,
  hintPositionId?: number | null
): Promise<{ positionId: number; position: LootBagPosition | null } | null> {
  const client = polygonPublicClient
  const pool = ADDRESSES.lootBagPool
  const me = purchaser.toLowerCase()

  // 1) Hard one-at-a-time index (public mapping auto-getter) — preferred after pool upgrade
  try {
    const openId = Number(
      (await client.readContract({
        address: pool,
        abi: lootBagPoolAbi,
        functionName: 'pendingPositionOf',
        args: [purchaser]
      })) as bigint
    )
    if (Number.isFinite(openId) && openId >= 1) {
      const pending = await readPendingByPosition(openId)
      if (pending?.exists && pending.purchaser.toLowerCase() === me) {
        return {
          positionId: openId,
          position: await loadPositionForPending(openId)
        }
      }
    }
  } catch {
    /* pre-upgrade impl may lack pendingPositionOf — fall through */
  }

  // 2) Session / caller hint
  if (hintPositionId != null && hintPositionId >= 1) {
    const hinted = await readPendingByPosition(hintPositionId)
    if (hinted?.exists && hinted.purchaser.toLowerCase() === me) {
      return {
        positionId: hintPositionId,
        position: await loadPositionForPending(hintPositionId)
      }
    }
  }

  // 3) Legacy scan (pre-upgrade or stale index) — newest → oldest
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
  const lastId = Math.max(0, nextId - 1)
  if (lastId < 1) return null
  const scanStart = lastId > MAX_POSITION_SCAN ? lastId - MAX_POSITION_SCAN + 1 : 1

  for (let id = lastId; id >= scanStart; id--) {
    try {
      const pending = await readPendingByPosition(id)
      if (!pending?.exists) continue
      if (pending.purchaser.toLowerCase() !== me) continue
      return { positionId: id, position: await loadPositionForPending(id) }
    } catch {
      /* skip */
    }
  }
  return null
}
