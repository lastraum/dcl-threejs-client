/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SUGGESTION_DISPATCH_URL?: string
  /** Pet Barn catalog JSON (default raw.githubusercontent.com/lastraum/petbarn/main/catalog.json) */
  readonly VITE_PETBARN_CATALOG_URL?: string
  /** Pet Barn publish worker (default dcl-petbarn-dispatch.lastraum.workers.dev). "0" disables. */
  readonly VITE_PETBARN_DISPATCH_URL?: string
  /** Meta-tx endpoint (default same-origin /api/meta-tx/v1/transactions) */
  readonly VITE_META_TX_URL?: string
  /** Polygon HTTP RPC for Loot Bag eth_call / receipts */
  readonly VITE_POLYGON_RPC?: string
  /** Marketplace API base (default same-origin /api/marketplace/v1) */
  readonly VITE_MARKETPLACE_API?: string
  /** Credits server base (default same-origin /api/credits) */
  readonly VITE_CREDITS_URL?: string
  /** Set to "false" to disable client fake claim (use real meta-tx pull) */
  readonly VITE_LOOTBAG_FAKE_CLAIM?: string
  /** @deprecated Use VITE_LOOTBAG_FAKE_CLAIM */
  readonly VITE_GACHA_FAKE_CLAIM?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

declare module '*.proto?raw' {
  const content: string
  export default content
}
