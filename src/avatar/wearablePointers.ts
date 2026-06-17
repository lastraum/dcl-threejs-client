import { assetUrnFromCompleteUrn, normalizeUrn } from './constants'

/** Legacy profile slugs → Catalyst pointer slugs (Forge / Explorer parity). */
const LEGACY_WEARABLE_SLUG_ALIASES: Record<string, string> = {
  m_eyes_00: 'eyes_00',
  m_eyes_01: 'eyes_01',
  m_eyes_02: 'eyes_02',
  m_eyebrows_00: 'eyebrows_00',
  m_eyebrows_01: 'eyebrows_01',
  m_eyebrows_02: 'eyebrows_02',
  m_mouth_00: 'mouth_00',
  m_mouth_01: 'mouth_01',
  m_mouth_02: 'mouth_02',
  m_blue_tshirt: 'blue_tshirt',
  m_brown_pants: 'brown_pants',
  m_green_hoodie: 'green_hoodie',
  m_jean_trousers: 'brown_pants',
  white_shirt: 'blue_tshirt',
  m_moon_pants: 'brown_pants',
  bun_hair: 'short_hair',
  curta_hair: 'curly_hair',
  f_grey_tshirt: 'f_sweater',
  f_distinctive_pants: 'f_jeans',
  /** Dead Catalyst pointers — fall back to closest bundled default. */
  stripy_shirt: 'blue_tshirt',
  m_stripy_shirt: 'blue_tshirt'
}

function slugFromUrn(urn: string): string {
  const parts = normalizeUrn(urn).split(':')
  return parts[parts.length - 1] ?? urn
}

/** Catalyst entity pointer for a profile wearable URN (handles legacy `m_` slugs). */
export function catalystPointerForWearableUrn(completeUrn: string): string {
  const normalized = normalizeUrn(completeUrn)
  if (!normalized.includes('base-avatars')) {
    return assetUrnFromCompleteUrn(normalized)
  }

  const slug = slugFromUrn(normalized)
  const aliased = LEGACY_WEARABLE_SLUG_ALIASES[slug]
  if (aliased) {
    return `urn:decentraland:off-chain:base-avatars:${aliased}`
  }

  if (slug.startsWith('m_') && !slug.startsWith('m_moon')) {
    return `urn:decentraland:off-chain:base-avatars:${slug.slice(2)}`
  }

  return assetUrnFromCompleteUrn(normalized)
}

export function bundledWearableSlug(completeUrn: string): string {
  return slugFromUrn(catalystPointerForWearableUrn(completeUrn))
}
