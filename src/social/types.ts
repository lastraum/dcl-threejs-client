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

export type ChatTextLine = {
  kind?: 'text'
  id: string
  text: string
  time: number
  self?: boolean
  senderName?: string
  senderAddress?: string
}

export type ChatImageLine = {
  kind: 'image'
  id: string
  messageId: string
  objectUrl: string
  mime: string
  width: number
  height: number
  time: number
  self?: boolean
  senderAddress?: string
}

export type ChatLine = ChatTextLine | ChatImageLine

export function isChatImageLine(line: ChatLine): line is ChatImageLine {
  return line.kind === 'image'
}

export function isChatTextLine(line: ChatLine): line is ChatTextLine {
  return line.kind !== 'image'
}

export type SceneChatTab = {
  key: string
  label: string
  pointer: string
}
