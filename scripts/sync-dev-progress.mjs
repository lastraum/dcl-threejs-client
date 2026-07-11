#!/usr/bin/env node
/**
 * @deprecated
 *
 * Client version: package.json → src/client/appVersion.ts
 * Progress / claims display: live GitHub fetch (githubDocs.ts + *Registry.ts)
 * Offline: short placeholders in *Fallback.ts (not progress snapshots)
 *
 * Nothing in the build rewrites tracked sources for version or progress.
 */
console.log(
  'sync-dev-progress: obsolete — version=package.json; progress/claims=live GitHub (offline=placeholder only).'
)
process.exit(0)
