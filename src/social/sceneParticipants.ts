import { identityFromAvatarProfile } from '../avatar/displayName'
import { fetchProfileCached, fetchProfileFaceUrl } from '../avatar/peerApi'
import type { RouteTarget } from '../dcl/content/route'
import { realmNameForCommsPointer } from '../network/catalyst/pointer'
import { fetchSceneParticipants } from '../network/gatekeeper/GatekeeperClient'

export type SceneParticipantRow = {
  address: string
  displayName: string
  faceUrl: string | null
}

export function pointerFromLandingRoute(
  route: Extract<RouteTarget, { kind: 'coords' } | { kind: 'world' }>
): string {
  if (route.kind === 'coords') return `${route.x},${route.y}`
  return route.worldName.trim().toLowerCase()
}

export async function fetchSceneParticipantRows(
  route: Extract<RouteTarget, { kind: 'coords' } | { kind: 'world' }>
): Promise<SceneParticipantRow[]> {
  const pointer = pointerFromLandingRoute(route)
  const realm = realmNameForCommsPointer(pointer)
  const addresses = await fetchSceneParticipants(pointer, realm)

  const rows = await Promise.all(
    addresses.map(async (address) => {
      const [profile, faceUrl] = await Promise.all([
        fetchProfileCached(address),
        fetchProfileFaceUrl(address)
      ])
      const displayName = profile
        ? identityFromAvatarProfile(profile, address).displayName
        : address
      return { address, displayName, faceUrl }
    })
  )

  rows.sort((a, b) =>
    a.displayName.localeCompare(b.displayName, undefined, { sensitivity: 'base' })
  )
  return rows
}