/**
 * Comms-gatekeeper `/scene-stream-access` — RTMP URL + stream key for a world/parcel.
 * Option B: browser SignedFetch with Explorer kernel metadata (no companion server proxy).
 *
 * @see https://docs.decentraland.org/apis/apis/comms-gatekeeper/scene-stream-access
 */
import type { AuthIdentity } from '@dcl/crypto/dist/types'
import signedFetch from 'decentraland-crypto-fetch'
import { GATEKEEPER_URL } from './GatekeeperClient'

export type SceneStreamAccessParams = {
  sceneId: string
  parcel: string
  realmName: string
  isWorld: boolean
  isGuest: boolean
  /** Custom worlds content host (hostname or origin) for cast realm metadata. */
  worldsContentHost?: string | null
}

export type SceneStreamCredentials = {
  streamingUrl: string
  streamingKey: string
  ingressId: string
  /** Absolute expiry ms when parseable from gatekeeper payload. */
  expiresAtMs: number | null
  raw: unknown
}

export type SceneStreamAccessResult =
  | { ok: true; status: number; credentials: SceneStreamCredentials | null }
  | { ok: false; status: number; error: string }

/**
 * World metadata must match Explorer kernel (`x-identity-metadata`) for `/scene-stream-access`.
 * Parcel uses realm hostname `realm.decentraland.org` + realmName (usually `main`).
 */
export function kernelSceneStreamMetadata(params: SceneStreamAccessParams): Record<string, unknown> {
  if (params.isWorld) {
    const serverName = params.realmName
    // Official worlds host by default; custom content servers pass their host via realmName path.
    const worldsHost =
      params.worldsContentHost?.replace(/^https?:\/\//i, '').replace(/\/+$/, '') ||
      'worlds-content-server.decentraland.org'
    return {
      sceneId: params.sceneId,
      parcel: params.parcel,
      tld: 'org',
      network: 'mainnet',
      isGuest: params.isGuest,
      realm: {
        hostname: `${worldsHost}/world/${serverName}`,
        protocol: 'v3',
        serverName
      },
      signer: 'decentraland-kernel-scene',
      hashPayload: ''
    }
  }

  return {
    signer: 'decentraland-kernel-scene',
    sceneId: params.sceneId,
    parcel: params.parcel,
    tld: 'org',
    network: 'mainnet',
    isGuest: params.isGuest,
    realmName: params.realmName,
    realm: {
      hostname: 'realm.decentraland.org',
      protocol: 'https',
      serverName: params.realmName
    },
    hashPayload: ''
  }
}

function coalesceStreamKeyExpiryMs(v: unknown, keyHint: string): number | null {
  if (v == null) return null
  if (typeof v === 'string') {
    const t = Date.parse(v)
    return Number.isNaN(t) ? null : t
  }
  if (typeof v !== 'number' || !Number.isFinite(v)) return null
  const k = keyHint.toLowerCase()
  if (/ttl|remaining|seconds?_?left|duration/i.test(k) && v > 0 && v < 1e9) {
    return Date.now() + v * 1000
  }
  return v > 1e12 ? v : v * 1000
}

export function parseSceneStreamKeyExpiryEndMs(data: unknown): number | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null
  const o = data as Record<string, unknown>
  const preferKeys = [
    'ends_at',
    'streaming_key_expires_at',
    'streaming_key_expiration',
    'key_expires_at',
    'expires_at',
    'expiration',
    'valid_until',
    'streaming_key_valid_until'
  ]
  for (const key of preferKeys) {
    if (!(key in o)) continue
    const ms = coalesceStreamKeyExpiryMs(o[key], key)
    if (ms != null) return ms
  }
  for (const [key, val] of Object.entries(o)) {
    if (!/expir|valid_until|ttl|remaining|^ends_at$/i.test(key)) continue
    const ms = coalesceStreamKeyExpiryMs(val, key)
    if (ms != null) return ms
  }
  return null
}

function strField(o: Record<string, unknown>, ...keys: string[]): string {
  for (const k of keys) {
    const v = o[k]
    if (typeof v === 'string' && v.trim()) return v.trim()
  }
  return ''
}

