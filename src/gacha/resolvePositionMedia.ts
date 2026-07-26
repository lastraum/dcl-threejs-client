import type { GachaPosition } from './types'

/**
 * Resolve carousel image for a pool position.
 * Mock wearables have no tokenURI art — return empty for styled placeholders.
 * Later: catalyst / wearable API for real DCL collections.
 */
export function resolvePositionMedia(pos: GachaPosition): string | undefined {
  if (pos.imageUrl) return pos.imageUrl
  // Real DCL collections could be resolved here via urn/tokenURI.
  return undefined
}
