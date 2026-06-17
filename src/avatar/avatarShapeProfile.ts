import type { PBAvatarShape } from '@dcl/ecs/dist/components/generated/pb/decentraland/sdk/components/avatar_shape.gen'
import { normalizeProfileWearables } from './peerApi'
import {
  avatarShapeDisplayName,
  defaultProfileIdentity,
  identityFromAvatarProfile,
  type ProfileIdentity
} from './displayName'
import { fetchProfileCached } from './peerApi'
import type { AvatarProfile } from './types'

function colorChannel(value: number): number {
  return Math.round(value <= 1 ? value * 255 : value)
}

function color3ToHex(c?: { r?: number | null; g?: number | null; b?: number | null }, fallback = 'cc9b76'): string {
  if (c?.r === undefined || c?.r === null) return fallback
  const to = (v: number) => colorChannel(v).toString(16).padStart(2, '0')
  return `${to(c.r)}${to(c.g ?? 0)}${to(c.b ?? 0)}`
}

const WALLET = /^0x[a-f0-9]{40}$/

/** Map mirror `AvatarShape` payload → compose pipeline profile. */
export function profileFromAvatarShape(shape: PBAvatarShape): AvatarProfile {
  const { bodyShape, wearables } = normalizeProfileWearables(shape.bodyShape, shape.wearables)
  const address = shape.id?.trim().toLowerCase()
  return {
    bodyShape,
    skin: color3ToHex(shape.skinColor, '999966'),
    hair: color3ToHex(shape.hairColor, '482400'),
    eyes: color3ToHex(shape.eyeColor, '999966'),
    wearables,
    forceRender: [],
    emotes: [],
    fromWallet: false,
    address: address && WALLET.test(address) ? address : undefined
  }
}

/** Resolve visible name + profile color for an AvatarShape entity. */
export async function resolveShapeIdentity(shape: PBAvatarShape): Promise<ProfileIdentity> {
  const sceneName = shape.name?.trim()
  const fallback = avatarShapeDisplayName(sceneName)
  const address = shape.id?.trim().toLowerCase()

  if (address && WALLET.test(address)) {
    const profile = await fetchProfileCached(address)
    if (profile) {
      const identity = identityFromAvatarProfile(profile, address)
      if (sceneName) return { ...identity, displayName: sceneName }
      return identity
    }
  }

  return defaultProfileIdentity(fallback)
}

/** Stable key for detecting appearance changes without deep compare. */
export function avatarShapeSignature(shape: PBAvatarShape): string {
  return JSON.stringify({
    id: shape.id,
    bodyShape: shape.bodyShape,
    skinColor: shape.skinColor,
    hairColor: shape.hairColor,
    eyeColor: shape.eyeColor,
    wearables: shape.wearables,
    showOnlyWearables: shape.showOnlyWearables
  })
}

/** Key for name-tag refresh when label sources change. */
export function avatarShapeNameKey(shape: PBAvatarShape): string {
  return `${shape.id ?? ''}|${shape.name ?? ''}`
}
