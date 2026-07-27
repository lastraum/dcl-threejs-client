/**
 * Real wallet NFT inventory for grab-bag deposit.
 * Uses Catalyst lambdas (same path as backpack) — Polygon Collection V2 only.
 */
import { assetUrnFromCompleteUrn } from '../avatar/constants'
import { catalystPeerBaseUrl } from '../map/mapConfig'
import {
  fetchOwnedWearableUrns,
  loadBackpackWearables
} from '../client/ui/settings/backpackWearables'
import { collectionItemThumbnailUrl } from './creatorCollections'
import { ADDRESSES } from './config'
import type { Address } from 'viem'

export type WalletNftItem = {
  id: string
  kind: 'nft'
  /** ERC721 contract */
  collection: Address
  tokenId: string
  name: string
  rarity: string
  imageUrl?: string
  /** Full DCL item URN when known */
  urn?: string
  itemId?: number
  issuedId?: string
}

/** Parse `urn:decentraland:matic:collections-v2:0x…:itemId:tokenId` (or asset-only). */
export function parseCollectionsV2Urn(urn: string): {
  collection: Address
  itemId: number
  tokenId: string | null
} | null {
  const parts = urn.trim().split(':')
  if (parts.length < 6) return null
  if (parts[0] !== 'urn' || parts[1] !== 'decentraland') return null
  if (parts[3] !== 'collections-v2') return null
  const network = (parts[2] ?? '').toLowerCase()
  if (network !== 'matic' && network !== 'polygon') return null
  const contract = (parts[4] ?? '').toLowerCase()
  if (!/^0x[a-f0-9]{40}$/.test(contract)) return null
  const itemId = Number(parts[5])
  if (!Number.isFinite(itemId) || itemId < 0) return null
  // Full item urn has tokenId as 7th segment (or long numeric)
  let tokenId: string | null = null
  if (parts.length >= 7 && parts[6] != null && String(parts[6]).length > 0) {
    tokenId = String(parts[6])
  }
  return { collection: contract as Address, itemId, tokenId }
}

/**
 * Load depositable wearables for a wallet (real Collection V2 with token ids).
 * Skips off-chain base avatars and assets without a tokenId.
 */
export async function fetchWalletDepositNfts(
  address: string,
  opts?: { signal?: AbortSignal }
): Promise<WalletNftItem[]> {
  const addr = address.trim().toLowerCase()
  if (!/^0x[a-f0-9]{40}$/.test(addr)) return []

  const lambdas = `${catalystPeerBaseUrl()}/lambdas`
  // Full rows with individualData → real tokenIds
  const owned = await fetchOwnedWearableUrns(addr, lambdas)
  if (opts?.signal?.aborted) return []

  // Metadata for names/rarity/thumbs (best-effort)
  let metaByAsset = new Map<string, { name?: string; rarity?: string; thumbnailUrl?: string }>()
  try {
    const cards = await loadBackpackWearables(addr, lambdas)
    for (const c of cards) {
      const asset = assetUrnFromCompleteUrn(c.urn).toLowerCase()
      metaByAsset.set(asset, {
        name: c.name,
        rarity: c.rarity,
        thumbnailUrl: c.thumbnailUrl
      })
    }
  } catch {
    metaByAsset = new Map()
  }

  const out: WalletNftItem[] = []
  const seen = new Set<string>()

  for (const entry of owned) {
    const urn = entry.urn?.trim()
    if (!urn) continue
    const parsed = parseCollectionsV2Urn(urn)
    if (!parsed || !parsed.tokenId) continue

    const key = `${parsed.collection}:${parsed.tokenId}`
    if (seen.has(key)) continue
    seen.add(key)

    const assetUrn = assetUrnFromCompleteUrn(urn).toLowerCase()
    const meta = metaByAsset.get(assetUrn)
    const issuedId =
      parsed.tokenId.length < 20 && /^\d+$/.test(parsed.tokenId)
        ? parsed.tokenId
        : undefined

    out.push({
      id: key,
      kind: 'nft',
      collection: parsed.collection,
      tokenId: parsed.tokenId,
      name: meta?.name?.trim() || `Item #${parsed.itemId}`,
      rarity: (meta?.rarity || 'common').toLowerCase(),
      imageUrl:
        meta?.thumbnailUrl ||
        collectionItemThumbnailUrl(parsed.collection, parsed.itemId),
      urn,
      itemId: parsed.itemId,
      issuedId
    })
  }

  // Also include mock wearables still held (for transition / test wallets)
  try {
    const { fetchMockWearableIds } = await import('./poolReads')
    const mockIds = await fetchMockWearableIds(addr as Address)
    for (const id of mockIds) {
      const key = `${ADDRESSES.mockWearable.toLowerCase()}:${id}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push({
        id: key,
        kind: 'nft',
        collection: ADDRESSES.mockWearable as Address,
        tokenId: String(id),
        name: `Mock Wearable #${id}`,
        rarity:
          id % 5 === 0 ? 'legendary' : id % 3 === 0 ? 'epic' : id % 2 === 0 ? 'rare' : 'common'
      })
    }
  } catch {
    /* ignore mock scan failures */
  }

  out.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
  return out
}
