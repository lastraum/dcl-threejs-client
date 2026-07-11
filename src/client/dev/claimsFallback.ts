/**
 * Offline placeholder registry — not live community claims.
 * Live claims load from GitHub docs/CLAIMS.yaml. Client version is package.json only.
 */
import type { ClaimsRegistry } from './claimsRegistry'

export const CLAIMS_FALLBACK: ClaimsRegistry = {
  schema_version: 2,
  updated: undefined,
  source: 'offline-placeholder',
  base_branch: 'dev-latest',
  workflow: []
}
