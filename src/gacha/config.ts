/** Polygon mock stack — matches gacha/contracts/deployments/polygon-mocks.json */

export const CHAIN_ID = 137 as const

export const ADDRESSES = {
  /** UUPS proxy — use this for all pool calls / meta-tx verifyingContract */
  gachaPool: '0xF8fF7d4faD77d73f6D75139B0b20F9b9aB23D4Ac' as const,
  gachaPoolImplementation: '0xA4a37e186cf6b45dFcC5acc41cd74D9EFfEaf91B' as const,
  /** Legacy non-upgradeable mock pool (paused wind-down) */
  gachaPoolLegacyMock: '0xefb08A1917fD0163A7aF261E8D9D33695Ed80424' as const,
  mockMana: '0x36CA9B0BAf0aC2a0ee2ffcdf2e99aA7e556670BF' as const,
  mockWearable: '0xa824f0D13319b045cCa9348509a1570984801D6d' as const,
  realMana: '0xA1c57f48F0Deb89f569dFbE6E2B7f46D33606fD4' as const,
  realGachaPool: '0xC6705772c15674C033A28A8C0643cC094F6F1fa8' as const
}

/** EIP-712 domain name/version must match NativeMetaTransaction constructors */
export const META_TX_DOMAINS: Record<string, { name: string; version: string }> = {
  [ADDRESSES.gachaPool.toLowerCase()]: { name: 'GachaPool', version: '1' },
  [ADDRESSES.gachaPoolLegacyMock.toLowerCase()]: { name: 'GachaPool', version: '1' },
  [ADDRESSES.mockMana.toLowerCase()]: { name: 'MockMANA', version: '1' },
  [ADDRESSES.mockWearable.toLowerCase()]: { name: 'MockWearable', version: '1' }
}

/**
 * Meta-tx relay (Polygon self-relayer / Gelato).
 *
 * - Explicit `VITE_META_TX_URL` always wins.
 * - Dev default: same-origin `/v1/transactions` (Vite proxies to production — avoids CORS).
 * - Prod default: https://transactions.lastslice.co/v1/transactions
 *   (tx server must allow your client Origin in CORS_ORIGIN).
 */
export const META_TX_URL = (() => {
  const override = (import.meta.env.VITE_META_TX_URL as string | undefined)?.trim()
  if (override) return override
  if (import.meta.env.DEV) return '/v1/transactions'
  return 'https://transactions.lastslice.co/v1/transactions'
})()

export const POLYGON_RPC =
  (import.meta.env.VITE_POLYGON_RPC as string | undefined) ||
  'https://rpc-mainnet.matic.quiknode.pro'

/** Mock pool: same-tx pull without Chainlink VRF */
export const USE_TEST_FULFILL = true

/**
 * Client-side fake claim (no chain) to prototype win / settle UI.
 * Set false to use real meta-tx pull again.
 */
export const USE_FAKE_CLAIM =
  (import.meta.env.VITE_GACHA_FAKE_CLAIM as string | undefined) !== 'false'

export const EXPLORER_TX = 'https://polygonscan.com/tx/'

/** Cap position scan so a large nextPositionId cannot hang the UI */
export const MAX_POSITION_SCAN = 256

/** Must match GachaPoolUpgradeable.MAX_STOCK_PER_TX */
export const MAX_STOCK_PER_TX = 40
