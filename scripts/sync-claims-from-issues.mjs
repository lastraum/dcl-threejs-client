#!/usr/bin/env node
/**
 * Regenerate docs/CLAIMS.yaml — community workflow synced from GitHub issues + PRs.
 * Stages: in_progress (open in-progress issues) · pending_review (open PRs) · merged (recent merges).
 *
 * Used by .github/workflows/sync-community-claims.yml (GITHUB_TOKEN).
 * Local: GITHUB_REPOSITORY=lastraum/dcl-threejs-client GITHUB_TOKEN=$(gh auth token) node scripts/sync-claims-from-issues.mjs
 */
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { stringify as stringifyYaml } from 'yaml'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..')
const CLAIMS_PATH = path.join(ROOT, 'docs/CLAIMS.yaml')

const REPO = process.env.GITHUB_REPOSITORY ?? 'lastraum/dcl-threejs-client'
const TOKEN = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN
const DEFAULT_BASE = process.env.COMMUNITY_BASE_BRANCH ?? 'dev-latest'
const MERGED_PR_LIMIT = 20

const INTEGRATION_REF_RE = /\b(?:ecs|ui|net|sys|perf):[A-Za-z][\w-]*\b/

const STAGE_ORDER = { in_progress: 0, pending_review: 1, merged: 2 }

function parseField(body, label) {
  const re = new RegExp(`###\\s+${label}\\s*\\n+([^\\n#]+)`, 'i')
  const m = body.match(re)
  return m?.[1]?.trim() ?? ''
}

function integrationRefFromText(text) {
  const m = (text ?? '').match(INTEGRATION_REF_RE)
  return m?.[0] ?? ''
}

function integrationRefFromIssue(issue) {
  const fromForm = parseField(issue.body ?? '', 'Integration ref')
  if (fromForm) return fromForm
  const fromTaskId = parseField(issue.body ?? '', 'Task id')
  if (fromTaskId.startsWith('ecs:') || fromTaskId.startsWith('ui:') || fromTaskId.startsWith('net:')) {
    return fromTaskId
  }
  return integrationRefFromText(issue.body ?? '') || `issue:${issue.number}`
}

function integrationRefFromPr(pr) {
  const fromBody = integrationRefFromText(pr.body ?? '')
  if (fromBody) return fromBody
  const backtick = (pr.body ?? '').match(/`((?:ecs|ui|net|sys|perf):[^`]+)`/)
  if (backtick) return backtick[1]
  return `pr:${pr.number}`
}

function prTitle(pr) {
  return (pr.title ?? '').replace(/^(feat|fix|chore|docs)(\([^)]+\))?:\s*/i, '').trim() || `PR #${pr.number}`
}

function issueTitle(issue) {
  return (issue.title ?? '').replace(/^\[task\]\s*/i, '').trim() || `Issue #${issue.number}`
}

async function githubFetch(pathname) {
  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'dcl-threejs-client-sync-claims'
  }
  if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`

  const res = await fetch(`https://api.github.com${pathname}`, { headers })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`GitHub API ${res.status}: ${text.slice(0, 200)}`)
  }
  return res.json()
}

async function fetchAllPages(pathBuilder) {
  const items = []
  let page = 1
  for (;;) {
    const batch = await githubFetch(pathBuilder(page))
    if (!Array.isArray(batch) || batch.length === 0) break
    items.push(...batch)
    if (batch.length < 100) break
    page += 1
  }
  return items
}

async function fetchInProgressIssues() {
  const issues = await fetchAllPages(
    (page) => `/repos/${REPO}/issues?state=open&labels=in-progress&per_page=100&page=${page}`
  )
  const workflow = []
  for (const issue of issues) {
    if (issue.pull_request) continue
    const owner =
      parseField(issue.body ?? '', 'GitHub handle') ||
      issue.user?.login ||
      'unknown'
    workflow.push({
      stage: 'in_progress',
      integration_ref: integrationRefFromIssue(issue),
      title: issueTitle(issue),
      owner,
      issue: issue.number,
      issue_url: issue.html_url,
      updated: (issue.updated_at ?? issue.created_at ?? '').slice(0, 10) || undefined
    })
  }
  return workflow
}

async function fetchPullRequests(state) {
  return fetchAllPages(
    (page) =>
      `/repos/${REPO}/pulls?state=${state}&base=${DEFAULT_BASE}&sort=updated&direction=desc&per_page=100&page=${page}`
  )
}

async function buildWorkflow() {
  const workflow = await fetchInProgressIssues()

  const openPrs = await fetchPullRequests('open')
  for (const pr of openPrs) {
    if (pr.draft) continue
    workflow.push({
      stage: 'pending_review',
      integration_ref: integrationRefFromPr(pr),
      title: prTitle(pr),
      owner: pr.user?.login ?? 'unknown',
      pr: pr.number,
      pr_url: pr.html_url,
      updated: (pr.updated_at ?? pr.created_at ?? '').slice(0, 10) || undefined
    })
  }

  const closedPrs = await fetchPullRequests('closed')
  let mergedCount = 0
  for (const pr of closedPrs) {
    if (!pr.merged_at) continue
    workflow.push({
      stage: 'merged',
      integration_ref: integrationRefFromPr(pr),
      title: prTitle(pr),
      owner: pr.user?.login ?? 'unknown',
      pr: pr.number,
      pr_url: pr.html_url,
      updated: (pr.merged_at ?? '').slice(0, 10) || undefined
    })
    mergedCount += 1
    if (mergedCount >= MERGED_PR_LIMIT) break
  }

  workflow.sort((a, b) => {
    const stageDiff = (STAGE_ORDER[a.stage] ?? 9) - (STAGE_ORDER[b.stage] ?? 9)
    if (stageDiff !== 0) return stageDiff
    return (b.updated ?? '').localeCompare(a.updated ?? '')
  })

  return workflow
}

async function main() {
  const workflow = await buildWorkflow()
  const today = new Date().toISOString().slice(0, 10)
  const doc = {
    schema_version: 2,
    updated: today,
    source: 'github',
    base_branch: DEFAULT_BASE,
    workflow
  }
  const header = `# Community workflow — synced from GitHub issues + PRs.
# Do not edit manually; .github/workflows/sync-community-claims.yml updates this file.
#
# Stages: in_progress (open in-progress issues) · pending_review (open PRs) · merged (recent PRs into base_branch).
# Dev panel Community tab renders this as a single workflow table.

`
  await writeFile(CLAIMS_PATH, header + stringifyYaml(doc), 'utf8')
  const counts = workflow.reduce((acc, row) => {
    acc[row.stage] = (acc[row.stage] ?? 0) + 1
    return acc
  }, {})
  console.log(
    `sync-claims-from-issues: ${workflow.length} row(s) → docs/CLAIMS.yaml`,
    counts
  )
}

main().catch((err) => {
  console.error('sync-claims-from-issues:', err.message)
  process.exit(1)
})