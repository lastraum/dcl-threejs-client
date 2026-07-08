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

export const SUGGESTION_WORKER_URL =
  'https://dcl-threejs-client-suggestions.lastraum.workers.dev'

/** Dev: /api/suggestions (vite middleware). Prod: Cloudflare Worker unless overridden. */
export function suggestionDispatchUrl(): string | null {
  if (typeof window === 'undefined') return null
  const fromEnv = import.meta.env.VITE_SUGGESTION_DISPATCH_URL
  if (fromEnv === '0' || fromEnv === 'false') return null
  if (typeof fromEnv === 'string' && fromEnv.trim()) return fromEnv.trim()
  try {
    if (localStorage.getItem('suggestionDispatch') === '0') return null
  } catch {
    /* ignore */
  }
  if (import.meta.env.PROD) return SUGGESTION_WORKER_URL
  return '/api/suggestions'
}

/** New suggestion issue form (fallback when dispatch proxy is off). */
export function communitySuggestionTemplateUrl(): string {
  return `https://github.com/${GITHUB_DOCS_REPO}/issues/new?template=suggestion.yml`
}