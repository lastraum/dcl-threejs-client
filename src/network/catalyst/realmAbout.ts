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

export async function fetchCatalystRealmAbout(catalystBase = DEFAULT_CATALYST): Promise<RealmAbout> {
  const base = catalystBase.replace(/\/$/, '')
  const res = await fetch(`${base}/about`, { headers: { Accept: 'application/json' } })
  if (!res.ok) throw new Error(`Catalyst about failed (${res.status})`)
  return parseAbout((await res.json()) as AboutJson, 'main')
}

export async function fetchWorldRealmAbout(worldName: string): Promise<RealmAbout> {
  const res = await fetch(`${WORLDS}/world/${encodeURIComponent(worldName)}/about`, {
    headers: { Accept: 'application/json' }
  })
  if (!res.ok) throw new Error(`World about failed (${res.status})`)
  return parseAbout((await res.json()) as AboutJson, worldName.toLowerCase())
}
