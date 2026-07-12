export type RealmAbout = {
  realmName: string
  networkId: number
  contentUrl: string
  lambdasUrl: string
  commsAdapterHint?: string
  acceptingUsers: boolean
  healthy: boolean
}

const DEFAULT_CATALYST = 'https://peer.decentraland.org'
const WORLDS = 'https://worlds-content-server.decentraland.org'
/** Genesis main realm — still publishes archipelago adapter (catalyst /about often omits comms). */
const REALM_PROVIDER_ABOUT = 'https://realm-provider-ea.decentraland.org/main/about'
/**
 * Production Archipelago WS (EA). Used when /about has no adapter — without this,
 * island LiveKit never joins and Genesis remotes stay at 0.
 */
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
  const contentUrl = raw.content?.publicUrl?.replace(/\/$/, '') ?? DEFAULT_CATALYST
  const lambdasUrl = raw.lambdas?.publicUrl?.replace(/\/$/, '') ?? `${DEFAULT_CATALYST}/lambdas`
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

/** Resolve archipelago adapter when catalyst /about omits `comms` (common since realm-provider split). */
async function resolveCommsAdapterHint(primary?: string): Promise<string | undefined> {
  if (primary?.trim()) return primary.trim()
  const provider = await fetchAboutJson(REALM_PROVIDER_ABOUT)
  const fromProvider = provider?.comms?.adapter?.trim()
  if (fromProvider) return fromProvider
  return DEFAULT_GENESIS_ARCHIPELAGO_ADAPTER
}

export async function fetchCatalystRealmAbout(catalystBase = DEFAULT_CATALYST): Promise<RealmAbout> {
  const base = catalystBase.replace(/\/$/, '')
  const res = await fetch(`${base}/about`, { headers: { Accept: 'application/json' } })
  if (!res.ok) throw new Error(`Catalyst about failed (${res.status})`)
  const about = parseAbout((await res.json()) as AboutJson, 'main')
  about.commsAdapterHint = await resolveCommsAdapterHint(about.commsAdapterHint)
  return about
}

export async function fetchWorldRealmAbout(worldName: string): Promise<RealmAbout> {
  const res = await fetch(`${WORLDS}/world/${encodeURIComponent(worldName)}/about`, {
    headers: { Accept: 'application/json' }
  })
  if (!res.ok) throw new Error(`World about failed (${res.status})`)
  return parseAbout((await res.json()) as AboutJson, worldName.toLowerCase())
}
