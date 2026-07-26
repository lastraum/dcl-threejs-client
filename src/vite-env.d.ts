/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SUGGESTION_DISPATCH_URL?: string
  /** Forge meta-tx endpoint (default /v1/transactions → vite proxy :5356) */
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
