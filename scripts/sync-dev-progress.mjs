#!/usr/bin/env node
/**
 * @deprecated No longer used by `npm run build`.
 *
 * Dev-panel offline fallbacks import docs via Vite `?raw`:
 *   src/client/dev/progressFallback.ts → docs/PROGRESS.md
 *   src/client/dev/claimsFallback.ts   → docs/CLAIMS.yaml
 *   src/client/dev/tasksFallback.ts    → docs/TASKS.yaml
 *
 * That embeds the current docs at bundle time without rewriting tracked `.ts` files.
 */
console.log(
  'sync-dev-progress: obsolete — fallbacks use Vite ?raw imports of docs/*.md|yaml (no prebuild write).'
)
process.exit(0)
