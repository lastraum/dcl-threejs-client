import type { RouteTarget } from '../dcl/content/route'

export type PlaceFields = {
  place_kind: 'coords' | 'world' | 'shell'
  place_key: string
  world_name?: string
  x?: number
  y?: number
}

/** Canonical place key for a scene/world route (or shell). */
export function placeFieldsFromRoute(target: RouteTarget | null | undefined): PlaceFields | null {
  if (!target) return null
  if (target.kind === 'coords') {
    return {
      place_kind: 'coords',
      place_key: `parcel:${target.x},${target.y}`,
      x: target.x,
      y: target.y
    }
  }
  if (target.kind === 'world') {
    const world_name = target.worldName.trim().toLowerCase()
    const server = target.customServer?.trim().toLowerCase()
    return {
      place_kind: 'world',
      place_key: server ? `world:${server}:${world_name}` : `world:${world_name}`,
      world_name
    }
  }
  if (
    target.kind === 'blank' ||
    target.kind === 'map' ||
    target.kind === 'events' ||
    target.kind === 'communities' ||
    target.kind === 'profile' ||
    target.kind === 'lootbag' ||
    target.kind === 'marketplace' ||
    target.kind === 'editor'
  ) {
    let name = target.kind === 'blank' ? 'explore' : target.kind
    if (target.kind === 'marketplace') {
      if (target.view === 'item') {
        name = `marketplace-item:${target.contractAddress}:${target.itemId}`
      } else if (target.view === 'land') {
        name = `marketplace-land:${target.contractAddress}:${target.tokenId}`
      } else {
        name = `marketplace:${target.section}`
      }
    }
    return {
      place_kind: 'shell',
      place_key: `shell:${name}`
    }
  }
  return null
}

export function encodePlaceKeyForUrl(placeKey: string): string {
  return encodeURIComponent(placeKey)
}

/** Human label for outbound place keys in the stats modal. */
export function formatPlaceKeyLabel(placeKey: string): string {
  if (placeKey.startsWith('world:')) return placeKey.slice('world:'.length)
  if (placeKey.startsWith('parcel:')) return placeKey.slice('parcel:'.length)
  if (placeKey.startsWith('shell:')) return placeKey.slice('shell:'.length)
  return placeKey
}
