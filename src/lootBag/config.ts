/** Polygon mock stack — matches gacha/contracts/deployments/polygon-mocks.json */

export const CHAIN_ID = 137 as const

export const ADDRESSES = {
  /** UUPS proxy — use this for all pool calls / meta-tx verifyingContract */
  lootBagPool: '0xF8fF7d4faD77d73f6D75139B0b20F9b9aB23D4Ac' as const,
  lootBagPoolImplementation: '0x0610C9Da3348d9f7baFc9fAedAa7Eba62F4Bb439' as const,
  /** Legacy non-upgradeable mock pool (paused wind-down) */
  lootBagPoolLegacyMock: '0xefb08A1917fD0163A7aF261E8D9D33695Ed80424' as const,
  mockMana: '0x36CA9B0BAf0aC2a0ee2ffcdf2e99aA7e556670BF' as const,
  mockWearable: '0xa824f0D13319b045cCa9348509a1570984801D6d' as const,
  realMana: '0xA1c57f48F0Deb89f569dFbE6E2B7f46D33606fD4' as const,
  realLootBagPool: '0xC6705772c15674C033A28A8C0643cC094F6F1fa8' as const
}

/** EIP-712 domain name/version must match NativeMetaTransaction constructors */
export const META_TX_DOMAINS: Record<string, { name: string; version: string }> = {
  [ADDRESSES.lootBagPool.toLowerCase()]: { name: 'GachaPool', version: '1' },
  [ADDRESSES.lootBagPoolLegacyMock.toLowerCase()]: { name: 'GachaPool', version: '1' },
  [ADDRESSES.mockMana.toLowerCase()]: { name: 'MockMANA', version: '1' },
  [ADDRESSES.mockWearable.toLowerCase()]: { name: 'MockWearable', version: '1' }
}

/**
 * Meta-tx relay (Polygon self-relayer / Gelato).
 *
 * ALWAYS same-origin by default — never hit transactions.lastslice.co from the
 * browser (CORS is broken for custom origins). Nginx + Vite proxy:
 *   /api/meta-tx/v1/transactions → https://transactions.lastslice.co/v1/transactions
 *
 * Override only for special cases (e.g. local self-relayer absolute URL is still
 * fine if it is same-origin or CORS-open).
 */
export const META_TX_URL = (() => {
  const override = (import.meta.env.VITE_META_TX_URL as string | undefined)?.trim()
  if (override) return override
  return '/api/meta-tx/v1/transactions'
})()

/**
 * Marketplace API for rarity / names.
 * Same-origin only — marketplace-api returns Access-Control-Allow-Origin: false
 * for dev.decentraland.social etc.
 *   /api/marketplace/v1/... → marketplace-api.decentraland.org/v1/...
 */
export const MARKETPLACE_API_BASE = (() => {
  const override = (import.meta.env.VITE_MARKETPLACE_API as string | undefined)?.trim()
  if (override) return override.replace(/\/$/, '')
  return '/api/marketplace/v1'
})()

/**
 * Polygon JSON-RPC. QuikNode free tier 429s under parallel scans.
 * Override with VITE_POLYGON_RPC.
 */
export const POLYGON_RPC =
  (import.meta.env.VITE_POLYGON_RPC as string | undefined)?.trim() ||
  'https://polygon-bor-rpc.publicnode.com'

/** Fallbacks if primary RPC rate-limits. */
export const POLYGON_RPC_FALLBACKS: readonly string[] = [
  'https://polygon-rpc.com',
  'https://rpc.ankr.com/polygon',
  'https://1rpc.io/matic'
]

/**
 * Client always uses RandomCoordinator (requestAcquisition → forge fulfill).
 * No client-side randomWord / requestAndFulfillForTest path.
 */

/**
 * Client-side fake claim (no chain) for local UI prototyping only.
 * Default off — real pull/settle. Set VITE_LOOTBAG_FAKE_CLAIM=true (or legacy
 * VITE_GACHA_FAKE_CLAIM) to re-enable mock.
 */
export const USE_FAKE_CLAIM =
  (import.meta.env.VITE_LOOTBAG_FAKE_CLAIM as string | undefined) === 'true' ||
  (import.meta.env.VITE_GACHA_FAKE_CLAIM as string | undefined) === 'true'

export const EXPLORER_TX = 'https://polygonscan.com/tx/'

/** Cap position scan so a large nextPositionId cannot hang the UI */
export const MAX_POSITION_SCAN = 256

/** MockWearable ownerOf scan ceiling (mint is sequential; leave headroom for mintId) */
export const MAX_MOCK_WEARABLE_SCAN = 256

/** Must match GachaPoolUpgradeable.MAX_STOCK_PER_TX */
export const MAX_STOCK_PER_TX = 40

/** Must match GachaPoolUpgradeable.MAX_BUNDLE_ITEMS */
export const MAX_BUNDLE_ITEMS = 5

/**
 * Share of position backing paid to the claimer when they **Take MANA** instead of
 * keeping the prize (basis points). Protocol takes the rest via settlement cut.
 * Default 8500 = 85% (e.g. 100 backing → 85 mMANA net). Overridden by on-chain
 * `depositorBidRateBps` when pool snapshot is loaded.
 */
export const DEFAULT_DEPOSITOR_BID_RATE_BPS = 8500
