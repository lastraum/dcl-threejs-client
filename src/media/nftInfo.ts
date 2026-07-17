import { openseaAssetPageUrl, openseaNftApiUrl, parseNftUrn, type ParsedNftUrn } from './nftUrn'

export type NftInfo = {
  urn: string
  parsed: ParsedNftUrn
  name: string
  description: string
  imageUrl: string
  openseaUrl: string
  owner?: string
}

type OpenSeaNftPayload = {
  nft?: {
    name?: string | null
    description?: string | null
    image_url?: string | null
    display_image_url?: string | null
    original_image_url?: string | null
    opensea_url?: string | null
    owners?: Array<{ address?: string }>
  }
}

const infoCache = new Map<string, Promise<NftInfo | null>>()

/** Resolve NFT metadata + image via DCL OpenSea proxy (no API key). */
export function fetchNftInfo(urn: string): Promise<NftInfo | null> {
  const key = urn.trim()
  if (!key) return Promise.resolve(null)
  const hit = infoCache.get(key)
  if (hit) return hit
  const task = loadNftInfo(key).catch(() => null)
  infoCache.set(key, task)
  return task
}

async function loadNftInfo(urn: string): Promise<NftInfo | null> {
  const parsed = parseNftUrn(urn)
  if (!parsed) return null

  const res = await fetch(openseaNftApiUrl(parsed), {
    credentials: 'omit',
    headers: { Accept: 'application/json' }
  })
  if (!res.ok) return null
  const body = (await res.json()) as OpenSeaNftPayload
  const nft = body.nft
  if (!nft) return null

  const imageUrl =
    nft.display_image_url?.trim() ||
    nft.image_url?.trim() ||
    nft.original_image_url?.trim() ||
    ''
  if (!imageUrl) return null

  const owner = nft.owners?.[0]?.address?.trim()
  return {
    urn,
    parsed,
    name: nft.name?.trim() || `Token #${parsed.tokenId}`,
    description: nft.description?.trim() || '',
    imageUrl,
    openseaUrl: nft.opensea_url?.trim() || openseaAssetPageUrl(parsed),
    owner
  }
}
