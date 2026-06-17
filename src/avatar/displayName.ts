import type { AvatarProfile } from './types'

/** Shorten a wallet address for name tags. */
export function shortenAddress(address: string): string {
  const normalized = address.trim().toLowerCase()
  if (!/^0x[a-f0-9]{40}$/.test(normalized)) return address.trim() || 'Guest'
  return `${normalized.slice(0, 6)}…${normalized.slice(-4)}`
}

/** Visible label from AvatarShape.name (Explorer default: "NPC"). */
export function avatarShapeDisplayName(name?: string | null): string {
  const trimmed = name?.trim()
  return trimmed && trimmed.length > 0 ? trimmed : 'NPC'
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
