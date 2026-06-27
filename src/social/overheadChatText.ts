import { isSceneChatEmoteWireText } from './dclRfc4Chat'

/** Whether a scene chat line should appear on the avatar name-tag pill. */
export function overheadChatText(text: string): string | null {
  const trimmed = text.trim()
  if (!trimmed || trimmed.startsWith('/')) return null
  if (isSceneChatEmoteWireText(trimmed)) return null
  return trimmed
}