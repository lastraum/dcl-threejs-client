import { APP_BUILD_DATE, APP_VERSION } from '../appVersion'
import { clientDebugLog } from '../debug/ClientDebugLog'
import { GITHUB_DOCS_REPO, bugReportNewIssueUrl } from './githubDocs'

export type BugOs = 'windows' | 'mac' | 'linux' | 'other'
export type BugBrowser = 'chrome' | 'safari' | 'opera' | 'brave' | 'edge' | 'other'

export type SubmitBugInput = {
  os: BugOs
  browser: BugBrowser
  description: string
}

export type SubmitBugResult =
  | { ok: true; mode: 'github_api'; issueUrl: string; issueNumber: number }
  | { ok: true; mode: 'github_url'; issueUrl: string }
  | { ok: false; error: string }

const OS_LABEL: Record<BugOs, string> = {
  windows: 'Windows',
  mac: 'macOS',
  linux: 'Linux',
  other: 'Other'
}

const BROWSER_LABEL: Record<BugBrowser, string> = {
  chrome: 'Chrome',
  safari: 'Safari',
  opera: 'Opera',
  brave: 'Brave',
  edge: 'Edge',
  other: 'Other'
}

export function detectBugOs(): BugOs {
  const ua = navigator.userAgent
  if (/Windows/i.test(ua)) return 'windows'
  if (/Mac OS X|Macintosh/i.test(ua)) return 'mac'
  if (/Linux/i.test(ua)) return 'linux'
  return 'other'
}

/** Brave often presents as Chrome — best-effort only. */
export function detectBugBrowser(): BugBrowser {
  const ua = navigator.userAgent
  if (/Edg\//i.test(ua)) return 'edge'
  if (/OPR\//i.test(ua) || /Opera/i.test(ua)) return 'opera'
  if (/Brave/i.test(ua)) return 'brave'
  if (/Chrome\//i.test(ua)) return 'chrome'
  if (/Safari/i.test(ua)) return 'safari'
  return 'other'
}

function buildIssueTitle(description: string): string {
  const oneLine = description.trim().replace(/\s+/g, ' ')
  const snippet = oneLine.length > 72 ? `${oneLine.slice(0, 69)}…` : oneLine
  return `[bug] ${snippet || 'Player report'}`
}

function buildIssueBody(input: SubmitBugInput): string {
  const lines = [
    '## Report',
    '',
    input.description.trim(),
    '',
    '## Environment',
    '',
    `- **OS:** ${OS_LABEL[input.os]}`,
    `- **Browser:** ${BROWSER_LABEL[input.browser]}`,
    `- **Client:** v${APP_VERSION} (${APP_BUILD_DATE})`,
    `- **URL:** ${window.location.href}`,
    `- **User agent:** \`${navigator.userAgent}\``,
    '',
    '## Recent client log (last 12 lines)',
    '',
    '```',
    clientDebugLog.formatEntriesForCopy().split('\n').slice(-12).join('\n') || '(empty)',
    '```',
    '',
    '_Submitted via dev panel → Submit bug._'
  ]
  return lines.join('\n')
}

export async function submitBugReport(input: SubmitBugInput): Promise<SubmitBugResult> {
  const description = input.description.trim()
  if (!description) return { ok: false, error: 'Please describe what happened.' }
  if (description.length > 8000) return { ok: false, error: 'Description is too long (max 8000 characters).' }

  const title = buildIssueTitle(description)
  const body = buildIssueBody(input)

  try {
    const res = await fetch('/api/report-bug', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title,
        body,
        os: input.os,
        browser: input.browser,
        description,
        version: APP_VERSION,
        buildDate: APP_BUILD_DATE,
        url: window.location.href,
        userAgent: navigator.userAgent
      })
    })

    if (res.ok) {
      const data = (await res.json()) as { issueUrl?: string; issueNumber?: number }
      if (data.issueUrl && typeof data.issueNumber === 'number') {
        return { ok: true, mode: 'github_api', issueUrl: data.issueUrl, issueNumber: data.issueNumber }
      }
      if (data.issueUrl) {
        return { ok: true, mode: 'github_url', issueUrl: data.issueUrl }
      }
    }
  } catch {
    /* fall through to prefilled GitHub URL */
  }

  const issueUrl = bugReportNewIssueUrl({ title, body })
  return { ok: true, mode: 'github_url', issueUrl }
}

export function openBugIssueUrl(url: string): void {
  window.open(url, '_blank', 'noopener,noreferrer')
}

export function bugReportRepoBrowseUrl(): string {
  return `https://github.com/${GITHUB_DOCS_REPO}/issues?q=is%3Aopen+label%3Abug`
}