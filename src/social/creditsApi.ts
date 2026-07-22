/**
 * Decentraland Credits Server API.
 * @see https://docs.decentraland.org/apis/apis/credits-server/credits
 * @see https://docs.decentraland.org/apis/apis/credits-server/seasons
 */

const CREDITS_URL =
  (import.meta.env.VITE_CREDITS_URL as string | undefined)?.trim().replace(/\/$/, '') ||
  'https://credits.decentraland.org'

export const MARKETPLACE_URL =
  (import.meta.env.VITE_MARKETPLACE_URL as string | undefined)?.trim().replace(/\/$/, '') ||
  'https://decentraland.org/marketplace'

export type CreditStatus = 'AVAILABLE' | 'PARTIALLY_USED' | 'USED' | 'EXPIRED'

export type UserCredit = {
  id: string
  amount: number
  status: CreditStatus
  createdAt?: string
  expiresAt?: string
  signature?: string
  seasonId?: number
  goalId?: string
}

export type UserCreditsResponse = {
  credits: UserCredit[]
  totalCredits: number
}

export type SeasonInfo = {
  id: number
  name: string
  description?: string
  startDate?: string
  endDate?: string
  isActive: boolean
  maxMana?: number
}

export type SeasonsResponse = {
  past: SeasonInfo[]
  current?: SeasonInfo | null
  next?: SeasonInfo | null
}

export type FetchCreditsResult =
  | { ok: true; data: UserCreditsResponse }
  | { ok: false; status: number; error: string; flagged?: boolean }

export type FetchSeasonsResult =
  | { ok: true; data: SeasonsResponse }
  | { ok: false; status: number; error: string }

export function getCreditsBaseUrl(): string {
  return CREDITS_URL
}

function normalizeAddress(address: string): string | null {
  const a = address.trim().toLowerCase()
  return /^0x[a-f0-9]{40}$/.test(a) ? a : null
}

function parseCredit(raw: unknown): UserCredit | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  if (typeof o.id !== 'string' || !o.id.trim()) return null
  if (typeof o.amount !== 'number' || !Number.isFinite(o.amount)) return null
  if (typeof o.status !== 'string') return null
  return {
    id: o.id.trim(),
    amount: o.amount,
    status: o.status as CreditStatus,
    createdAt: typeof o.createdAt === 'string' ? o.createdAt : undefined,
    expiresAt: typeof o.expiresAt === 'string' ? o.expiresAt : undefined,
    signature: typeof o.signature === 'string' ? o.signature : undefined,
    seasonId: typeof o.seasonId === 'number' ? o.seasonId : undefined,
    goalId: typeof o.goalId === 'string' ? o.goalId : undefined
  }
}

function parseSeason(raw: unknown): SeasonInfo | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  if (typeof o.id !== 'number' || !Number.isFinite(o.id)) return null
  if (typeof o.name !== 'string' || !o.name.trim()) return null
  return {
    id: o.id,
    name: o.name.trim(),
    description: typeof o.description === 'string' ? o.description : undefined,
    startDate: typeof o.startDate === 'string' ? o.startDate : undefined,
    endDate: typeof o.endDate === 'string' ? o.endDate : undefined,
    isActive: o.isActive === true,
    maxMana: typeof o.maxMana === 'number' ? o.maxMana : undefined
  }
}

/**
 * GET /users/{address}/credits — public (no signed fetch).
 * Optional status filter: AVAILABLE | PARTIALLY_USED.
 */
export async function fetchUserCredits(
  address: string,
  opts?: { status?: 'AVAILABLE' | 'PARTIALLY_USED' }
): Promise<FetchCreditsResult> {
  const addr = normalizeAddress(address)
  if (!addr) return { ok: false, status: 400, error: 'Invalid address' }

  const params = new URLSearchParams()
  if (opts?.status) params.set('status', opts.status)
  const qs = params.toString()
  const url = `${CREDITS_URL}/users/${addr}/credits${qs ? `?${qs}` : ''}`

  let res: Response
  try {
    res = await fetch(url, { method: 'GET', headers: { Accept: 'application/json' } })
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    return { ok: false, status: 503, error: `credits_unreachable: ${detail}` }
  }

  let body: unknown
  try {
    body = await res.json()
  } catch {
    body = null
  }

  if (res.status === 401) {
    const message =
      body && typeof body === 'object' && typeof (body as { message?: unknown }).message === 'string'
        ? (body as { message: string }).message
        : 'Account flagged for credits'
    return { ok: false, status: 401, error: message, flagged: true }
  }

  if (!res.ok) {
    const error =
      body && typeof body === 'object' && typeof (body as { error?: unknown }).error === 'string'
        ? (body as { error: string }).error
        : res.statusText || 'credits_fetch_failed'
    return { ok: false, status: res.status, error }
  }

  const creditsRaw =
    body && typeof body === 'object' && Array.isArray((body as { credits?: unknown }).credits)
      ? (body as { credits: unknown[] }).credits
      : []
  const credits: UserCredit[] = []
  for (const c of creditsRaw) {
    const parsed = parseCredit(c)
    if (parsed) credits.push(parsed)
  }
  const totalCredits =
    body && typeof body === 'object' && typeof (body as { totalCredits?: unknown }).totalCredits === 'number'
      ? (body as { totalCredits: number }).totalCredits
      : credits.reduce((s, c) => s + c.amount, 0)

  return { ok: true, data: { credits, totalCredits } }
}

/** GET /seasons — past / current / next. */
export async function fetchSeasons(): Promise<FetchSeasonsResult> {
  const url = `${CREDITS_URL}/seasons`
  let res: Response
  try {
    res = await fetch(url, { method: 'GET', headers: { Accept: 'application/json' } })
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    return { ok: false, status: 503, error: `seasons_unreachable: ${detail}` }
  }

  let body: unknown
  try {
    body = await res.json()
  } catch {
    body = null
  }

  if (!res.ok) {
    const error =
      body && typeof body === 'object' && typeof (body as { error?: unknown }).error === 'string'
        ? (body as { error: string }).error
        : res.statusText || 'seasons_fetch_failed'
    return { ok: false, status: res.status, error }
  }

  if (!body || typeof body !== 'object') {
    return { ok: false, status: res.status, error: 'invalid_seasons_response' }
  }

  const o = body as Record<string, unknown>
  const pastRaw = Array.isArray(o.past) ? o.past : []
  const past: SeasonInfo[] = []
  for (const s of pastRaw) {
    const p = parseSeason(s)
    if (p) past.push(p)
  }

  const current = o.current == null ? null : parseSeason(o.current)
  const next = o.next == null ? null : parseSeason(o.next)

  return {
    ok: true,
    data: {
      past,
      current: current ?? null,
      next: next ?? null
    }
  }
}

/** Latest past season if no current (Explorer “Season N Has Closed” copy). */
export function latestClosedSeason(seasons: SeasonsResponse): SeasonInfo | null {
  if (seasons.current?.isActive) return null
  if (!seasons.past.length) return null
  return [...seasons.past].sort((a, b) => b.id - a.id)[0] ?? null
}

export function formatCreditsAmount(n: number): string {
  if (!Number.isFinite(n)) return '0'
  if (Number.isInteger(n)) return String(n)
  return n.toLocaleString(undefined, { maximumFractionDigits: 2 })
}
