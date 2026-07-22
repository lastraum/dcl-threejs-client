import { worldsAboutUrl, worldsContentBase } from '../worlds/worldsServerConfig'
import { ABOUT_FETCH_TIMEOUT_MS, fetchWithTimeout } from '../../util/fetchWithTimeout'

export type RealmAbout = {
  realmName: string
  networkId: number
  contentUrl: string
  lambdasUrl: string
  commsAdapterHint?: string
  /**
   * False when the worlds server / this world does not expose a usable comms adapter
   * (LiveKit optional — owner can run content-only). Scene still loads solo.
   */
  commsEnabled: boolean
  /** From about.comms.healthy when present. */
  commsHealthy?: boolean
  acceptingUsers: boolean
  healthy: boolean
}

/** Content/lambdas peer (CDN) — not the realm control plane. */
const DEFAULT_CONTENT_PEER = 'https://peer.decentraland.org'
/**
 * Genesis main realm control plane (Explorer / EA).
 * This is the correct `/about` for comms.adapter + realm metadata.
 * Plain `peer.decentraland.org/about` often omits `comms` entirely.
 */
export const GENESIS_REALM_PROVIDER_ABOUT = 'https://realm-provider-ea.decentraland.org/main/about'
/** Hard fallback if realm-provider is down. */
export const DEFAULT_GENESIS_ARCHIPELAGO_ADAPTER =
  'archipelago:wss://archipelago-ea-ws-connector.decentraland.org/ws'

type AboutJson = {
  healthy?: boolean
  acceptingUsers?: boolean
  content?: { publicUrl?: string; healthy?: boolean }
  lambdas?: { publicUrl?: string; healthy?: boolean }
  configurations?: { networkId?: number; realmName?: string }
  comms?: {
    adapter?: string
    healthy?: boolean
    protocol?: string
    /** Some custom servers use explicit flags. */
    enabled?: boolean
    adapterType?: string
  }
}

type StatusJson = {
  comms?: {
    adapterType?: string
    statusUrl?: string
    rooms?: number
    users?: number
    enabled?: boolean
    healthy?: boolean
  }
  healthy?: boolean
}

function adapterLooksUsable(adapter: string | undefined): boolean {
  const a = adapter?.trim() ?? ''
  if (!a) return false
  // Explicit none/disabled markers some hosts may emit
  if (/^(none|null|disabled|off)$/i.test(a)) return false
  return true
}

/**
 * Whether multiplayer/chat (LiveKit path) is available from about (+ optional status).
 * World server owners can omit or disable comms; content still loads.
 */
export function resolveCommsEnabledFromAbout(
  raw: AboutJson,
  status?: StatusJson | null
): { enabled: boolean; adapter?: string; healthy?: boolean } {
  const adapter = raw.comms?.adapter?.trim() || undefined
  const aboutEnabledFlag = raw.comms?.enabled
  const aboutHealthy = raw.comms?.healthy

  // Explicit disable on about
  if (aboutEnabledFlag === false) {
    return { enabled: false, adapter, healthy: aboutHealthy }
  }
  if (aboutHealthy === false && !adapterLooksUsable(adapter)) {
    return { enabled: false, adapter, healthy: false }
  }

  if (adapterLooksUsable(adapter)) {
    return { enabled: true, adapter, healthy: aboutHealthy }
  }

  // No adapter on world about — consult server /status when present
  if (status?.comms) {
    const st = status.comms
    if (st.enabled === false || st.healthy === false) {
      return { enabled: false, healthy: st.healthy }
    }
    const type = (st.adapterType ?? '').trim().toLowerCase()
    if (!type || type === 'none' || type === 'disabled' || type === 'off') {
      return { enabled: false, healthy: st.healthy }
    }
    // Server has LiveKit (or other) infra but this world has no adapter → world-level off
    return { enabled: false, healthy: st.healthy }
  }

  // Missing comms block entirely → content-only world
  return { enabled: false, adapter, healthy: aboutHealthy }
}

