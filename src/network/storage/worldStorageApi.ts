/**
 * World Storage Service client (authoritative server data).
 * Signed fetch ADR-44 — place context via metadata (realm / parcel).
 *
 * Place resolution (server-side):
 * - Genesis parcels → Places `?positions=x,y` (realm defaults to `main`)
 * - Worlds (`*.dcl.eth`) → Places `?names=<world>&positions=<baseParcel>`
 *   Storage defaults missing parcel to `0,0`; multi-scene worlds need the scene base.
 *
 * CORS: storage.decentraland.org returns `Access-Control-Allow-Origin: false` for
 * localhost and custom domains (e.g. decentraland.social). Browser calls go through
 * same-origin `/api/storage` (Vite/nginx proxy). Signature is still over the real
 * API path (`/env`, `/values/…`) so the service verifies correctly after rewrite.
 *
 * @see https://docs.decentraland.org/creator/scenes-sdk7/networking/authoritative-servers
 * @see https://github.com/decentraland/world-storage-service
 */
import { Authenticator } from '@dcl/crypto'
import type { AuthIdentity } from '@dcl/crypto/dist/types'
import type { RouteTarget } from '../../dcl/content/route'
import { resolveSceneFromRoute } from '../../dcl/content/resolveScene'

export const STORAGE_API_URL_PROD = 'https://storage.decentraland.org'
export const STORAGE_API_URL_ZONE = 'https://storage.decentraland.zone'
/** Same-origin proxy path (vite.config + deploy/nginx). */
export const STORAGE_API_PROXY_PATH = '/api/storage'

export type StoragePlaceContext = {
  /** World name e.g. myworld.dcl.eth */
  realm?: string | null
  /** Parcel e.g. 10,20 — for worlds, scene base parcel (Places place_id). */
  position?: string | null
}

export type StorageApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; error: string }

/** Upstream host (prod vs zone) — used only for docs/logging; fetch always via proxy when possible. */
export function storageUpstreamOrigin(): string {
  try {
    const host = window.location.hostname
    if (host.endsWith('decentraland.zone') || host.includes('.decentraland.zone')) {
      return STORAGE_API_URL_ZONE
    }
  } catch {
    /* ignore */
  }
  return STORAGE_API_URL_PROD
}

/**
 * Browser fetch base. Prefer same-origin proxy — direct storage CORS fails on localhost
 * and custom domains (`Access-Control-Allow-Origin: false`).
 * Override with VITE_STORAGE_API_URL if needed.
 */
function storageFetchBase(): string {
  const fromEnv =
    typeof import.meta !== 'undefined' ? import.meta.env?.VITE_STORAGE_API_URL?.trim() : ''
  if (fromEnv) return fromEnv.replace(/\/$/, '')
  return STORAGE_API_PROXY_PATH
}

/**
 * ADR-44 identity headers. Path must be the **upstream** API path (`/env`), not the
 * proxy prefix (`/api/storage/env`) — crypto-middleware validates against the path
 * the storage service sees after rewrite.
 */
function signedStorageHeaders(
  identity: AuthIdentity,
  method: string,
  apiPath: string,
  metadata: Record<string, unknown>,
  extra?: Record<string, string>
): Record<string, string> {
  const timestamp = String(Date.now())
  const data = JSON.stringify(metadata)
  const payload = [method, apiPath, timestamp, data].join(':').toLowerCase()
  const chain = Authenticator.signPayload(identity, payload)
  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...(extra ?? {})
  }
  chain.forEach((link, i) => {
    headers[`x-identity-auth-chain-${i}`] = JSON.stringify(link)
  })
  headers['x-identity-timestamp'] = timestamp
  headers['x-identity-metadata'] = data
  return headers
}

/** Sync map landing route → storage context (worlds use realm only; parcel may default server-side). */
export function storageContextFromRoute(
  route: Extract<RouteTarget, { kind: 'coords' } | { kind: 'world' }>
): StoragePlaceContext {
  if (route.kind === 'world') {
    return { realm: route.worldName.trim().toLowerCase(), position: '0,0' }
  }
  return { realm: null, position: `${route.x},${route.y}` }
}

