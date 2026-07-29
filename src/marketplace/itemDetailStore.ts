import {
  fetchCollectionItems,
  fetchItem,
  fetchItemListings,
  fetchItemOffers,
  fetchItemOwners,
  fetchItemSales
} from './marketplaceApi'
import type { MarketplaceItem, MarketplaceItemDetailData } from './types'

/**
 * Load full asset detail: item, market tables, collection siblings.
 */
export async function loadItemDetail(
  contractAddress: string,
  itemId: string
): Promise<MarketplaceItemDetailData> {
  const contract = contractAddress.trim().toLowerCase()
  const id = itemId.trim()
  if (!/^0x[a-f0-9]{40}$/.test(contract) || !id) {
    throw new Error('Invalid item route')
  }

  const [item, salesRes, listingsRes, ownersRes, offersRes, collectionRes] =
    await Promise.all([
      fetchItem(contract, id),
      fetchItemSales(contract, id, 24).catch(() => []),
      fetchItemListings(contract, id, 24).catch(() => []),
      fetchItemOwners(contract, id, 48).catch(() => []),
      fetchItemOffers(contract, id, 24).catch(() => []),
      fetchCollectionItems(contract, 14).catch(() => [] as MarketplaceItem[])
    ])

  if (!item) throw new Error('Item not found')

  const moreFromCollection = collectionRes.filter((i) => i.id !== item.id).slice(0, 12)

  return {
    item,
    sales: salesRes,
    listings: listingsRes,
    owners: ownersRes,
    offers: offersRes,
    moreFromCollection
  }
}

/** Build detail route params from a list card item. */
export function itemRefFromMarketplaceItem(
  item: MarketplaceItem
): { contractAddress: string; itemId: string } | null {
  let contract = item.contractAddress?.trim().toLowerCase() ?? null
  let itemId = item.itemId?.trim() ?? null

  if ((!contract || !itemId) && item.id) {
    const m = /^(0x[a-f0-9]{40})-(.+)$/i.exec(item.id.trim())
    if (m) {
      contract = contract ?? m[1]!.toLowerCase()
      itemId = itemId ?? m[2]!
    }
  }

  if ((!contract || !itemId) && item.urn) {
    const parts = item.urn.split(':')
    const maybeContract = parts[parts.length - 2]
    const maybeId = parts[parts.length - 1]
    if (maybeContract && /^0x[a-f0-9]{40}$/i.test(maybeContract) && maybeId) {
      contract = contract ?? maybeContract.toLowerCase()
      itemId = itemId ?? maybeId
    }
  }

  if (!contract || !itemId || !/^0x[a-f0-9]{40}$/.test(contract)) return null
  return { contractAddress: contract, itemId }
}
