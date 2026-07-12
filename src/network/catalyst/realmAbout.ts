export type RealmAbout = {
  realmName: string
  networkId: number
  contentUrl: string
  lambdasUrl: string
  commsAdapterHint?: string
  acceptingUsers: boolean
  healthy: boolean
}

/** Content/lambdas peer (CDN) — not the realm control plane. */
const DEFAULT_CONTENT_PEER = 'https://peer.decentraland.org'
const WORLDS = 'https://worlds-content-server.decentraland.org'
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
  comms?: { adapter?: string; healthy?: boolean }
}

function parseAbout(raw: AboutJson, fallbackRealmName: string): RealmAbout {
  const contentUrl = raw.content?.publicUrl?.replace(/\/$/, '') ?? DEFAULT_CONTENT_PEER
  const lambdasUrl = raw.lambdas?.publicUrl?.replace(/\/$/, '') ?? `${DEFAULT_CONTENT_PEER}/lambdas`
  return {
    realmName: raw.configurations?.realmName?.trim() || fallbackRealmName,
    networkId: raw.configurations?.networkId ?? 1,
    contentUrl,
    lambdasUrl,
    commsAdapterHint: raw.comms?.adapter?.trim() || undefined,
    acceptingUsers: raw.acceptingUsers !== false,
    healthy: raw.healthy !== false
  }
}

async function fetchAboutJson(url: string): Promise<AboutJson | null> {
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json' } })
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
    if (!about.commsAdapterHint) {
      about.commsAdapterHint = DEFAULT_GENESIS_ARCHIPELAGO_ADAPTER
    }
    return about
  }

  // 2) Fallback: direct catalyst peer /about (may lack comms)
  const base = catalystBase.replace(/\/$/, '')
  const res = await fetch(`${base}/about`, { headers: { Accept: 'application/json' } })
  if (!res.ok) throw new Error(`Catalyst about failed (${res.status})`)
  const about = parseAbout((await res.json()) as AboutJson, 'main')
  if (!about.commsAdapterHint) {
    about.commsAdapterHint = DEFAULT_GENESIS_ARCHIPELAGO_ADAPTER
  }
  return about
}

export async function fetchWorldRealmAbout(worldName: string): Promise<RealmAbout> {
  const res = await fetch(`${WORLDS}/world/${encodeURIComponent(worldName)}/about`, {
    headers: { Accept: 'application/json' }
  })
  if (!res.ok) throw new Error(`World about failed (${res.status})`)
  return parseAbout((await res.json()) as AboutJson, worldName.toLowerCase())
}
