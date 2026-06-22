/** Catalyst collections thumbnail URL — same source as BackpackView. */
export function wearableThumbnailUrl(urn: string, peerUrl = 'https://peer.decentraland.org'): string {
  const base = peerUrl.replace(/\/$/, '')
  return `${base}/lambdas/collections/contents/${encodeURIComponent(urn)}/thumbnail`
}

export function wearableShortLabel(urn: string): string {
  const tail = urn.split(':').pop() ?? urn
  return tail.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

export function guessWearableRarity(urn: string): string {
  const low = urn.toLowerCase()
  if (low.includes('legendary')) return 'LEGENDARY'
  if (low.includes('epic')) return 'EPIC'
  if (low.includes('rare')) return 'RARE'
  if (low.includes('uncommon')) return 'UNCOMMON'
  if (low.includes('base') || low.includes('default')) return 'BASE'
  return 'COMMON'
}

export function filterEquippedWearables(wearables: string[]): string[] {
  return wearables.filter((u) => !u.includes('basemale') && !u.includes('basefemale'))
}