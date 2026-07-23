/**
 * Comms-gatekeeper `/scene-bans` — list / ban / unban for a world or parcel.
 * Owner/admin signed fetch with the same kernel metadata as scene-stream-access.
 *
 * @see https://docs.decentraland.org/apis/apis/comms-gatekeeper/scene-bans
 */
import type { AuthIdentity } from '@dcl/crypto/dist/types'
import signedFetch from 'decentraland-crypto-fetch'
import { GATEKEEPER_URL } from './GatekeeperClient'
import {
  kernelSceneStreamMetadata,
  type SceneStreamAccessParams
} from './sceneStreamAccess'

/** Same place context as stream access (sceneId + parcel + realm). */
export type SceneBanParams = SceneStreamAccessParams

export type SceneBanEntry = {
  bannedAddress: string
  name: string
}

export type SceneBanListPage = {
  results: SceneBanEntry[]
  total: number
  page: number
  pages: number
  limit: number
}

export type SceneBanListResult =
  | { ok: true; status: number; data: SceneBanListPage }
  | { ok: false; status: number; error: string }

export type SceneBanMutationResult =
  | { ok: true; status: number }
  | { ok: false; status: number; error: string }

export type SceneBanTarget = {
  bannedAddress?: string
  bannedName?: string
}

function gatekeeperError(body: unknown, statusText: string): string {
  if (body && typeof body === 'object' && 'error' in body) {
    const e = (body as { error: unknown }).error
    if (typeof e === 'string' && e.trim()) return e.trim()
  }
  return statusText || 'gatekeeper_error'
}

async function readJsonBody(res: Response): Promise<unknown> {
  if (res.status === 204) return null
  try {
    const text = await res.text()
    if (!text) return null
    return JSON.parse(text)
  } catch {
    return null
  }
}

function parseBanEntry(raw: unknown): SceneBanEntry | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const o = raw as Record<string, unknown>
  const bannedAddress =
    (typeof o.bannedAddress === 'string' && o.bannedAddress.trim()) ||
    (typeof o.banned_address === 'string' && o.banned_address.trim()) ||
    ''
  const name =
    (typeof o.name === 'string' && o.name.trim()) ||
    (typeof o.banned_name === 'string' && o.banned_name.trim()) ||
    (typeof o.bannedName === 'string' && o.bannedName.trim()) ||
    ''
  if (!bannedAddress && !name) return null
  return { bannedAddress, name }
}

function parseBanListPage(body: unknown, fallbackLimit: number): SceneBanListPage {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { results: [], total: 0, page: 1, pages: 0, limit: fallbackLimit }
  }
  const o = body as Record<string, unknown>
  const rawResults = Array.isArray(o.results)
    ? o.results
    : Array.isArray(o.bans)
      ? o.bans
      : []
  const results = rawResults
    .map(parseBanEntry)
    .filter((e): e is SceneBanEntry => e != null)
  const total = typeof o.total === 'number' && Number.isFinite(o.total) ? o.total : results.length
  const page = typeof o.page === 'number' && Number.isFinite(o.page) ? o.page : 1
  const pages =
    typeof o.pages === 'number' && Number.isFinite(o.pages)
      ? o.pages
      : total > 0
        ? Math.ceil(total / Math.max(1, fallbackLimit))
        : 0
  const limit =
    typeof o.limit === 'number' && Number.isFinite(o.limit) ? o.limit : fallbackLimit
  return { results, total, page, pages, limit }
}

function banBody(target: SceneBanTarget): Record<string, string> | null {
  const body: Record<string, string> = {}
  const address = target.bannedAddress?.trim()
  const name = target.bannedName?.trim()
  if (address) body.banned_address = address
  if (name) body.banned_name = name
  if (!body.banned_address && !body.banned_name) return null
  return body
}

async function signedSceneBanRequest(
  identity: AuthIdentity,
  params: SceneBanParams,
  init: { method: string; path?: string; query?: string; body?: string }
): Promise<{ status: number; body: unknown; ok: boolean }> {
  const base = GATEKEEPER_URL.replace(/\/$/, '')
  const path = init.path ?? '/scene-bans'
  const url = `${base}${path}${init.query ?? ''}`
  const metadata = kernelSceneStreamMetadata(params)
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (init.body) headers['Content-Type'] = 'application/json'
  let res: Response
  try {
    res = await signedFetch(url, {
      method: init.method,
      headers,
      body: init.body,
      identity,
      metadata
    })
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e)
    return { status: 503, body: { error: `gatekeeper_unreachable: ${detail}` }, ok: false }
  }
  const body = await readJsonBody(res)
  return { status: res.status, body, ok: res.ok }
}

/** GET /scene-bans — paginated ban list (owner/admin). */
export async function listSceneBans(
  identity: AuthIdentity,
  params: SceneBanParams,
  opts?: { limit?: number; offset?: number }
): Promise<SceneBanListResult> {
  const limit = Math.min(100, Math.max(1, opts?.limit ?? 50))
  const offset = Math.max(0, opts?.offset ?? 0)
  const r = await signedSceneBanRequest(identity, params, {
    method: 'GET',
    query: `?limit=${limit}&offset=${offset}`
  })
  if (!r.ok) {
    return { ok: false, status: r.status, error: gatekeeperError(r.body, 'gatekeeper_error') }
  }
  return { ok: true, status: r.status, data: parseBanListPage(r.body, limit) }
}

/** POST /scene-bans — ban by address and/or name. */
export async function addSceneBan(
  identity: AuthIdentity,
  params: SceneBanParams,
  target: SceneBanTarget
): Promise<SceneBanMutationResult> {
  const body = banBody(target)
  if (!body) {
    return { ok: false, status: 400, error: 'Provide a wallet address or name to ban.' }
  }
  const r = await signedSceneBanRequest(identity, params, {
    method: 'POST',
    body: JSON.stringify(body)
  })
  if (!r.ok) {
    return { ok: false, status: r.status, error: gatekeeperError(r.body, 'gatekeeper_error') }
  }
  return { ok: true, status: r.status }
}

/** DELETE /scene-bans — remove ban by address and/or name. */
export async function removeSceneBan(
  identity: AuthIdentity,
  params: SceneBanParams,
  target: SceneBanTarget
): Promise<SceneBanMutationResult> {
  const body = banBody(target)
  if (!body) {
    return { ok: false, status: 400, error: 'Provide a wallet address or name to unban.' }
  }
  const r = await signedSceneBanRequest(identity, params, {
    method: 'DELETE',
    body: JSON.stringify(body)
  })
  if (!r.ok) {
    return { ok: false, status: r.status, error: gatekeeperError(r.body, 'gatekeeper_error') }
  }
  return { ok: true, status: r.status }
}
