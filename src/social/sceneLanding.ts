import { identityFromAvatarProfile } from '../avatar/displayName'
import { fetchProfileCached } from '../avatar/peerApi'
import type { RouteTarget } from '../dcl/content/route'
import { fetchParcelInfo, isAtlasMapTileUrl } from '../map/parcelInfo'
import {
  dedupeEventsById,
  eventJumpRoute,
  eventParcelCoords,
  fetchDclEvents,
  isEventLiveNow,
  type DclEvent
} from './dclEvents'
import {
  fetchDclGenesisPlaceAtPosition,
  fetchDclPlacesWorlds,
  fetchDclWorldsWithNameFallback,
  formatOwnerShort,
  placeOwnerAddress,
  resolveParcelBasePosition,
  worldNameSearchCandidates,
  type DclPlacesWorld
} from './dclPlaces'
import { fetchWorldDeployDisplayMeta } from '../dcl/content/resolveScene'
import { fetchPublicSceneTitle } from './sceneDisplayTitle'
import { formatRealmParam } from '../network/worlds/worldsServerConfig'

import {
  worldsAboutUrl,
  worldsContentBase,
  worldsContentsUrl
} from '../network/worlds/worldsServerConfig'
/** Same default as dcl-companion server (`MARKETPLACE_SUBGRAPH_URL`). */
const MARKETPLACE_SUBGRAPH =
  (import.meta.env.VITE_MARKETPLACE_SUBGRAPH_URL as string | undefined)?.trim().replace(/\/$/, '') ||
  'https://subgraph.decentraland.org/marketplace'

export type SceneLandingMeta = {
  title: string
  description: string
  imageUrl: string | null
  pointerLabel: string
  kind: 'parcel' | 'world'
  /**
   * Custom worlds content server origin when this landing is not on the official host.
   * Landing UI shows kind label "Custom" instead of "World".
   */
  customServer?: string | null
  userCount: number
  ownerAddress: string | null
  /**
   * Owner wallets for settings gear — mirrors companion `sceneProfile.ownerAddresses`:
   * Places owner/creator + marketplace NAME NFT owner (worlds). No worlds `/about`.
   */
  ownerAddresses: string[]
  ownerDisplayName: string
  categories: string[]
}

/** Landing card kind chip: Parcel | World | Custom (self-hosted worlds server). */
export function sceneLandingKindLabel(meta: Pick<SceneLandingMeta, 'kind' | 'customServer'>): string {
  if (meta.kind === 'parcel') return 'Parcel'
  if (meta.customServer?.trim()) return 'Custom'
  return 'World'
}

/** ENS label for a world pointer: `rickroll.dcl.eth` → `rickroll`. */
export function worldNameLabelFromPointer(worldName: string): string {
  const n = worldName.trim().toLowerCase()
  if (n.endsWith('.dcl.eth')) return n.slice(0, -'.dcl.eth'.length)
  return n
}

/**
 * On-chain owner of the Decentraland NAME NFT for `{label}.dcl.eth`.
 * Same GraphQL as dcl-companion `fetchDclWorldNameOwnerAddress` (marketplace subgraph).
 */
export async function fetchWorldNameOwnerAddress(worldName: string): Promise<string | null> {
  const label = worldNameLabelFromPointer(worldName)
  if (!label || !/^[a-z0-9][a-z0-9-]*$/.test(label)) return null
  const query = `query worldNameOwner($subLabel: String!) {
    nfts(first: 25, where: { category: ens, ens_: { subdomain_starts_with_nocase: $subLabel } }) {
      name
      owner { id }
      ens { subdomain }
    }
  }`
  try {
    const res = await fetch(MARKETPLACE_SUBGRAPH, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        operationName: 'worldNameOwner',
        query,
        variables: { subLabel: label }
      })
    })
    if (!res.ok) return null
    const body = (await res.json()) as {
      data?: {
        nfts?: Array<{
          name?: string | null
          owner?: { id?: string | null } | null
          ens?: { subdomain?: string | null } | null
        } | null>
      }
    }
    const nfts = body.data?.nfts ?? []
    const realm = `${label}.dcl.eth`
    for (const row of nfts) {
      const ownerId = row?.owner?.id?.trim().toLowerCase()
      if (!ownerId || !/^0x[a-f0-9]{40}$/.test(ownerId)) continue
      const nm = (typeof row?.name === 'string' ? row.name : '').toLowerCase()
      const sd = (typeof row?.ens?.subdomain === 'string' ? row.ens.subdomain : '').toLowerCase()
      if (sd === label || nm === label || nm === realm) return ownerId
    }
    return null
  } catch {
    return null
  }
}

function collectOwnerAddresses(
  ...candidates: Array<string | null | undefined>
): { primary: string | null; all: string[] } {
  const all: string[] = []
  const seen = new Set<string>()
  for (const raw of candidates) {
    const a = raw?.trim().toLowerCase()
    if (!a || !/^0x[a-f0-9]{40}$/.test(a) || seen.has(a)) continue
    seen.add(a)
    all.push(a)
  }
  return { primary: all[0] ?? null, all }
}

