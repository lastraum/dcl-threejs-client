import { identityFromAvatarProfile } from '../avatar/displayName'
import { fetchProfileCached } from '../avatar/peerApi'
import type { RouteTarget } from '../dcl/content/route'
import { fetchParcelInfo } from '../map/parcelInfo'
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
  fetchDclWorldsWithNameFallback,
  formatOwnerShort,
  placeOwnerAddress,
  resolveParcelBasePosition,
  type DclPlacesWorld
} from './dclPlaces'
import { fetchPublicSceneTitle } from './sceneDisplayTitle'

const WORLDS = 'https://worlds-content-server.decentraland.org'

export type SceneLandingMeta = {
  title: string
  description: string
  imageUrl: string | null
  pointerLabel: string
  kind: 'parcel' | 'world'
  userCount: number
  ownerAddress: string | null
  /** All known owner wallets (Places owner + creator, lowercased) for settings-gear checks. */
  ownerAddresses: string[]
  ownerDisplayName: string
  categories: string[]
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

async function fetchWorldDeploymentDescription(worldName: string): Promise<string> {
  try {
    const res = await fetch(`${WORLDS}/world/${encodeURIComponent(worldName)}/about`, {
      headers: { Accept: 'application/json' }
    })
    if (!res.ok) return ''
    const about = (await res.json()) as { configurations?: { scenesUrn?: string[] } }
    const urn = about.configurations?.scenesUrn?.[0]
    if (typeof urn !== 'string') return ''
    const entityId = entityIdFromUrn(urn)
    if (!entityId) return ''
    const entityRes = await fetch(`${WORLDS}/contents/${encodeURIComponent(entityId)}`, {
      headers: { Accept: 'application/json' }
    })
    if (!entityRes.ok) return ''
    const entity = (await entityRes.json()) as { metadata?: Record<string, unknown> }
    return descriptionFromMetadata(entity.metadata)
  } catch {
    return ''
  }
}

async function resolveWorldDescription(worldName: string): Promise<string> {
  const short = worldName.replace(/\.dcl\.eth$/i, '').trim() || worldName
  const candidates = new Set<string>([worldName, short])
  if (!worldName.toLowerCase().endsWith('.dcl.eth')) {
    candidates.add(`${short}.dcl.eth`)
  }
  for (const name of candidates) {
    const description = await fetchWorldDeploymentDescription(name)
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

    return {
      title,
      description: parcel?.description?.trim() ?? '',
      imageUrl: parcel?.imageUrl ?? place?.image ?? null,
      pointerLabel: `${route.x}, ${route.y}`,
      kind: 'parcel',
      userCount: place?.userCount ?? 0,
      ownerAddress: owners.primary,
      ownerAddresses: owners.all,
      ownerDisplayName: ownerDisplay,
      categories: place?.categories ?? []
    }
  }

  const worlds = await fetchDclWorldsWithNameFallback({
    search: route.worldName,
    limit: 8,
    orderBy: 'most_active'
  }).catch(() => [] as DclPlacesWorld[])

  const needle = route.worldName.toLowerCase()
  const world =
    worlds.find((w) => w.worldName.toLowerCase() === needle) ??
    worlds.find((w) => w.id.toLowerCase() === needle) ??
    worlds[0]

  const owners = world
    ? collectOwnerAddresses(world.creatorAddress, world.owner, placeOwnerAddress(world))
    : collectOwnerAddresses(null)
  const shortName = route.worldName.replace(/\.dcl\.eth$/i, '').trim() || route.worldName
  const ownerDisplay = await ownerDisplayName(owners.primary, shortName)
  const description = await resolveWorldDescription(route.worldName)
  const title = await fetchPublicSceneTitle(route)

  return {
    title,
    description,
    imageUrl: world?.image ?? null,
    pointerLabel: route.worldName,
    kind: 'world',
    userCount: world?.userCount ?? 0,
    ownerAddress: owners.primary,
    ownerAddresses: owners.all,
    ownerDisplayName: ownerDisplay,
    categories: []
  }
}