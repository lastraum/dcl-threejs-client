import { ADDRESSES } from './config'
import { collectionItemThumbnailUrl } from './creatorCollections'
import type { GachaPosition } from './types'

/** Collection V2 packing: itemId in high 40 bits, issuedId in low 216 bits. */
const ISSUED_ID_BITS = 216n

export function decodeCollectionV2TokenId(tokenId: bigint | string): {
  itemId: number
  issuedId: bigint
} {
  const id = typeof tokenId === 'string' ? BigInt(tokenId) : tokenId
  const mask = (1n << ISSUED_ID_BITS) - 1n
  const issuedId = id & mask
  const itemId = Number(id >> ISSUED_ID_BITS)
  return { itemId: Number.isFinite(itemId) ? itemId : 0, issuedId }
}

/**
 * Catalyst wearable thumbnail for a pool NFT position.
 * DCL Collection V2: peer lambdas `/collections/contents/{urn}:{itemId}/thumbnail`
 */
export function resolvePositionMedia(pos: GachaPosition): string | undefined {
  if (pos.imageUrl) return pos.imageUrl
  if (pos.kind === 'manaPack') return undefined

  const collection = (pos.collection ?? '').toLowerCase()
  if (!/^0x[a-f0-9]{40}$/.test(collection)) return undefined

  // Mock stack tokens are plain sequential ids — no catalyst art
  if (collection === ADDRESSES.mockWearable.toLowerCase()) return undefined

  try {
    const { itemId } = decodeCollectionV2TokenId(pos.tokenId)
    if (itemId < 0 || itemId > 1_000_000) return undefined
    return collectionItemThumbnailUrl(collection, itemId)
  } catch {
    return undefined
  }
}

/** Display-friendly issued id for Collection V2 (falls back to full tokenId). */
export function formatPositionTokenLabel(pos: GachaPosition): string {
  if (pos.kind === 'manaPack') return 'MANA Pack'
  try {
    const { itemId, issuedId } = decodeCollectionV2TokenId(pos.tokenId)
    const collection = (pos.collection ?? '').toLowerCase()
    if (collection === ADDRESSES.mockWearable.toLowerCase()) {
      return `Token #${pos.tokenId}`
    }
    // Prefer issued edition number for DCL wearables
    if (issuedId > 0n && itemId >= 0) {
      return `#${issuedId.toString()}`
    }
  } catch {
    /* fall through */
  }
  return `Token #${pos.tokenId}`
}
