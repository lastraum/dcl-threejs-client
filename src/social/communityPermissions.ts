/**
 * Community role / ownership checks — parity with dcl-companion
 * (`communityVoiceSessionPolicy.ts`, `communityVoiceAccess.ts`).
 *
 * Social `role` on GET /v1/communities/{id} is typically OWNER | MODERATOR | MEMBER.
 * Owners/moderators (and wallets matching `ownerAddress`) may post announcements
 * and start/end community voice streams.
 */

const ADDR_RE = /^0x[a-fA-F0-9]{40}$/

function normalizeRole(role: string | undefined | null): string {
  return (role ?? '').trim().toLowerCase()
}

/** Owner, moderator, mod, or admin may moderate community content / voice. */
export function canManageCommunityRole(role: string | undefined | null): boolean {
  const r = normalizeRole(role)
  return r === 'owner' || r === 'moderator' || r === 'mod' || r === 'admin'
}

/** True when this wallet is the community owner (detail/list may omit `role`). */
export function sessionIsCommunityOwner(
  sessionAddress: string | null | undefined,
  ownerAddress: string | null | undefined
): boolean {
  const s = typeof sessionAddress === 'string' ? sessionAddress.trim().toLowerCase() : ''
  const o = typeof ownerAddress === 'string' ? ownerAddress.trim().toLowerCase() : ''
  if (!s || !o || !ADDR_RE.test(s) || !ADDR_RE.test(o)) return false
  return s === o
}

/**
 * Post announcements + moderate hangouts — companion `canModerateAnnouncements`.
 * Role owner/moderator/admin, or wallet matches ownerAddress.
 */
export function canPostCommunityAnnouncements(
  role: string | undefined | null,
  sessionAddress?: string | null,
  ownerAddress?: string | null
): boolean {
  if (canManageCommunityRole(role)) return true
  return sessionIsCommunityOwner(sessionAddress, ownerAddress)
}

/**
 * Start / end community voice stream — companion `canManageCommunityVoiceRole`
 * plus owner-address fallback used when opening the live voice sheet.
 */
export function canManageCommunityVoice(
  role: string | undefined | null,
  sessionAddress?: string | null,
  ownerAddress?: string | null
): boolean {
  if (canManageCommunityRole(role)) return true
  return sessionIsCommunityOwner(sessionAddress, ownerAddress)
}
