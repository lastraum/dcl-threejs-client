export type ChatChannelChoice =
  | { kind: 'scene'; sceneKey: string; label: string }
  | { kind: 'messages' }
  | { kind: 'community'; communityId: string; displayName: string }

export type CommunityListRow = {
  id: string
  name: string
  ownerAddress?: string
  role?: string
  thumbnails?: Record<string, string>
  memberCount?: number
  isPrivate?: boolean
}

export type ChatLine = {
  id: string
  text: string
  time: number
  self?: boolean
  senderName?: string
  senderAddress?: string
}

export type SceneChatTab = {
  key: string
  label: string
  pointer: string
}
