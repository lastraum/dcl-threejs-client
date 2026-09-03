/**
 * Marketplace purchase announcements over the private-messages LiveKit room.
 *
 * Same pattern as Loot Bag claims:
 * - non-chat reliable data
 * - room broadcast topic
 * - reaches peers in the PM room across any scene
 *
 * Topic: `d3js-marketplace:purchases`
 * Magic: ASCII "D3M1"
 */

/** LiveKit data topic for marketplace purchase toasts (PM room). */
export const MARKETPLACE_PURCHASE_TOPIC = 'd3js-marketplace:purchases'

/** Binary payload magic: ASCII "D3M1" */
export const MARKETPLACE_PURCHASE_DATA_MAGIC = new Uint8Array([0x44, 0x33, 0x4d, 0x31])

export type MarketplacePurchaseWireMsg = {
  t: 'buy'
  /** Purchaser wallet (lowercase). */
  a: string
  /** Optional display name. */
  n?: string
  /** Item display name. */
  name: string
  /** Thumbnail URL. */
  img?: string
  /** Collection contract. */
  ca: string
  /** Collection item id. */
  iid: string
  /** Catalog id when known. */
  id?: string
  /** Rarity. */
  r?: string
  /** Unix ms. */
  at: number
}

export type MarketplaceItemIntent = {
  contractAddress: string
  itemId: string
  catalogId?: string
  name?: string
  thumbnail?: string
  rarity?: string
}

export function encodeMarketplacePurchasePacket(msg: MarketplacePurchaseWireMsg): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify(msg))
  const out = new Uint8Array(MARKETPLACE_PURCHASE_DATA_MAGIC.length + json.length)
  out.set(MARKETPLACE_PURCHASE_DATA_MAGIC, 0)
  out.set(json, MARKETPLACE_PURCHASE_DATA_MAGIC.length)
  return out
}

export function tryParseMarketplacePurchasePacket(data: Uint8Array): MarketplacePurchaseWireMsg | null {
  if (data.length < MARKETPLACE_PURCHASE_DATA_MAGIC.length + 2) return null
  for (let i = 0; i < MARKETPLACE_PURCHASE_DATA_MAGIC.length; i++) {
    if (data[i] !== MARKETPLACE_PURCHASE_DATA_MAGIC[i]) return null
  }
  try {
    const json = new TextDecoder().decode(data.subarray(MARKETPLACE_PURCHASE_DATA_MAGIC.length))
    return parsePurchaseObject(JSON.parse(json) as Record<string, unknown>)
  } catch {
    return null
  }
}

export function isMarketplacePurchaseTopic(topic: string | undefined | null): boolean {
  return (topic?.trim().toLowerCase() ?? '') === MARKETPLACE_PURCHASE_TOPIC
}

function parsePurchaseObject(o: Record<string, unknown>): MarketplacePurchaseWireMsg | null {
  if (o.t !== 'buy') return null
  const a = typeof o.a === 'string' ? o.a.trim().toLowerCase() : ''
  if (!/^0x[a-f0-9]{40}$/.test(a)) return null
  const ca = typeof o.ca === 'string' ? o.ca.trim().toLowerCase() : ''
  if (!/^0x[a-f0-9]{40}$/.test(ca)) return null
  const iid = typeof o.iid === 'string' && o.iid.trim() ? o.iid.trim().slice(0, 80) : ''
  if (!iid) return null
  const name =
    typeof o.name === 'string' && o.name.trim() ? o.name.trim().slice(0, 80) : 'Collectible'
  const at = typeof o.at === 'number' && Number.isFinite(o.at) ? o.at : Date.now()
  const n = typeof o.n === 'string' && o.n.trim() ? o.n.trim().slice(0, 48) : undefined
  const img = typeof o.img === 'string' && o.img.trim() ? o.img.trim().slice(0, 512) : undefined
  const id = typeof o.id === 'string' && o.id.trim() ? o.id.trim().slice(0, 128) : undefined
  const r = typeof o.r === 'string' && o.r.trim() ? o.r.trim().toLowerCase().slice(0, 24) : undefined
  return { t: 'buy', a, ca, iid, name, at, n, img, id, r }
}

export function purchaseIntentFromWire(msg: MarketplacePurchaseWireMsg): MarketplaceItemIntent {
  return {
    contractAddress: msg.ca,
    itemId: msg.iid,
    catalogId: msg.id,
    name: msg.name,
    thumbnail: msg.img,
    rarity: msg.r
  }
}