async function ownerDisplayName(address: string | null, fallback: string): Promise<string> {
  if (!address) return fallback
  const short = formatOwnerShort(address)
  const profile = await fetchProfileCached(address)
  if (profile) return identityFromAvatarProfile(profile, address).displayName
  return short ?? fallback
}

function descriptionFromMetadata(meta: Record<string, unknown> | undefined): string {
  if (!meta) return ''
  const display = meta.display
  if (display && typeof display === 'object') {
    const d = (display as Record<string, unknown>).description
    if (typeof d === 'string' && d.trim()) return d.trim()
  }
  const desc = meta.description
  if (typeof desc === 'string' && desc.trim()) return desc.trim()
  return ''
}

function entityIdFromUrn(urn: string): string | null {
  const m = /^(?:urn:decentraland:(?:offchain:|)entity:)?(bafy[a-z0-9]+)/i.exec(urn.trim())
  return m?.[1] ?? null
}

async function fetchWorldDeploymentDescription(
  worldName: string,
  customServer?: string | null
): Promise<string> {
  try {
    const base = worldsContentBase(customServer)
    const res = await fetch(worldsAboutUrl(base, worldName), {
      headers: { Accept: 'application/json' }
    })
    if (!res.ok) return ''
    const about = (await res.json()) as { configurations?: { scenesUrn?: string[] } }
    const urn = about.configurations?.scenesUrn?.[0]
    if (typeof urn !== 'string') return ''
    const entityId = entityIdFromUrn(urn)
    if (!entityId) return ''
    const entityRes = await fetch(worldsContentsUrl(base, entityId), {
      headers: { Accept: 'application/json' }
    })
    if (!entityRes.ok) return ''
    const entity = (await entityRes.json()) as { metadata?: Record<string, unknown> }
    return descriptionFromMetadata(entity.metadata)
  } catch {
    return ''
  }
}

async function resolveWorldDescription(
  worldName: string,
  customServer?: string | null
): Promise<string> {
  const short = worldName.replace(/\.dcl\.eth$/i, '').trim() || worldName
  const candidates = new Set<string>([worldName, short])
  if (!worldName.toLowerCase().endsWith('.dcl.eth')) {
    candidates.add(`${short}.dcl.eth`)
  }
  for (const name of candidates) {
    const description = await fetchWorldDeploymentDescription(name, customServer)
    if (description) return description
  }
  return ''
}

function normalizeSceneKey(pointer: string): string {
  return pointer.trim().toLowerCase()
}

function eventWorldRealmKey(e: DclEvent): string | null {
  const route = eventJumpRoute(e)
  if (route?.kind === 'world') return normalizeSceneKey(route.worldName)
  return null
}

async function eventMatchesRoute(
  e: DclEvent,
  route: Extract<RouteTarget, { kind: 'coords' } | { kind: 'world' }>,
  targetBase: { x: number; y: number } | null
): Promise<boolean> {
  if (route.kind === 'world') {
    const want = normalizeSceneKey(route.worldName)
    const short = route.worldName.replace(/\.dcl\.eth$/i, '').trim().toLowerCase()
    const ek = eventWorldRealmKey(e)
    if (!ek) return false
    return ek === want || ek === short || ek === `${short}.dcl.eth`
  }
  const coords = eventParcelCoords(e)
  if (!coords) return false
  if (coords.x === route.x && coords.y === route.y) return true
  if (!targetBase) return false
  const eb = await resolveParcelBasePosition(coords.x, coords.y)
  return targetBase.x === eb.x && targetBase.y === eb.y
}

export async function fetchSceneRelatedEvents(
  route: Extract<RouteTarget, { kind: 'coords' } | { kind: 'world' }>,
  limit = 16
): Promise<DclEvent[]> {
  const [active, live, upcoming] = await Promise.all([
    fetchDclEvents({ list: 'active', limit: 100 }),
    fetchDclEvents({ list: 'live', limit: 100 }),
    fetchDclEvents({ list: 'upcoming', limit: 100 })
  ])
  const merged = dedupeEventsById([...live, ...active, ...upcoming])
  const now = Date.now()
  const targetBase =
    route.kind === 'coords' ? await resolveParcelBasePosition(route.x, route.y) : null

  const out: DclEvent[] = []
  for (const e of merged) {
    if (!(await eventMatchesRoute(e, route, targetBase))) continue
    out.push(e)
  }

  out.sort((a, b) => {
    const aLive = isEventLiveNow(a, now)
    const bLive = isEventLiveNow(b, now)
    if (aLive !== bLive) return aLive ? -1 : 1
    const ta = Date.parse(a.next_start_at?.trim() || a.start_at || '')
    const tb = Date.parse(b.next_start_at?.trim() || b.start_at || '')
    if (Number.isFinite(ta) && Number.isFinite(tb)) return ta - tb
    return 0
  })

  return out.slice(0, limit)
}

