/** Fetch docs/CLAIMS.yaml — community "being worked on" list (synced from GitHub issues). */

import { parse as parseYaml } from 'yaml'
import { docsClaimsUrl, docsGithubFetchEnabled, resolveDocsBranch } from './githubDocs'
import { CLAIMS_FALLBACK } from './claimsFallback'

export type ClaimStatus = 'in_progress' | 'blocked'

export type CommunityClaim = {
  integration_ref: string
  title: string
  owner: string
  status: ClaimStatus
  issue: number
  issue_url: string
  started?: string
  notes?: string
}

export type ClaimsRegistry = {
  schema_version?: number
  updated?: string
  source?: string
  claims: CommunityClaim[]
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

function isClaimStatus(value: unknown): value is ClaimStatus {
  return value === 'in_progress' || value === 'blocked'
}

function normalizeRegistry(raw: unknown): ClaimsRegistry {
  if (!raw || typeof raw !== 'object') throw new Error('CLAIMS.yaml: expected mapping root')
  const obj = raw as Record<string, unknown>
  const claimsRaw = obj.claims
  if (!Array.isArray(claimsRaw)) throw new Error('CLAIMS.yaml: missing claims array')

  const claims: CommunityClaim[] = []
  for (const entry of claimsRaw) {
    if (!entry || typeof entry !== 'object') continue
    const c = entry as Record<string, unknown>
    const integration_ref = typeof c.integration_ref === 'string' ? c.integration_ref : ''
    const title = typeof c.title === 'string' ? c.title : integration_ref
    const owner = typeof c.owner === 'string' ? c.owner : 'unknown'
    const status = isClaimStatus(c.status) ? c.status : 'in_progress'
    const issue = typeof c.issue === 'number' ? c.issue : 0
    const issue_url = typeof c.issue_url === 'string' ? c.issue_url : ''
    if (!integration_ref || !issue) continue
    claims.push({
      integration_ref,
      title,
      owner,
      status,
      issue,
      issue_url,
      started: typeof c.started === 'string' ? c.started : undefined,
      notes: typeof c.notes === 'string' ? c.notes : undefined
    })
  }

  return {
    schema_version: typeof obj.schema_version === 'number' ? obj.schema_version : undefined,
    updated: typeof obj.updated === 'string' ? obj.updated : undefined,
    source: typeof obj.source === 'string' ? obj.source : undefined,
    claims
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

export const CLAIM_STATUS_LABEL: Record<ClaimStatus, string> = {
  in_progress: '🟡 In progress',
  blocked: '🔴 Blocked'
}