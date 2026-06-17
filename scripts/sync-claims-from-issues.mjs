#!/usr/bin/env node
/**
 * Regenerate docs/CLAIMS.yaml from open GitHub issues labeled in-progress.
 * Used by .github/workflows/sync-community-claims.yml (GITHUB_TOKEN).
 * Local dry-run: GITHUB_REPOSITORY=lastraum/dcl-threejs-client node scripts/sync-claims-from-issues.mjs
 */
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { stringify as stringifyYaml } from 'yaml'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..')
const CLAIMS_PATH = path.join(ROOT, 'docs/CLAIMS.yaml')

const REPO = process.env.GITHUB_REPOSITORY ?? 'lastraum/dcl-threejs-client'
const TOKEN = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN

function parseField(body, label) {
  const re = new RegExp(`###\\s+${label}\\s*\\n+([^\\n#]+)`, 'i')
  const m = body.match(re)
  return m?.[1]?.trim() ?? ''
}

function integrationRefFromIssue(issue) {
  const fromForm = parseField(issue.body ?? '', 'Integration ref')
  if (fromForm) return fromForm
  const fromTaskId = parseField(issue.body ?? '', 'Task id')
  if (fromTaskId.startsWith('ecs:') || fromTaskId.startsWith('ui:') || fromTaskId.startsWith('net:')) {
    return fromTaskId
  }
  return `issue:${issue.number}`
}

async function fetchInProgressIssues() {
  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'dcl-threejs-client-sync-claims'
  }
  if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`

  const claims = []
  let page = 1
  for (;;) {
    const url = `https://api.github.com/repos/${REPO}/issues?state=open&labels=in-progress&per_page=100&page=${page}`
    const res = await fetch(url, { headers })
    if (!res.ok) {
      const text = await res.text()
      throw new Error(`GitHub API ${res.status}: ${text.slice(0, 200)}`)
    }
    const batch = await res.json()
    if (!Array.isArray(batch) || batch.length === 0) break
    for (const issue of batch) {
      if (issue.pull_request) continue
      const owner =
        parseField(issue.body ?? '', 'GitHub handle') ||
        issue.user?.login ||
        'unknown'
      claims.push({
        integration_ref: integrationRefFromIssue(issue),
        title: (issue.title ?? '').replace(/^\[task\]\s*/i, '').trim() || `Issue #${issue.number}`,
        owner,
        status: 'in_progress',
        issue: issue.number,
        issue_url: issue.html_url,
        started: (issue.created_at ?? '').slice(0, 10) || undefined
      })
    }
    if (batch.length < 100) break
    page += 1
  }

  claims.sort((a, b) => a.issue - b.issue)
  return claims
}

async function main() {
  const claims = await fetchInProgressIssues()
  const today = new Date().toISOString().slice(0, 10)
  const doc = {
    schema_version: 1,
    updated: today,
    source: 'github-issues',
    claims
  }
  const header = `# Community work claims — synced from GitHub issues (label: in-progress).
# Do not edit manually on main; .github/workflows/sync-community-claims.yml updates this file.
#
# Contributors: open a Task claim issue → add in-progress label → appears here + dev panel.
# Gaps to pick from: dev panel Community tab (integrationRegistry parity matrix).

`
  await writeFile(CLAIMS_PATH, header + stringifyYaml(doc), 'utf8')
  console.log(`sync-claims-from-issues: ${claims.length} claim(s) → docs/CLAIMS.yaml`)
}

main().catch((err) => {
  console.error('sync-claims-from-issues:', err.message)
  process.exit(1)
})