export async function fetchSceneLandingMeta(
  route: Extract<RouteTarget, { kind: 'coords' } | { kind: 'world' }>
): Promise<SceneLandingMeta> {
  if (route.kind === 'coords') {
    const [parcel, place] = await Promise.all([
      fetchParcelInfo(route.x, route.y).catch(() => null),
      fetchDclGenesisPlaceAtPosition(route.x, route.y).catch(() => null)
    ])

    const owners = place
      ? collectOwnerAddresses(place.creatorAddress, place.owner, placeOwnerAddress(place))
      : collectOwnerAddresses(null)
    const fallbackOwner = parcel?.sceneName ?? place?.title ?? parcel?.parcelLabel ?? 'Creator'
    const ownerDisplay = await ownerDisplayName(owners.primary, fallbackOwner)

    const title = await fetchPublicSceneTitle(route)

    // Explorer card uses Places `image` (scene art / PlazaPic). Prefer that over the
    // atlas map tile parcel.imageUrl falls back to when scene-thumbnail.png is absent.
    const parcelImg = parcel?.imageUrl?.trim() || null
    const placeImg = place?.image?.trim() || null
    const imageUrl =
      placeImg ??
      (parcelImg && !isAtlasMapTileUrl(parcelImg) ? parcelImg : null) ??
      parcelImg

    return {
      title,
      description: parcel?.description?.trim() ?? '',
      imageUrl,
      pointerLabel: `${route.x}, ${route.y}`,
      kind: 'parcel',
      userCount: place?.userCount ?? 0,
      ownerAddress: owners.primary,
      ownerAddresses: owners.all,
      ownerDisplayName: ownerDisplay,
      categories: place?.categories ?? []
    }
  }

  const customServer = route.customServer?.trim() || null
  const shortName = route.worldName.replace(/\.dcl\.eth$/i, '').trim() || route.worldName

  // Custom realm: landing card from THAT server's deployed entity only — never Places/DCL catalog.
  if (customServer) {
    const deploy = await fetchWorldDeployDisplayMeta(route.worldName, customServer).catch(() => null)
    const title =
      deploy?.title?.trim() ||
      (await fetchPublicSceneTitle(route).catch(() => null)) ||
      shortName
    const description =
      deploy?.description?.trim() ||
      (await resolveWorldDescription(route.worldName, customServer)) ||
      ''
    const realmHost = formatRealmParam(customServer) || customServer
    return {
      title,
      description,
      imageUrl: deploy?.imageUrl ?? null,
      pointerLabel: route.worldName,
      kind: 'world',
      customServer,
      // Show host so the card is obviously not the official WCS listing.
      // Owner/userCount from DCL Places would be wrong for custom servers.
      userCount: 0,
      ownerAddress: null,
      ownerAddresses: [],
      ownerDisplayName: realmHost,
      categories: []
    }
  }

  // Official worlds: Prefer exact `names=` match so Places owner wallet is reliable.
  const nameCandidates = worldNameSearchCandidates(route.worldName)
  const [byName, bySearch] = await Promise.all([
    nameCandidates.length
      ? fetchDclPlacesWorlds({
          names: nameCandidates,
          limit: 8,
          orderBy: 'most_active'
        }).catch(() => [] as DclPlacesWorld[])
      : Promise.resolve([] as DclPlacesWorld[]),
    fetchDclWorldsWithNameFallback({
      search: route.worldName,
      limit: 8,
      orderBy: 'most_active'
    }).catch(() => [] as DclPlacesWorld[])
  ])
  const worlds = [...byName]
  for (const w of bySearch) {
    if (!worlds.some((x) => x.id === w.id || x.worldName.toLowerCase() === w.worldName.toLowerCase())) {
      worlds.push(w)
    }
  }

  const needle = route.worldName.toLowerCase()
  const needleShort = worldNameLabelFromPointer(route.worldName)
  const world =
    worlds.find((w) => w.worldName.toLowerCase() === needle) ??
    worlds.find((w) => w.worldName.toLowerCase() === `${needleShort}.dcl.eth`) ??
    worlds.find((w) => w.worldName.toLowerCase() === needleShort) ??
    worlds.find((w) => w.id.toLowerCase() === needle) ??
    worlds[0]

  // Companion discover: Places/deploy owners + marketplace NAME owner (not worlds /about).
  const chainOwner = await fetchWorldNameOwnerAddress(route.worldName).catch(() => null)
  const owners = collectOwnerAddresses(
    chainOwner,
    world?.creatorAddress,
    world?.owner,
    world ? placeOwnerAddress(world) : null
  )
  const ownerDisplay = await ownerDisplayName(owners.primary, shortName)
  const description = await resolveWorldDescription(route.worldName, null)
  const title = await fetchPublicSceneTitle(route)

  return {
    title,
    description,
    imageUrl: world?.image ?? null,
    pointerLabel: route.worldName,
    kind: 'world',
    customServer: null,
    userCount: world?.userCount ?? 0,
    ownerAddress: owners.primary,
    ownerAddresses: owners.all,
    ownerDisplayName: ownerDisplay,
    categories: []
  }
}