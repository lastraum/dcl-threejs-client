/**
 * Parse SDK7 NftShape URN:
 * `urn:decentraland:<CHAIN>:<CONTRACT_STANDARD>:<CONTRACT_ADDRESS>:<TOKEN_ID>`
 */
export type ParsedNftUrn = {
  chain: string
  standard: string
  contract: string
  tokenId: string
  /** OpenSea-style chain segment used by opensea.decentraland.org proxy. */
  openseaChain: string
}

/** Map DCL URN network labels → OpenSea v2 chain path segments. */
const CHAIN_TO_OPENSEA: Record<string, string> = {
  ethereum: 'ethereum',
  eth: 'ethereum',
  mainnet: 'ethereum',
  matic: 'matic',
  polygon: 'matic',
  klaytn: 'klaytn',
  bsc: 'bsc',
  binance: 'bsc',
  arbitrum: 'arbitrum',
  arbitrum_nova: 'arbitrum_nova',
  avalanche: 'avalanche',
  optimism: 'optimism',
  solana: 'solana',
  base: 'base',
  blast: 'blast',
  zora: 'zora'
}

export function parseNftUrn(urn: string): ParsedNftUrn | null {
  const raw = urn?.trim()
  if (!raw) return null
  const m = raw.match(/^urn:decentraland:([^:]+):([^:]+):([^:]+):(.+)$/i)
  if (!m) return null
  const chain = m[1]!.toLowerCase()
  const standard = m[2]!.toLowerCase()
  const contract = m[3]!.toLowerCase()
  const tokenId = m[4]!
  const openseaChain = CHAIN_TO_OPENSEA[chain]
  if (!openseaChain) return null
  // Solana addresses are base58; EVM chains need 0x.
  if (openseaChain !== 'solana' && !contract.startsWith('0x')) return null
  return { chain, standard, contract, tokenId, openseaChain }
}

export function openseaNftApiUrl(parsed: ParsedNftUrn): string {
  return `https://opensea.decentraland.org/api/v2/chain/${parsed.openseaChain}/contract/${parsed.contract}/nfts/${encodeURIComponent(parsed.tokenId)}`
}

export function openseaAssetPageUrl(parsed: ParsedNftUrn): string {
  // OpenSea web uses "polygon" for matic chain path.
  const webChain = parsed.openseaChain === 'matic' ? 'polygon' : parsed.openseaChain
  return `https://opensea.io/assets/${webChain}/${parsed.contract}/${encodeURIComponent(parsed.tokenId)}`
}
