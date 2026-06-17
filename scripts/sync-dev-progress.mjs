#!/usr/bin/env node
/**
 * Prebuild sync — runs before `tsc && vite build`.
 *
 * Embeds offline snapshots for the dev panel when GitHub fetch is disabled:
 * - docs/CLAIMS.yaml → src/client/dev/claimsFallback.ts
 * - docs/PROGRESS.md → src/client/dev/progressFallback.ts
 * - docs/TASKS.yaml → src/client/dev/tasksFallback.ts (legacy shipped history only)
 *
 * Live community claims + progress load from github.com/lastraum/dcl-threejs-client at runtime.
 */
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml } from 'yaml'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..')
const CLAIMS_YAML_PATH = path.join(ROOT, 'docs/CLAIMS.yaml')
const CLAIMS_FALLBACK_PATH = path.join(ROOT, 'src/client/dev/claimsFallback.ts')
const TASKS_YAML_PATH = path.join(ROOT, 'docs/TASKS.yaml')
const TASKS_FALLBACK_PATH = path.join(ROOT, 'src/client/dev/tasksFallback.ts')
const PROGRESS_MD_PATH = path.join(ROOT, 'docs/PROGRESS.md')
const PROGRESS_FALLBACK_PATH = path.join(ROOT, 'src/client/dev/progressFallback.ts')
const PROGRESS_FALLBACK_MAX_CHARS = 24_000

async function syncProgressFallback() {
  const md = await readFile(PROGRESS_MD_PATH, 'utf8')
  const excerpt =
    md.length > PROGRESS_FALLBACK_MAX_CHARS
      ? `${md.slice(0, PROGRESS_FALLBACK_MAX_CHARS)}\n\n… (truncated — see GitHub PROGRESS.md)`
      : md
  const out = `/** Auto-generated from docs/PROGRESS.md by scripts/sync-dev-progress.mjs — do not edit manually. */

export const PROGRESS_FALLBACK = ${JSON.stringify(excerpt)}
`
  await writeFile(PROGRESS_FALLBACK_PATH, out, 'utf8')
}

async function syncClaimsFallback() {
  const yamlText = await readFile(CLAIMS_YAML_PATH, 'utf8')
  const parsed = parseYaml(yamlText)
  const json = JSON.stringify(parsed, null, 2)
  const out = `/** Auto-generated from docs/CLAIMS.yaml by scripts/sync-dev-progress.mjs — do not edit manually. */

import type { ClaimsRegistry } from './claimsRegistry'

export const CLAIMS_FALLBACK: ClaimsRegistry = ${json} as ClaimsRegistry
`
  await writeFile(CLAIMS_FALLBACK_PATH, out, 'utf8')
  return Array.isArray(parsed?.claims) ? parsed.claims.length : 0
}

async function syncTasksFallback() {
  const yamlText = await readFile(TASKS_YAML_PATH, 'utf8')
  const parsed = parseYaml(yamlText)
  const json = JSON.stringify(parsed, null, 2)
  const out = `/** Auto-generated from docs/TASKS.yaml by scripts/sync-dev-progress.mjs — do not edit manually. */

import type { TasksRegistry } from './tasksRegistry'

export const TASKS_FALLBACK: TasksRegistry = ${json} as TasksRegistry
`
  await writeFile(TASKS_FALLBACK_PATH, out, 'utf8')
  return Array.isArray(parsed?.tasks) ? parsed.tasks.length : 0
}

async function main() {
  await syncProgressFallback()
  const claimCount = await syncClaimsFallback()
  const taskCount = await syncTasksFallback()
  console.log(
    `sync-dev-progress: fallbacks refreshed (${claimCount} claims, ${taskCount} legacy tasks, PROGRESS.md snapshot)`
  )
}

main().catch((err) => {
  console.error('sync-dev-progress:', err.message)
  process.exit(1)
})