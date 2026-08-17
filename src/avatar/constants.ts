import type { BodyShape, WearableCategory } from './types'

export const PEER_URL = 'https://peer-ec2.decentraland.org'

export const PROFILE_STORAGE_KEY = 'dcl-client-profile'

/** DCL avatars face +Z at bind pose; movement/camera use -Z as forward at yaw 0. */
export const AVATAR_YAW_OFFSET = Math.PI

/** DCL wearable-preview / Forge export uses ~4× emissive factor vs raw glTF. */
export const EMISSIVE_FACTOR_BOOST = 4
/** Explorer reads brighter than Three.js PBR defaults — tune without bloom. */
export const EMISSIVE_INTENSITY = 12

/** Official DCL wearable-preview emotes — Avatar_ bone rig. */
export const AVATAR_EMOTE_IDLE = '/avatar/emotes/idle.glb'
export const AVATAR_EMOTE_WALK = '/avatar/emotes/walk.glb'
/** Explorer Jog clip (unity-explorer Jog.anim converted to the Avatar_ rig). */
export const AVATAR_EMOTE_JOG = '/avatar/emotes/jog.glb'
export const AVATAR_EMOTE_RUN = '/avatar/emotes/run.glb'
export const AVATAR_EMOTE_JUMP = '/avatar/emotes/jump.glb'
/**
 * Optional dedicated Double_Jump clip. When missing, AvatarAnimations uses a
 * hard-coded full-body Y twirl (Explorer parity) instead of replaying jump.glb.
 */
export const AVATAR_EMOTE_DOUBLE_JUMP = '/avatar/emotes/double_jump.glb'
/** Explorer-style glider body — Avatar_ arms-on-handles (`Glide_Avatar` in glide.glb). */
export const AVATAR_EMOTE_GLIDE = '/avatar/glider/glide.glb'

export const BODY_SHAPE_URN: Record<BodyShape, string> = {
  male: 'urn:decentraland:off-chain:base-avatars:BaseMale',
  female: 'urn:decentraland:off-chain:base-avatars:BaseFemale'
}

export function defaultWearableUrn(category: WearableCategory, shape: BodyShape): string | null {
  switch (category) {
    case 'eyebrows':
      return shape === 'male'
        ? 'urn:decentraland:off-chain:base-avatars:eyebrows_00'
        : 'urn:decentraland:off-chain:base-avatars:f_eyebrows_00'
    case 'mouth':
      return shape === 'male'
        ? 'urn:decentraland:off-chain:base-avatars:mouth_00'
        : 'urn:decentraland:off-chain:base-avatars:f_mouth_00'
    case 'eyes':
      return shape === 'male'
        ? 'urn:decentraland:off-chain:base-avatars:eyes_00'
        : 'urn:decentraland:off-chain:base-avatars:f_eyes_00'
    case 'upper_body':
      return shape === 'male'
        ? 'urn:decentraland:off-chain:base-avatars:green_hoodie'
        : 'urn:decentraland:off-chain:base-avatars:f_sweater'
    case 'lower_body':
      return shape === 'male'
        ? 'urn:decentraland:off-chain:base-avatars:brown_pants'
        : 'urn:decentraland:off-chain:base-avatars:f_jeans'
    case 'feet':
      return shape === 'male'
        ? 'urn:decentraland:off-chain:base-avatars:sneakers'
        : 'urn:decentraland:off-chain:base-avatars:bun_shoes'
    case 'hair':
      return 'urn:decentraland:off-chain:base-avatars:standard_hair'
    default:
      return null
  }
}

/** Full starter outfit — guest profile creation equips these explicitly. */
export const DEFAULT_WEARABLE_CATEGORIES: WearableCategory[] = [
  'eyebrows',
  'mouth',
  'eyes',
  'hair',
  'upper_body',
  'lower_body',
  'feet'
]

/** Body + starter clothing/face. Bundled under `public/avatar/wearables/`. */
export function defaultGuestWearableUrns(bodyShape: BodyShape): string[] {
  const wearables = [BODY_SHAPE_URN[bodyShape]]
  for (const cat of DEFAULT_WEARABLE_CATEGORIES) {
    const def = defaultWearableUrn(cat, bodyShape)
    if (def) wearables.push(def)
  }
  return wearables
}

/**
 * Profile resolve backfill only — face/hair (profiles store colors; missing these = bald/blank).
 * Clothing is NOT backfilled: empty upper/lower/feet shows base underwear (Explorer parity).
 */
export const BACKFILL_WEARABLE_CATEGORIES: WearableCategory[] = [
  'eyebrows',
  'mouth',
  'eyes',
  'hair'
]

export function normalizeUrn(urn: string): string {
  return urn.replace(/^dcl:\/\/base-avatars\//, 'urn:decentraland:off-chain:base-avatars:').toLowerCase()
}

/** Strip token id suffix from equipped wearable URNs before Catalyst lookup (Forge / Neurolink pattern). */
export function assetUrnFromCompleteUrn(completeUrn: string): string {
  const urn = normalizeUrn(completeUrn)
  const parts = urn.split(':')
  const thirdParty = 'collections-thirdparty'

  if (urn.includes(thirdParty) && parts.length === 10) {
    return parts.slice(0, 7).join(':')
  }
  // L1 profile URNs: urn:decentraland:{chain}:collections-v1:{collection}:{item}:{tokenId}
  if (parts.length >= 7 && parts[3] === 'collections-v1') {
    return parts.slice(0, 6).join(':')
  }
  // collections-v2 profile URNs: urn:decentraland:matic:collections-v2:{contract}:{itemId}:{tokenId}
  if (parts.length >= 7 && parts[3] === 'collections-v2') {
    return parts.slice(0, 6).join(':')
  }
  if (!urn.includes(thirdParty) && parts.length > 7) {
    return parts.slice(0, -1).join(':')
  }
  return urn
}

/**
 * Normalize a wearable URN for storage. Does **not** invent tokenIds — Catalyst rejects
 * synthetic `:0` tokens the wallet does not own. Prefer inventory `individualData` URNs.
 */
export function ensureItemWearableUrn(completeUrn: string): string {
  return normalizeUrn(completeUrn)
}

export function bodyShapeFromUrn(urn: string): BodyShape {
  return urn.toLowerCase().includes('basefemale') ? 'female' : 'male'
}

export function formatHex(color: string | undefined, fallback: string): string {
  const raw = (color ?? fallback).replace('#', '')
  return raw.length === 6 ? raw : fallback
}
