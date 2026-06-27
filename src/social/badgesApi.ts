const BADGES_API_URL =
  (import.meta.env.VITE_BADGES_API_URL as string | undefined)?.trim().replace(/\/$/, '') ||
  'https://badges.decentraland.org'

export type UserBadge = {
  id: string
  name: string
  image: string
  tierName?: string | null
}

type BadgeProgress = {
  lastCompletedTierImage?: string | null
  lastCompletedTierName?: string | null
}

type BadgeAssets = {
  '2d'?: { normal?: string }
}

type AchievedBadge = {
  id: string
  name: string
  assets?: BadgeAssets
  progress?: BadgeProgress
}

function badgeImage(badge: AchievedBadge): string {
  return (
    badge.progress?.lastCompletedTierImage?.trim() ||
    badge.assets?.['2d']?.normal?.trim() ||
    ''
  )
}

function mapAchievedBadges(list: AchievedBadge[]): UserBadge[] {
  return list
    .map((badge) => ({
      id: badge.id,
      name: badge.name,
      image: badgeImage(badge),
      tierName: badge.progress?.lastCompletedTierName ?? null
    }))
    .filter((badge) => !!badge.image)
}

/** Achieved badges for profile cards — falls back to preview when full list is unavailable. */
export async function fetchUserBadges(address: string): Promise<UserBadge[]> {
  const user = address.trim().toLowerCase()
  if (!/^0x[a-f0-9]{40}$/.test(user)) return []

  try {
    const res = await fetch(`${BADGES_API_URL}/users/${user}/badges`)
    if (res.ok) {
      const raw = (await res.json()) as { data?: { achieved?: AchievedBadge[] } }
      return mapAchievedBadges(raw.data?.achieved ?? [])
    }
  } catch {
    // fall through to preview
  }

  try {
    const res = await fetch(`${BADGES_API_URL}/users/${user}/preview`)
    if (!res.ok) return []
    const raw = (await res.json()) as {
      data?: { latestAchievedBadges?: Array<{ id: string; name: string; image: string; tierName?: string | null }> }
    }
    return (raw.data?.latestAchievedBadges ?? []).map((badge) => ({
      id: badge.id,
      name: badge.name,
      image: badge.image,
      tierName: badge.tierName ?? null
    }))
  } catch {
    return []
  }
}