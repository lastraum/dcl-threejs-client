/** Fetch docs/CLAIMS.yaml — community workflow (issues + PRs synced from GitHub). */

import { parse as parseYaml } from 'yaml'
import { docsClaimsUrl, docsGithubFetchEnabled, resolveDocsBranch } from './githubDocs'
import { CLAIMS_FALLBACK } from './claimsFallback'

export type WorkflowStage = 'in_progress' | 'pending_review' | 'merged'

export type WorkflowItem = {
  integration_ref: string
  title: string
  owner: string
  stage: WorkflowStage
  issue?: number
  issue_url?: string
  pr?: number
  pr_url?: string
  updated?: string
  notes?: string
}

/** @deprecated Use WorkflowItem — kept for legacy CLAIMS.yaml v1 */
export type CommunityClaim = WorkflowItem & {
  status: 'in_progress' | 'blocked'
  issue: number
  issue_url: string
  started?: string
}

export type ClaimsRegistry = {
  schema_version?: number
  updated?: string
  source?: string
  base_branch?: string
  workflow: WorkflowItem[]
}

export type ClaimsLoadSource = 'github' | 'fallback'

export type ClaimsLoadResult = {
  registry: ClaimsRegistry
  source: ClaimsLoadSource
  branch: string
  fetchedAt: number
}

let cached: ClaimsLoadResult | null = null
let inflight: Promise<ClaimsLoadResult> | null = null

export function claimsYamlUrl(branch = resolveDocsBranch()): string {
  return docsClaimsUrl(branch)
}

function isWorkflowStage(value: unknown): value is WorkflowStage {
  return value === 'in_progress' || value === 'pending_review' || value === 'merged'
}

function normalizeWorkflowEntry(entry: unknown): WorkflowItem | null {
  if (!entry || typeof entry !== 'object') return null
  const c = entry as Record<string, unknown>
  const integration_ref = typeof c.integration_ref === 'string' ? c.integration_ref : ''
  const title = typeof c.title === 'string' ? c.title : integration_ref
  const owner = typeof c.owner === 'string' ? c.owner : 'unknown'
  let stage: WorkflowStage | null = isWorkflowStage(c.stage) ? c.stage : null
  if (!stage && (c.status === 'in_progress' || c.status === 'blocked')) stage = 'in_progress'
  if (!stage || !integration_ref) return null

  const issue = typeof c.issue === 'number' ? c.issue : undefined
  const issue_url = typeof c.issue_url === 'string' ? c.issue_url : undefined
  const pr = typeof c.pr === 'number' ? c.pr : undefined
  const pr_url = typeof c.pr_url === 'string' ? c.pr_url : undefined
  const updated =
    typeof c.updated === 'string'
      ? c.updated
      : typeof c.started === 'string'
        ? c.started
        : undefined

  return {
    integration_ref,
    title,
    owner,
    stage,
    issue,
    issue_url,
    pr,
    pr_url,
    updated,
    notes: typeof c.notes === 'string' ? c.notes : undefined
  }
}

function normalizeRegistry(raw: unknown): ClaimsRegistry {
  if (!raw || typeof raw !== 'object') throw new Error('CLAIMS.yaml: expected mapping root')
  const obj = raw as Record<string, unknown>

  const workflowRaw = Array.isArray(obj.workflow)
    ? obj.workflow
    : Array.isArray(obj.claims)
      ? obj.claims
      : []
  const workflow: WorkflowItem[] = []
  for (const entry of workflowRaw) {
    const item = normalizeWorkflowEntry(entry)
    if (item) workflow.push(item)
  }

  return {
    schema_version: typeof obj.schema_version === 'number' ? obj.schema_version : undefined,
    updated: typeof obj.updated === 'string' ? obj.updated : undefined,
    source: typeof obj.source === 'string' ? obj.source : undefined,
    base_branch: typeof obj.base_branch === 'string' ? obj.base_branch : undefined,
    workflow
  }
}

export async function loadClaimsRegistry(force = false): Promise<ClaimsLoadResult> {
  if (!force && cached) return cached
  if (!force && inflight) return inflight

  const branch = resolveDocsBranch()

  const useFallback = (): ClaimsLoadResult => {
    const result: ClaimsLoadResult = {
      registry: CLAIMS_FALLBACK,
      source: 'fallback',
      branch,
      fetchedAt: Date.now()
    }
    cached = result
    return result
  }

  if (!docsGithubFetchEnabled()) {
    return Promise.resolve(useFallback())
  }

  inflight = (async () => {
    try {
      const res = await fetch(docsClaimsUrl(branch), { cache: 'no-store' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const text = await res.text()
      const parsed = parseYaml(text)
      const result: ClaimsLoadResult = {
        registry: normalizeRegistry(parsed),
        source: 'github',
        branch,
        fetchedAt: Date.now()
      }
      cached = result
      return result
    } catch {
      return useFallback()
    } finally {
      inflight = null
    }
  })()

  return inflight
}

export const WORKFLOW_STAGE_LABEL: Record<WorkflowStage, string> = {
  in_progress: '🟡 Being worked on',
  pending_review: '🟠 Pending review',
  merged: '🟢 Merged'
}

export const WORKFLOW_STAGE_ORDER: WorkflowStage[] = ['in_progress', 'pending_review', 'merged']