import { APP_VERSION } from '../appVersion'
import { GITHUB_DOCS_REPO, suggestionDispatchUrl } from './githubDocs'

export const SUGGESTION_CATEGORIES = [
  'UX / polish',
  'Performance',
  'Parity gap (ECS / SDK7)',
  'Bug report',
  'Docs / dev panel',
  'Other'
] as const

export type SuggestionCategory = (typeof SUGGESTION_CATEGORIES)[number]

export type ClientSuggestionInput = {
  summary: string
  category: SuggestionCategory
  details: string
  contact?: string
  route?: string
}

export type ClientSuggestionPayload = ClientSuggestionInput & {
  client_version: string
  page_url: string
  user_agent: string
}

export type SubmitSuggestionResult = { ok: true } | { ok: false; error: string }

async function readDispatchError(res: Response): Promise<string> {
  const contentType = res.headers.get('content-type') ?? ''
  if (contentType.includes('application/json')) {
    try {
      const json = (await res.json()) as { error?: string }
      if (json.error) return json.error
    } catch {
      /* fall through */
    }
  }
  const text = await res.text().catch(() => '')
  if (text.trim().startsWith('<!')) {
    return 'Suggestion dispatch proxy unavailable. Restart dev server with SUGGESTION_DISPATCH_TOKEN set.'
  }
  return text.trim() || `Request failed (${res.status})`
}

function buildPayload(input: ClientSuggestionInput): ClientSuggestionPayload {
  return {
    summary: input.summary.trim(),
    category: input.category,
    details: input.details.trim(),
    contact: input.contact?.trim() || undefined,
    route: input.route?.trim() || undefined,
    client_version: APP_VERSION,
    page_url: typeof window !== 'undefined' ? window.location.href : '',
    user_agent: typeof navigator !== 'undefined' ? navigator.userAgent : ''
  }
}

/** Pre-filled GitHub issue form when dispatch proxy is unavailable. */
export function communitySuggestionNewIssueUrl(input: ClientSuggestionInput): string {
  const params = new URLSearchParams({
    template: 'suggestion.yml',
    title: `[suggestion] ${input.summary.trim().slice(0, 80)}`,
    summary: input.summary.trim(),
    category: input.category,
    details: input.details.trim()
  })
  if (input.contact?.trim()) params.set('contact', input.contact.trim())
  return `https://github.com/${GITHUB_DOCS_REPO}/issues/new?${params.toString()}`
}

export function communitySuggestionsIssuesUrl(): string {
  return `https://github.com/${GITHUB_DOCS_REPO}/issues?q=is%3Aopen+label%3Asuggestion`
}

export async function submitClientSuggestion(
  input: ClientSuggestionInput
): Promise<SubmitSuggestionResult> {
  const payload = buildPayload(input)
  const dispatchUrl = suggestionDispatchUrl()

  if (!dispatchUrl) {
    return {
      ok: false,
      error: 'Suggestion dispatch is disabled. Remove suggestionDispatch=0 from localStorage.'
    }
  }

  try {
    const res = await fetch(dispatchUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(payload)
    })
    if (!res.ok) {
      const error = await readDispatchError(res)
      if (res.status === 503) {
        return {
          ok: false,
          error: `${error} — export SUGGESTION_DISPATCH_TOKEN and restart npm run dev.`
        }
      }
      return { ok: false, error }
    }
    return { ok: true }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Network error'
    return { ok: false, error: message }
  }
}