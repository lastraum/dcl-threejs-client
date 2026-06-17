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

/** Blockquote intro lines under the PROGRESS.md H1 (living doc, phase, links). */
export function parseProgressIntroLines(markdown: string): string[] {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n')
  const result: string[] = []
  let i = 0
  if (/^#\s+/.test(lines[i] ?? '')) i++
  while (i < lines.length && !lines[i].trim()) i++
  while (i < lines.length && /^>\s?/.test(lines[i])) {
    result.push(lines[i].replace(/^>\s?/, '').replace(/\s+$/, ''))
    i++
  }
  return result
}

/** Milestone body only — strips H1, intro blockquote, and leading horizontal rule. */
export function stripProgressIntro(markdown: string): string {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n')
  let i = 0
  if (/^#\s+/.test(lines[i] ?? '')) i++
  while (i < lines.length && !lines[i].trim()) i++
  while (i < lines.length && /^>\s?/.test(lines[i])) i++
  while (i < lines.length && !lines[i].trim()) i++
  if (lines[i]?.trim() === '---') i++
  while (i < lines.length && !lines[i].trim()) i++
  return lines.slice(i).join('\n').trim()
}