function parseAbout(
  raw: AboutJson,
  fallbackRealmName: string,
  status?: StatusJson | null
): RealmAbout {
  const contentUrl = raw.content?.publicUrl?.replace(/\/$/, '') ?? DEFAULT_CONTENT_PEER
  const lambdasUrl = raw.lambdas?.publicUrl?.replace(/\/$/, '') ?? `${DEFAULT_CONTENT_PEER}/lambdas`
  const comms = resolveCommsEnabledFromAbout(raw, status)
  return {
    realmName: raw.configurations?.realmName?.trim() || fallbackRealmName,
    networkId: raw.configurations?.networkId ?? 1,
    contentUrl,
    lambdasUrl,
    commsAdapterHint: comms.adapter,
    commsEnabled: comms.enabled,
    commsHealthy: comms.healthy,
    acceptingUsers: raw.acceptingUsers !== false,
    healthy: raw.healthy !== false
  }
}

async function fetchAboutJson(url: string): Promise<AboutJson | null> {
  try {
    const res = await fetchWithTimeout(url, {
      headers: { Accept: 'application/json' },
      timeoutMs: ABOUT_FETCH_TIMEOUT_MS
    })
    if (!res.ok) return null
    return (await res.json()) as AboutJson
  } catch {
    return null
  }
}

/**
 * Genesis / catalyst realm about — prefer realm-provider-ea (has archipelago adapter).
 * Optional `catalystBase` only used if realm-provider is unreachable.
 */
export async function fetchCatalystRealmAbout(catalystBase = DEFAULT_CONTENT_PEER): Promise<RealmAbout> {
  // 1) Authoritative Genesis main realm
  const providerJson = await fetchAboutJson(GENESIS_REALM_PROVIDER_ABOUT)
  if (providerJson) {
    const about = parseAbout(providerJson, 'main')
    // Genesis always has archipelago — inject default if /about omitted adapter
    if (!about.commsAdapterHint) {
      about.commsAdapterHint = DEFAULT_GENESIS_ARCHIPELAGO_ADAPTER
    }
    about.commsEnabled = true
    return about
  }

  // 2) Fallback: direct catalyst peer /about (may lack comms)
  const base = catalystBase.replace(/\/$/, '')
  const res = await fetchWithTimeout(`${base}/about`, {
    headers: { Accept: 'application/json' },
    timeoutMs: ABOUT_FETCH_TIMEOUT_MS
  })
  if (!res.ok) throw new Error(`Catalyst about failed (${res.status})`)
  const about = parseAbout((await res.json()) as AboutJson, 'main')
  if (!about.commsAdapterHint) {
    about.commsAdapterHint = DEFAULT_GENESIS_ARCHIPELAGO_ADAPTER
  }
  about.commsEnabled = true
  return about
}

/** Server-level `/status` (optional) — LiveKit capacity for custom worlds hosts. */
export async function fetchWorldsServerStatus(
  contentServerBase?: string | null
): Promise<StatusJson | null> {
  const base = worldsContentBase(contentServerBase)
  try {
    const res = await fetchWithTimeout(`${base}/status`, {
      headers: { Accept: 'application/json' },
      timeoutMs: ABOUT_FETCH_TIMEOUT_MS
    })
    if (!res.ok) return null
    return (await res.json()) as StatusJson
  } catch {
    return null
  }
}

/**
 * World realm `/about` (+ optional `/status` for LiveKit capability).
 * Pass `customServer` (origin) for self-hosted worlds content servers.
 * Default = official / env worlds content server.
 *
 * If the owner disables LiveKit, `commsEnabled` is false and `commsAdapterHint` is empty —
 * the client still loads content and plays solo (no world chat / peers).
 */
export async function fetchWorldRealmAbout(
  worldName: string,
  customServer?: string | null
): Promise<RealmAbout> {
  const base = worldsContentBase(customServer)
  const [aboutRes, status] = await Promise.all([
    fetchWithTimeout(worldsAboutUrl(base, worldName), {
      headers: { Accept: 'application/json' },
      timeoutMs: ABOUT_FETCH_TIMEOUT_MS
    }),
    fetchWorldsServerStatus(base)
  ])
  if (!aboutRes.ok) throw new Error(`World about failed (${aboutRes.status}) from ${base}`)
  const raw = (await aboutRes.json()) as AboutJson
  return parseAbout(raw, worldName.toLowerCase(), status)
}
