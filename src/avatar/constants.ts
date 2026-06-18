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
export const AVATAR_EMOTE_RUN = '/avatar/emotes/run.glb'
export const AVATAR_EMOTE_JUMP = '/avatar/emotes/jump.glb'
/** Explorer Double_Jump twirl — bundle when available; loader falls back to jump.glb. */
export const AVATAR_EMOTE_DOUBLE_JUMP = '/avatar/emotes/double_jump.glb'

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
    default:
      return null
  }
}

export const DEFAULT_WEARABLE_CATEGORIES: WearableCategory[] = [
  'eyebrows',
  'mouth',
  'eyes',
  'upper_body',
  'lower_body',
  'feet'
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

export function bodyShapeFromUrn(urn: string): BodyShape {
  return urn.toLowerCase().includes('basefemale') ? 'female' : 'male'
}

export function formatHex(color: string | undefined, fallback: string): string {
  const raw = (color ?? fallback).replace('#', '')
  return raw.length === 6 ? raw : fallback
}
