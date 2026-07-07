import type { RouteTarget } from '../dcl/content/route'
import { fetchDeployedSceneDisplayTitle } from '../dcl/content/resolveScene'
import type { ResolvedScene } from '../dcl/content/types'
import { fetchParcelInfo } from '../map/parcelInfo'
import {
  fetchDclGenesisPlaceAtPosition,
  fetchDclWorldsWithNameFallback,
  type DclPlacesWorld
} from './dclPlaces'

function pickWorldForRoute(worlds: DclPlacesWorld[], worldName: string): DclPlacesWorld | undefined {
  const needle = worldName.toLowerCase()
  return (
    worlds.find((w) => w.worldName.toLowerCase() === needle) ??
    worlds.find((w) => w.id.toLowerCase() === needle) ??
    worlds[0]
  )
}

/**
 * Public scene title — deployed `scene.json` display.title first (live catalyst metadata),
 * then Places API listing title, then pointer / world name.
 */
export async function fetchPublicSceneTitle(
  route: Extract<RouteTarget, { kind: 'coords' } | { kind: 'world' }>,
  entityTitle?: string | null
): Promise<string> {
  const deployedTitle =
    entityTitle?.trim() ||
    (await fetchDeployedSceneDisplayTitle(route).catch(() => null)) ||
    null

  if (route.kind === 'coords') {
    const [parcel, place] = await Promise.all([
      fetchParcelInfo(route.x, route.y).catch(() => null),
      fetchDclGenesisPlaceAtPosition(route.x, route.y).catch(() => null)
    ])
    return (
      deployedTitle ??
      parcel?.sceneName ??
      place?.title ??
      parcel?.parcelLabel ??
      `Parcel ${route.x}, ${route.y}`
    )
  }

  const worlds = await fetchDclWorldsWithNameFallback({
    search: route.worldName,
    limit: 8,
    orderBy: 'most_active'
  }).catch(() => [] as DclPlacesWorld[])

  const world = pickWorldForRoute(worlds, route.worldName)
  const shortName = route.worldName.replace(/\.dcl\.eth$/i, '').trim() || route.worldName
  return deployedTitle ?? world?.title ?? shortName
}

/** Ensure ResolvedScene.title matches the shared public title resolver. */
export async function enrichResolvedScenePublicTitle(
  scene: ResolvedScene,
  route: Extract<RouteTarget, { kind: 'coords' } | { kind: 'world' }>
): Promise<ResolvedScene> {
  const title = await fetchPublicSceneTitle(route, scene.title)
  if (title === scene.title) return scene
  return { ...scene, title }
}