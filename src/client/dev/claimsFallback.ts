/**
 * Offline CLAIMS.yaml snapshot for the dev panel when GitHub fetch is disabled.
 * Bundled at build/dev time via Vite `?raw` — does not rewrite this file on `npm run build`.
 */
import { parse as parseYaml } from 'yaml'
import claimsYaml from '../../../docs/CLAIMS.yaml?raw'
import type { ClaimsRegistry } from './claimsRegistry'

export const CLAIMS_FALLBACK: ClaimsRegistry = parseYaml(claimsYaml) as ClaimsRegistry