/**
 * Resolve storage place context for signed fetch.
 * Worlds: realm + deployed scene base parcel (Places `names` + `positions` path).
 * Parcels: position only (Genesis).
 */
export async function resolveStoragePlaceContext(
  route: Extract<RouteTarget, { kind: 'coords' } | { kind: 'world' }>
): Promise<StoragePlaceContext> {
  if (route.kind === 'coords') {
    return { realm: null, position: `${route.x},${route.y}` }
  }

  const realm = route.worldName.trim().toLowerCase()
  try {
    const scene = await resolveSceneFromRoute(route)
    const base = scene.baseParcel?.trim()
    // Prefer deployed scene base so multi-scene worlds hit the correct place_id.
    if (base && /^-?\d+,-?\d+$/.test(base)) {
      return { realm, position: base }
    }
  } catch {
    /* fall through — still send realm + 0,0 */
  }
  return { realm, position: '0,0' }
}

function buildMetadata(ctx: StoragePlaceContext): Record<string, unknown> {
  const meta: Record<string, unknown> = {}
  if (ctx.realm) {
    const realm = ctx.realm.trim().toLowerCase()
    meta.realm = { serverName: realm }
    meta.realmName = realm
  }
  if (ctx.position) {
    meta.parcel = ctx.position.trim()
  }
  return meta
}

async function storageRequest(
  identity: AuthIdentity,
  ctx: StoragePlaceContext,
  path: string,
  init: { method: string; body?: unknown; headers?: Record<string, string> }
): Promise<StorageApiResult<unknown>> {
  const apiPath = path.startsWith('/') ? path : `/${path}`
  const url = `${storageFetchBase()}${apiPath}`
  let body: string | undefined
  const extra: Record<string, string> = { ...(init.headers ?? {}) }
  if (init.body !== undefined) {
    extra['Content-Type'] = 'application/json'
    body = JSON.stringify(init.body)
  }
  const headers = signedStorageHeaders(
    identity,
    init.method,
    apiPath,
    buildMetadata(ctx),
    extra
  )
  try {
    const res = await fetch(url, {
      method: init.method,
      headers,
      body
    })
    if (res.status === 204) return { ok: true, data: null }
    const text = await res.text()
    let parsed: unknown = null
    if (text) {
      try {
        parsed = JSON.parse(text)
      } catch {
        parsed = text
      }
    }
    if (!res.ok) {
      const errObj = parsed && typeof parsed === 'object' ? (parsed as { message?: string; error?: string }) : null
      return {
        ok: false,
        status: res.status,
        error: errObj?.message ?? errObj?.error ?? (res.statusText || `http_${res.status}`)
      }
    }
    return { ok: true, data: parsed }
  } catch (err) {
    return {
      ok: false,
      status: 0,
      error: err instanceof Error ? err.message : String(err)
    }
  }
}

function asKeyList(data: unknown): string[] {
  if (!data || typeof data !== 'object') return []
  const d = data as { data?: unknown }
  if (Array.isArray(d.data)) {
    return d.data.map((k) => String(k)).filter(Boolean)
  }
  if (Array.isArray(data)) {
    return (data as unknown[]).map((k) => String(k)).filter(Boolean)
  }
  return []
}

// ── Env ──────────────────────────────────────────────────────────────────────

export async function listEnvKeys(
  identity: AuthIdentity,
  ctx: StoragePlaceContext
): Promise<StorageApiResult<string[]>> {
  const r = await storageRequest(identity, ctx, '/env', { method: 'GET' })
  if (!r.ok) return r
  return { ok: true, data: asKeyList(r.data) }
}

export async function setEnvValue(
  identity: AuthIdentity,
  ctx: StoragePlaceContext,
  key: string,
  value: string
): Promise<StorageApiResult<null>> {
  const r = await storageRequest(identity, ctx, `/env/${encodeURIComponent(key)}`, {
    method: 'PUT',
    body: { value }
  })
  if (!r.ok) return r
  return { ok: true, data: null }
}

