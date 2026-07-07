/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SUGGESTION_DISPATCH_URL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

declare module '*.proto?raw' {
  const content: string
  export default content
}
