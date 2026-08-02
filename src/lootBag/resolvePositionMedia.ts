import { ADDRESSES } from './config'
import { collectionItemThumbnailUrl } from './creatorCollections'
import type { LootBagPosition } from './types'

/** Collection V2 packing: itemId in high 40 bits, issuedId in low 216 bits. */
const ISSUED_ID_BITS = 216n
/** Marketplace issue numbers are compact; full ERC-721 ids are ~70+ digits. */
const MAX_ISSUE_DIGITS = 18

export function decodeCollectionV2TokenId(tokenId: bigint | string): {
  itemId: number
  issuedId: bigint
} {
  const id = typeof tokenId === 'string' ? BigInt(String(tokenId).trim()) : tokenId
  const mask = (1n << ISSUED_ID_BITS) - 1n
  const issuedId = id & mask
  const itemId = Number(id >> ISSUED_ID_BITS)
  return { itemId: Number.isFinite(itemId) ? itemId : 0, issuedId }
}

function isMockWearableCollection(collection?: string | null): boolean {
  const c = (collection ?? '').toLowerCase()
  return !!c && c === ADDRESSES.mockWearable.toLowerCase()
}

/**
 * Human issue / edition number for a Collection V2 NFT.
 *
 * Marketplace URLs use the full packed token id, e.g.
 * `…/tokens/421249166674228746791672110734681729275580381602196445017243910245`
 * which decodes to itemId=4, issuedId=101 → display **Issue #101**.
 */
export function resolveIssuedId(
  tokenId: string | bigint | null | undefined,
  opts?: { collection?: string | null; knownIssuedId?: string | null }
): string | null {
  if (isMockWearableCollection(opts?.collection)) {
    if (tokenId == null || String(tokenId).length === 0) return null
    return String(tokenId)
  }

  // Compact known issue (never trust a packed full token stored as issuedId)
  const known = opts?.knownIssuedId?.trim()
  if (known && /^\d+$/.test(known) && known.length <= MAX_ISSUE_DIGITS) {
    return known.replace(/^0+(?=\d)/, '') || known
  }

  if (tokenId == null || String(tokenId).length === 0) return null
  try {
    const raw = typeof tokenId === 'bigint' ? tokenId : BigInt(String(tokenId).trim())
    const { itemId, issuedId } = decodeCollectionV2TokenId(raw)
    if (issuedId <= 0n) return null
    const s = issuedId.toString()
    // Packed DCL token (high bits set) or plain sequential / compact edition
    if (itemId > 0 || s.length <= MAX_ISSUE_DIGITS) return s
  } catch {
    /* ignore invalid token ids */
  }
  return null
}

/** `Issue #101` for DCL wearables; `Token #n` for mocks / undecodable ids. */
export function formatIssueLabel(
  tokenId: string | bigint | null | undefined,
  opts?: { collection?: string | null; knownIssuedId?: string | null }
): string {
  if (isMockWearableCollection(opts?.collection)) {
    return tokenId != null && String(tokenId).length > 0 ? `Token #${tokenId}` : 'Token'
  }
  const issue = resolveIssuedId(tokenId, opts)
  if (issue != null) return `Issue #${issue}`
  if (tokenId != null && String(tokenId).length > 0) return `Token #${tokenId}`
  return 'Token'
}

/**
 * Catalyst wearable thumbnail for a pool NFT position.
 * DCL Collection V2: peer lambdas `/collections/contents/{urn}:{itemId}/thumbnail`
 */
export function resolvePositionMedia(pos: LootBagPosition): string | undefined {
  if (pos.imageUrl) return pos.imageUrl
  if (pos.kind === 'manaPack') return undefined

  const collection = (pos.collection ?? '').toLowerCase()
  if (!/^0x[a-f0-9]{40}$/.test(collection)) return undefined

  // Mock stack tokens are plain sequential ids — no catalyst art
  if (isMockWearableCollection(collection)) return undefined

  try {
    const { itemId } = decodeCollectionV2TokenId(pos.tokenId)
    if (itemId < 0 || itemId > 1_000_000) return undefined
    return collectionItemThumbnailUrl(collection, itemId)
  } catch {
    return undefined
  }
}

/** Display-friendly issued id for Collection V2 (falls back to full tokenId). */
export function formatPositionTokenLabel(pos: LootBagPosition): string {
  if (pos.kind === 'manaPack') return 'MANA Pack'
  return formatIssueLabel(pos.tokenId, {
    collection: pos.collection,
    knownIssuedId: pos.issuedId
  })
}
