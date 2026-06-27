/** Public docs repo — raw GitHub URLs for dev panel (CLAIMS.yaml, PROGRESS.md). */

export const GITHUB_DOCS_REPO = 'lastraum/dcl-threejs-client'
export const GITHUB_DOCS_RAW = 'https://raw.githubusercontent.com/lastraum/dcl-threejs-client'
export const GITHUB_DOCS_DEFAULT_BRANCH = 'dev-latest'

export function resolveDocsBranch(): string {
  if (typeof window === 'undefined') return GITHUB_DOCS_DEFAULT_BRANCH
  const params = new URLSearchParams(window.location.search)
  const fromQuery = params.get('docsBranch') ?? params.get('tasksBranch')
  if (fromQuery) return fromQuery
  try {
    const stored = localStorage.getItem('docsBranch') ?? localStorage.getItem('tasksBranch')
    if (stored) return stored
  } catch {
    /* ignore */
  }
  return GITHUB_DOCS_DEFAULT_BRANCH
}

/** Public repo — fetch live docs by default; `?docsGithubFetch=0` forces offline snapshots. */
export function docsGithubFetchEnabled(): boolean {
  if (typeof window === 'undefined') return false
  const params = new URLSearchParams(window.location.search)
  if (params.get('docsGithubFetch') === '0') return false
  try {
    if (localStorage.getItem('docsGithubFetch') === '0') return false
  } catch {
    /* ignore */
  }
  return import.meta.env.VITE_DOCS_GITHUB_FETCH !== 'false'
}

export function docsProgressUrl(branch = resolveDocsBranch()): string {
  return `${GITHUB_DOCS_RAW}/${branch}/docs/PROGRESS.md`
}

export function docsTasksYamlUrl(branch = resolveDocsBranch()): string {
  return `${GITHUB_DOCS_RAW}/${branch}/docs/TASKS.yaml`
}

export function docsProgressBrowseUrl(branch = resolveDocsBranch()): string {
  return `https://github.com/${GITHUB_DOCS_REPO}/blob/${branch}/docs/PROGRESS.md`
}

export function docsClaimsUrl(branch = resolveDocsBranch()): string {
  return `${GITHUB_DOCS_RAW}/${branch}/docs/CLAIMS.yaml`
}

export function docsClaimsBrowseUrl(branch = resolveDocsBranch()): string {
  return `https://github.com/${GITHUB_DOCS_REPO}/blob/${branch}/docs/CLAIMS.yaml`
}

/** New Task claim issue (community self-service). */
export function communityClaimNewIssueUrl(): string {
  return `https://github.com/${GITHUB_DOCS_REPO}/issues/new?template=task.yml`
}

/** Open issues labeled in-progress. */
export function communityClaimsIssuesUrl(): string {
  return `https://github.com/${GITHUB_DOCS_REPO}/issues?q=is%3Aopen+label%3Ain-progress`
}

/** New bug report issue (classic title/body prefilled — fallback when API unavailable). */
export function bugReportNewIssueUrl(input: { title: string; body: string }): string {
  const params = new URLSearchParams({
    title: input.title,
    body: input.body,
    labels: 'bug'
  })
  return `https://github.com/${GITHUB_DOCS_REPO}/issues/new?${params.toString()}`
}

/** Issue form template (manual fill when URL length limits apply). */
export function bugReportFormUrl(): string {
  return `https://github.com/${GITHUB_DOCS_REPO}/issues/new?template=bug.yml`
}