/** Fetch docs/PROGRESS.md from the public GitHub repo for the dev panel. */

import {
  docsGithubFetchEnabled,
  docsProgressBrowseUrl,
  docsProgressUrl,
  resolveDocsBranch
} from './githubDocs'
import { PROGRESS_FALLBACK } from './progressFallback'

export type ProgressLoadSource = 'github' | 'fallback'

export type ProgressLoadResult = {
  markdown: string
  source: ProgressLoadSource
  branch: string
  fetchedAt: number
}

let cached: ProgressLoadResult | null = null
let inflight: Promise<ProgressLoadResult> | null = null

export function progressMdUrl(branch = resolveDocsBranch()): string {
  return docsProgressUrl(branch)
}

export function progressBrowseUrl(branch = resolveDocsBranch()): string {
  return docsProgressBrowseUrl(branch)
}

/** Load PROGRESS.md from GitHub; fallback to bundled snapshot on failure. */
export async function loadProgressMarkdown(force = false): Promise<ProgressLoadResult> {
  if (!force && cached) return cached
  if (!force && inflight) return inflight

  const branch = resolveDocsBranch()

  const useFallback = (): ProgressLoadResult => {
    const result: ProgressLoadResult = {
      markdown: PROGRESS_FALLBACK,
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

  inflight = (async (): Promise<ProgressLoadResult> => {
    try {
      const res = await fetch(docsProgressUrl(branch), { cache: 'no-cache' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const markdown = await res.text()
      const result: ProgressLoadResult = {
        markdown,
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

/** First H1 title and "Last updated" line from markdown (for panel meta). */
export function parseProgressMeta(markdown: string): { title: string; lastUpdated?: string; phase?: string } {
  const title = markdown.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? 'Progress log'
  const lastUpdated = markdown.match(/\*\*Last updated:\*\*\s*([^\n]+)/)?.[1]?.trim()
  const phase = markdown.match(/\*\*Current phase:\*\*\s*([^\n]+)/)?.[1]?.trim()
  return { title, lastUpdated, phase }
}