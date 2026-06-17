import { formatWalletAddress } from './walletLabel'

export const CHAT_MAX_LENGTH = 140

/** Active @-token: start index of `@`, query is text after `@` with no spaces (caret at end of token). */
export function parseActiveMention(value: string, caret: number): { start: number; query: string } | null {
  const safeCaret = Math.max(0, Math.min(caret, value.length))
  const before = value.slice(0, safeCaret)
  const at = before.lastIndexOf('@')
  if (at < 0) return null
  if (at > 0 && !/\s/.test(before[at - 1]!)) return null
  const token = before.slice(at + 1)
  if (/\s/.test(token)) return null
  return { start: at, query: token }
}

export function effectiveCaretForMention(value: string, rawCaret: number): number {
  let c = rawCaret
  if (c == null || Number.isNaN(c)) return value.length
  if (c < 0) c = 0
  if (c > value.length) c = value.length
  if (parseActiveMention(value, c) != null) return c
  const atEnd = parseActiveMention(value, value.length)
  if (atEnd) return value.length
  return c
}

export function mentionInsertLabel(displayName: string | undefined, addr: string): string {
  const d = displayName?.trim()
  if (d) return d.replace(/\s+/g, '_')
  return formatWalletAddress(addr)
}

export function applyMentionToDraft(
  value: string,
  start: number,
  caret: number,
  label: string
): { next: string; caretPos: number } {
  const left = value.slice(0, start)
  const right = value.slice(caret)
  const mention = `@${label} `
  const next = left + mention + right
  return { next, caretPos: start + mention.length }
}

export type MentionCandidate = {
  address: string
  displayName: string
  faceUrl: string | null
}

export function filterMentionPopupRows(
  rows: MentionCandidate[],
  query: string,
  cap = 16
): MentionCandidate[] {
  const q = query.toLowerCase()
  if (!q) return rows.slice(0, cap)
  const filtered = rows.filter(({ displayName, address }) => {
    const n = displayName.toLowerCase()
    const a = address.toLowerCase()
    const qHex = q.replace(/^0x/, '')
    return n.includes(q) || a.includes(q) || (qHex.length > 0 && a.includes(qHex))
  })
  if (filtered.length > 0) return filtered.slice(0, cap)
  return rows.slice(0, cap)
}