/** Normalize gatekeeper / nested `data` payloads into credentials. */
export function parseSceneStreamCredentials(data: unknown): SceneStreamCredentials | null {
  if (data == null) return null
  let o: Record<string, unknown> | null = null
  if (typeof data === 'object' && !Array.isArray(data)) {
    const root = data as Record<string, unknown>
    if (root.data && typeof root.data === 'object' && !Array.isArray(root.data)) {
      o = root.data as Record<string, unknown>
    } else {
      o = root
    }
  }
  if (!o) return null
  const streamingUrl = strField(o, 'streaming_url', 'streamingUrl', 'url', 'rtmp_url')
  const streamingKey = strField(o, 'streaming_key', 'streamingKey', 'key', 'stream_key')
  const ingressId = strField(o, 'ingress_id', 'ingressId', 'ingress')
  if (!streamingUrl && !streamingKey && !ingressId) return null
  return {
    streamingUrl,
    streamingKey,
    ingressId,
    expiresAtMs: parseSceneStreamKeyExpiryEndMs(o),
    raw: o
  }
}

export function formatTimeLeftMs(expiresAtMs: number, nowMs: number): string {
  const ms = expiresAtMs - nowMs
  if (ms <= 0) return 'expired'
  const sec = Math.floor(ms / 1000)
  const d = Math.floor(sec / 86400)
  const h = Math.floor((sec % 86400) / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = sec % 60
  if (d > 0) return `${d}d ${h}h ${m}m`
  if (h > 0) return `${h}h ${m}m ${s}s`
  if (m > 0) return `${m}m ${s}s`
  return `${s}s`
}

function gatekeeperError(body: unknown, statusText: string): string {
  if (body && typeof body === 'object' && 'error' in body) {
    const e = (body as { error: unknown }).error
    if (typeof e === 'string' && e.trim()) return e.trim()
  }
  return statusText || 'gatekeeper_error'
}

async function readJsonBody(res: Response): Promise<unknown> {
  try {
    return await res.json()
  } catch {
    return null
  }
}

async function signedSceneStreamRequest(
  identity: AuthIdentity,
  params: SceneStreamAccessParams,
  init: { method: string; body?: string }
): Promise<{ status: number; body: unknown; ok: boolean }> {
  const url = `${GATEKEEPER_URL.replace(/\/$/, '')}/scene-stream-access`
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
  const body = res.status === 204 ? null : await readJsonBody(res)
  return { status: res.status, body, ok: res.ok }
}

/** GET credentials (list). */
export async function sceneStreamAccessList(
  identity: AuthIdentity,
  params: SceneStreamAccessParams
): Promise<SceneStreamAccessResult> {
  const r = await signedSceneStreamRequest(identity, params, { method: 'GET' })
  if (!r.ok) {
    return { ok: false, status: r.status, error: gatekeeperError(r.body, 'gatekeeper_error') }
  }
  return {
    ok: true,
    status: r.status,
    credentials: parseSceneStreamCredentials(r.body)
  }
}

/**
 * POST mint (empty body) or manual register (all three fields).
 * Explorer first-time: `{}` mints new RTMP credentials.
 */
export async function sceneStreamAccessAdd(
  identity: AuthIdentity,
  params: SceneStreamAccessParams,
  body: Record<string, string> = {}
): Promise<SceneStreamAccessResult> {
  const r = await signedSceneStreamRequest(identity, params, {
    method: 'POST',
    body: JSON.stringify(body)
  })
  if (!r.ok) {
    return { ok: false, status: r.status, error: gatekeeperError(r.body, 'gatekeeper_error') }
  }
  return {
    ok: true,
    status: r.status,
    credentials: parseSceneStreamCredentials(r.body)
  }
}

/** DELETE — remove stream access. */
export async function sceneStreamAccessRemove(
  identity: AuthIdentity,
  params: SceneStreamAccessParams
): Promise<SceneStreamAccessResult> {
  const r = await signedSceneStreamRequest(identity, params, { method: 'DELETE' })
  if (!r.ok) {
    return { ok: false, status: r.status, error: gatekeeperError(r.body, 'gatekeeper_error') }
  }
  return { ok: true, status: r.status, credentials: null }
}

/** PUT — reset / rotate keys. */
export async function sceneStreamAccessReset(
  identity: AuthIdentity,
  params: SceneStreamAccessParams
): Promise<SceneStreamAccessResult> {
  const r = await signedSceneStreamRequest(identity, params, { method: 'PUT' })
  if (!r.ok) {
    return { ok: false, status: r.status, error: gatekeeperError(r.body, 'gatekeeper_error') }
  }
  return { ok: true, status: r.status, credentials: null }
}
