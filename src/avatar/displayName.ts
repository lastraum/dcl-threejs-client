import type { AvatarProfile } from './types'

/** Shorten a wallet address for name tags. */
export function shortenAddress(address: string): string {
  const normalized = address.trim().toLowerCase()
  if (!/^0x[a-f0-9]{40}$/.test(normalized)) return address.trim() || 'Guest'
  return `${normalized.slice(0, 6)}…${normalized.slice(-4)}`
}

/** Scene-authored AvatarShape.name — null when unset (no overhead label). */
export function avatarShapeSceneLabel(name?: string | null): string | null {
  const trimmed = name?.trim()
  return trimmed ? trimmed : null
}

/** Legacy helper — empty names map to "NPC" for non-tag call sites only. */
export function avatarShapeDisplayName(name?: string | null): string {
  return avatarShapeSceneLabel(name) ?? 'NPC'
}

export function identityShowsNameTag(identity: ProfileIdentity): boolean {
  return identity.displayName.trim().length > 0
}

export type ProfileIdentity = {
  displayName: string
  nameColor: string
  hasClaimedName: boolean
}

export function identityFromAvatarProfile(profile: AvatarProfile, address?: string): ProfileIdentity {
  return {
    displayName:
      profile.displayName?.trim() ||
      (address ? shortenAddress(address) : 'Guest'),
    nameColor: profile.nameColor ?? '#ffffff',
    hasClaimedName: profile.hasClaimedName ?? false
  }
}

export function defaultProfileIdentity(fallbackName = 'Guest'): ProfileIdentity {
  return {
    displayName: fallbackName,
    nameColor: '#ffffff',
    hasClaimedName: false
  }
}