export async function deleteEnvKey(
  identity: AuthIdentity,
  ctx: StoragePlaceContext,
  key: string
): Promise<StorageApiResult<null>> {
  const r = await storageRequest(identity, ctx, `/env/${encodeURIComponent(key)}`, {
    method: 'DELETE'
  })
  if (!r.ok) return r
  return { ok: true, data: null }
}

// ── Scene (world) values ─────────────────────────────────────────────────────

export async function listSceneKeys(
  identity: AuthIdentity,
  ctx: StoragePlaceContext
): Promise<StorageApiResult<string[]>> {
  const r = await storageRequest(identity, ctx, '/values', { method: 'GET' })
  if (!r.ok) return r
  return { ok: true, data: asKeyList(r.data) }
}

export async function getSceneValue(
  identity: AuthIdentity,
  ctx: StoragePlaceContext,
  key: string
): Promise<StorageApiResult<unknown>> {
  const r = await storageRequest(identity, ctx, `/values/${encodeURIComponent(key)}`, {
    method: 'GET'
  })
  if (!r.ok) return r
  const data = r.data
  if (data && typeof data === 'object' && 'value' in (data as object)) {
    return { ok: true, data: (data as { value: unknown }).value }
  }
  return { ok: true, data }
}

export async function setSceneValue(
  identity: AuthIdentity,
  ctx: StoragePlaceContext,
  key: string,
  value: unknown
): Promise<StorageApiResult<null>> {
  const r = await storageRequest(identity, ctx, `/values/${encodeURIComponent(key)}`, {
    method: 'PUT',
    body: { value }
  })
  if (!r.ok) return r
  return { ok: true, data: null }
}

export async function deleteSceneKey(
  identity: AuthIdentity,
  ctx: StoragePlaceContext,
  key: string
): Promise<StorageApiResult<null>> {
  const r = await storageRequest(identity, ctx, `/values/${encodeURIComponent(key)}`, {
    method: 'DELETE'
  })
  if (!r.ok) return r
  return { ok: true, data: null }
}

// ── Player values ────────────────────────────────────────────────────────────

export async function listPlayerKeys(
  identity: AuthIdentity,
  ctx: StoragePlaceContext,
  playerAddress: string
): Promise<StorageApiResult<string[]>> {
  const addr = playerAddress.trim().toLowerCase()
  const r = await storageRequest(identity, ctx, `/players/${encodeURIComponent(addr)}/values`, {
    method: 'GET'
  })
  if (!r.ok) return r
  return { ok: true, data: asKeyList(r.data) }
}

export async function getPlayerValue(
  identity: AuthIdentity,
  ctx: StoragePlaceContext,
  playerAddress: string,
  key: string
): Promise<StorageApiResult<unknown>> {
  const addr = playerAddress.trim().toLowerCase()
  const r = await storageRequest(
    identity,
    ctx,
    `/players/${encodeURIComponent(addr)}/values/${encodeURIComponent(key)}`,
    { method: 'GET' }
  )
  if (!r.ok) return r
  const data = r.data
  if (data && typeof data === 'object' && 'value' in (data as object)) {
    return { ok: true, data: (data as { value: unknown }).value }
  }
  return { ok: true, data }
}

export async function setPlayerValue(
  identity: AuthIdentity,
  ctx: StoragePlaceContext,
  playerAddress: string,
  key: string,
  value: unknown
): Promise<StorageApiResult<null>> {
  const addr = playerAddress.trim().toLowerCase()
  const r = await storageRequest(
    identity,
    ctx,
    `/players/${encodeURIComponent(addr)}/values/${encodeURIComponent(key)}`,
    { method: 'PUT', body: { value } }
  )
  if (!r.ok) return r
  return { ok: true, data: null }
}

export async function deletePlayerKey(
  identity: AuthIdentity,
  ctx: StoragePlaceContext,
  playerAddress: string,
  key: string
): Promise<StorageApiResult<null>> {
  const addr = playerAddress.trim().toLowerCase()
  const r = await storageRequest(
    identity,
    ctx,
    `/players/${encodeURIComponent(addr)}/values/${encodeURIComponent(key)}`,
    { method: 'DELETE' }
  )
  if (!r.ok) return r
  return { ok: true, data: null }
}
