/**
 * World Storage Service client (authoritative server data).
 * Signed fetch ADR-44 — place context via metadata (realm / parcel).
 *
 * @see https://docs.decentraland.org/creator/scenes-sdk7/networking/authoritative-servers
 * @see https://github.com/decentraland/world-storage-service
 */
import type { AuthIdentity } from '@dcl/crypto/dist/types'
import signedFetch from 'decentraland-crypto-fetch'
import type { RouteTarget } from '../../dcl/content/route'

export const STORAGE_API_URL_PROD = 'https://storage.decentraland.org'
export const STORAGE_API_URL_ZONE = 'https://storage.decentraland.zone'

export type StoragePlaceContext = {
  /** World name e.g. myworld.dcl.eth */
  realm?: string | null
  /** Parcel e.g. 10,20 */
  position?: string | null
}

export type StorageApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; error: string }

function baseUrl(): string {
  try {
    const host = window.location.hostname
    if (host.includes('localhost') || host.includes('127.0.0.1') || host.includes('decentraland.zone')) {
      return STORAGE_API_URL_ZONE
    }
  } catch {
    /* ignore */
  }
  return STORAGE_API_URL_PROD
}

/** Map landing route → storage signed-fetch place context. */
export function storageContextFromRoute(
  route: Extract<RouteTarget, { kind: 'coords' } | { kind: 'world' }>
): StoragePlaceContext {
  if (route.kind === 'world') {
    return { realm: route.worldName.trim(), position: null }
  }
  return { realm: null, position: `${route.x},${route.y}` }
}

function buildMetadata(ctx: StoragePlaceContext): Record<string, unknown> {
  const meta: Record<string, unknown> = {}
  if (ctx.realm) {
    meta.realm = { serverName: ctx.realm }
    meta.realmName = ctx.realm
  }
  if (ctx.position) {
    meta.parcel = ctx.position
  }
  return meta
}

async function storageRequest(
  identity: AuthIdentity,
  ctx: StoragePlaceContext,
  path: string,
  init: { method: string; body?: unknown; headers?: Record<string, string> }
): Promise<StorageApiResult<unknown>> {
  const url = `${baseUrl().replace(/\/$/, '')}${path.startsWith('/') ? path : `/${path}`}`
  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...(init.headers ?? {})
  }
  let body: string | undefined
  if (init.body !== undefined) {
    headers['Content-Type'] = 'application/json'
    body = JSON.stringify(init.body)
  }
  try {
    const res = await signedFetch(url, {
      method: init.method,
      headers,
      body,
      identity,
      metadata: buildMetadata(ctx)
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
