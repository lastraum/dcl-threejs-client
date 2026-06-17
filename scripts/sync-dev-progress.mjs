#!/usr/bin/env node
/**
 * Prebuild sync — runs before `tsc && vite build`.
 *
 * 1. Bumps package.json patch version
 * 2. Updates DEV_CHANGELOG[0].date in progressData.ts (new calendar day)
 * 3. Appends recent git commit subjects to changelog (deduped)
 * 4. Embeds docs/TASKS.yaml snapshot → src/client/dev/tasksFallback.ts (offline dev panel)
 */
import { execSync } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml } from 'yaml'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..')
const PROGRESS_PATH = path.join(ROOT, 'src/client/dev/progressData.ts')
const TASKS_YAML_PATH = path.join(ROOT, 'docs/TASKS.yaml')
const TASKS_FALLBACK_PATH = path.join(ROOT, 'src/client/dev/tasksFallback.ts')
const PKG_PATH = path.join(ROOT, 'package.json')

const MAX_NEW_COMMITS = 8
const GIT_ITEM_RE = /^\[[0-9a-f]{7,}\]\s/

function todayIso() {
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function parsePackageVersion(source) {
  return JSON.parse(source).version
}

function bumpPatchVersion(version) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-.+)?$/.exec(version)
  if (!m) return null
  return `${m[1]}.${m[2]}.${Number(m[3]) + 1}`
}

async function writePackageVersion(version) {
  const pkg = JSON.parse(await readFile(PKG_PATH, 'utf8'))
  pkg.version = version
  await writeFile(PKG_PATH, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8')
}

function parseFirstChangelogEntry(source) {
  const anchor = source.indexOf('export const DEV_CHANGELOG')
  if (anchor === -1) throw new Error('DEV_CHANGELOG not found in progressData.ts')

  const slice = source.slice(anchor)
  const dateMatch = slice.match(/date:\s*'(\d{4}-\d{2}-\d{2})'/)
  const itemsStart = slice.indexOf('items: [')
  if (!dateMatch || itemsStart === -1) {
    throw new Error('Could not parse first DEV_CHANGELOG entry')
  }

  let depth = 0
  let itemsEnd = -1
  for (let i = itemsStart + 'items: '.length; i < slice.length; i++) {
    const ch = slice[i]
    if (ch === '[') depth++
    else if (ch === ']') {
      depth--
      if (depth === 0) {
        itemsEnd = i
        break
      }
    }
  }
  if (itemsEnd === -1) throw new Error('Could not parse DEV_CHANGELOG items array')

  const itemsInner = slice.slice(itemsStart + 'items: ['.length, itemsEnd)
  const items = []
  for (const m of itemsInner.matchAll(/'((?:\\'|[^'])*)'/g)) {
    items.push(m[1].replace(/\\'/g, "'"))
  }

  const absoluteItemsStart = anchor + itemsStart + 'items: ['.length
  const absoluteItemsEnd = anchor + itemsEnd

  return {
    date: dateMatch[1],
    items,
    dateIndex: anchor + slice.indexOf(dateMatch[0]),
    dateLength: dateMatch[0].length,
    itemsInnerStart: absoluteItemsStart,
    itemsInnerEnd: absoluteItemsEnd
  }
}

function escapeTsString(value) {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
}

function formatItemsBlock(items) {
  if (items.length === 0) return '\n    '
  return `\n      ${items.map((item) => `'${escapeTsString(item)}'`).join(',\n      ')}\n    `
}

function isGitRepo() {
  try {
    execSync('git rev-parse --is-inside-work-tree', { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] })
    return true
  } catch {
    return false
  }
}

function collectGitCommits(sinceDate) {
  if (!isGitRepo()) return []

  const since = `${sinceDate}T23:59:59`
  let raw = ''
  try {
    raw = execSync(`git log --since="${since}" --format=%h|%s --no-merges`, {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim()
  } catch {
    return []
  }
  if (!raw) return []

  return raw
    .split('\n')
    .map((line) => {
      const sep = line.indexOf('|')
      if (sep === -1) return null
      const hash = line.slice(0, sep)
      const subject = line.slice(sep + 1).trim()
      if (!subject) return null
      return { hash, subject, line: `[${hash}] ${subject}` }
    })
    .filter(Boolean)
}

function existingGitHashes(items) {
  const hashes = new Set()
  for (const item of items) {
    const m = item.match(/^\[([0-9a-f]{7,})\]/)
    if (m) hashes.add(m[1])
  }
  return hashes
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
  const taskCount = Array.isArray(parsed?.tasks) ? parsed.tasks.length : 0
  return taskCount
}

async function main() {
  const today = todayIso()
  const [progressSource, pkgSource] = await Promise.all([
    readFile(PROGRESS_PATH, 'utf8'),
    readFile(PKG_PATH, 'utf8')
  ])

  let pkgVersion = parsePackageVersion(pkgSource)
  const entry = parseFirstChangelogEntry(progressSource)
  const previousDate = entry.date

  const knownHashes = existingGitHashes(entry.items)
  const manualItems = entry.items.filter((item) => !GIT_ITEM_RE.test(item))
  const keptGitItems = entry.items.filter((item) => GIT_ITEM_RE.test(item))

  const newCommits = collectGitCommits(previousDate).filter((c) => !knownHashes.has(c.hash))
  const newGitLines = newCommits.slice(0, MAX_NEW_COMMITS).map((c) => c.line)

  const isNewDay = previousDate !== today
  let pkgBumped = false

  if (!process.env.SKIP_VERSION_BUMP) {
    const bumped = bumpPatchVersion(pkgVersion)
    if (bumped && bumped !== pkgVersion) {
      pkgVersion = bumped
      await writePackageVersion(pkgVersion)
      pkgBumped = true
    }
  }

  const mergedItems = [...manualItems, ...newGitLines, ...keptGitItems.filter((item) => {
    const m = item.match(/^\[([0-9a-f]{7,})\]/)
    return m && !newCommits.some((c) => c.hash === m[1])
  })]

  let next = progressSource

  if (isNewDay) {
    next =
      next.slice(0, entry.dateIndex) +
      next.slice(entry.dateIndex, entry.dateIndex + entry.dateLength).replace(previousDate, today) +
      next.slice(entry.dateIndex + entry.dateLength)
  }

  if (newGitLines.length > 0) {
    const itemsBlock = formatItemsBlock(mergedItems)
    next = next.slice(0, entry.itemsInnerStart) + itemsBlock + next.slice(entry.itemsInnerEnd)
  }

  const taskCount = await syncTasksFallback()

  if (next === progressSource && !pkgBumped) {
    console.log(`sync-dev-progress: up to date (${today}, v${pkgVersion}, ${taskCount} tasks snapshot)`)
    return
  }

  if (next !== progressSource) {
    await writeFile(PROGRESS_PATH, next, 'utf8')
  }

  const parts = [`v${pkgVersion}`, `${taskCount} tasks snapshot`]
  if (isNewDay) parts.push(`lastUpdated=${today}`)
  if (newGitLines.length) parts.push(`+${newGitLines.length} commit(s)`)
  if (pkgBumped) parts.push('patch+1')
  console.log(`sync-dev-progress: updated (${parts.join(', ')})`)
}

main().catch((err) => {
  console.error('sync-dev-progress:', err.message)
  process.exit(1)
})
