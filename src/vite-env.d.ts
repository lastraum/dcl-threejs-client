/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SUGGESTION_DISPATCH_URL?: string
  /** Meta-tx endpoint (default https://transactions.lastslice.co/v1/transactions) */
  readonly VITE_META_TX_URL?: string
  /** Polygon HTTP RPC for gacha eth_call / receipts */
  readonly VITE_POLYGON_RPC?: string
  /** Set to "false" to disable client fake claim (use real meta-tx pull) */
  readonly VITE_GACHA_FAKE_CLAIM?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

declare module '*.proto?raw' {
  const content: string
  export default content
}
