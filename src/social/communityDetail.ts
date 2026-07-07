import type { CommunityDetail } from './types'
import { coerceThumbnailRecord } from './memberCommunities'

function extractIsPrivate(source: Record<string, unknown>): boolean | undefined {
  if (source.privacy === 'private' || source.visibility === 'private' || source.isPrivate === true) return true
  if (source.privacy === 'public' || source.visibility === 'public') return false
  return undefined
}

/** Parse Social API `GET /v1/communities/{id}` JSON. */
export function parseCommunityDetailJson(raw: unknown): CommunityDetail | null {
  if (!raw || typeof raw !== 'object') return null
  const root = raw as Record<string, unknown>
  let d: unknown = root.data
  if (d && typeof d === 'object' && d !== null && 'community' in d) {
    d = (d as { community: unknown }).community
  }
  if (!d || typeof d !== 'object') return null
  const o = d as Record<string, unknown>
  const id = typeof o.id === 'string' ? o.id.trim() : ''
  const name = typeof o.name === 'string' ? o.name.trim() : ''
  if (!id || !name) return null

  const description = typeof o.description === 'string' ? o.description.trim() : ''
  const ownerAddress =
    typeof o.ownerAddress === 'string'
      ? o.ownerAddress
      : typeof o.owner_address === 'string'
        ? o.owner_address
        : undefined
  const ownerName = typeof o.ownerName === 'string' ? o.ownerName.trim() : undefined
  const memberCount =
    typeof o.memberCount === 'number'
      ? o.memberCount
      : typeof o.membersCount === 'number'
        ? o.membersCount
        : typeof o.totalMembers === 'number'
          ? o.totalMembers
          : undefined
  const role = typeof o.role === 'string' ? o.role : undefined
  const thumbnails = coerceThumbnailRecord(o)

  let voiceChatActive: boolean | undefined
  let voiceParticipantCount: number | undefined
  const vcs = o.voiceChatStatus
  if (vcs && typeof vcs === 'object' && vcs !== null) {
    const vs = vcs as Record<string, unknown>
    if (typeof vs.isActive === 'boolean') {
      voiceChatActive = vs.isActive
      if (typeof vs.participantCount === 'number') voiceParticipantCount = vs.participantCount
    }
  }

  return {
    id,
    name,
    description,
    thumbnails,
    isPrivate: extractIsPrivate(o),
    memberCount,
    ownerAddress,
    ownerName,
    role,
    voiceChatActive,
    voiceParticipantCount
  }
}