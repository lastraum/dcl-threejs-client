import type { DclTranslationProvider } from './provider'
import type { LanguageCode, TranslationResult } from './types'

/**
 * Lightweight port of Unity Explorer ChatMessageProcessor:
 * tokenize → protect non-translatable spans → batch-translate text → stitch.
 */

export type TokType = 'text' | 'tag' | 'protected' | 'emoji' | 'number' | 'command' | 'mention'

export type Tok = { type: TokType; value: string }

const TAG_RX = /<[^>]*>/g
const URL_RX = /https?:\/\/[^\s<>]+/gi
/**
 * Inline slash commands — command name + at most one arg (e.g. `/goto 0,0`).
 * Avoid swallowing the rest of the sentence after the command.
 */
const SLASH_CMD_RX = /(?:^|\s)(\/[a-zA-Z][\w-]*(?:\s+\S+)?)/g
/** @name or @0xabc… mentions */
const MENTION_RX = /@[a-zA-Z0-9_.\-]{1,64}|@0x[a-fA-F0-9]{4,}/g
/**
 * Currency / times / dates / numbers — keep as-is.
 * Order matters: times and dates before bare numbers so "3:00 PM" stays one token.
 */
const NUMBER_RX =
  /\d{1,2}:\d{2}(?::\d{2})?(?:\s?[AaPp][Mm])?|\d{4}-\d{2}-\d{2}|\d{1,2}[./]\d{1,2}[./]\d{2,4}|(?:\$|€|£|¥)\d{1,3}(?:,\d{3})*(?:\.\d+)?%?|\b\d{1,3}(?:,\d{3})+(?:\.\d+)?%?|\b\d+(?:\.\d+)?%?\b/g
/**
 * Emoji (basic coverage): emoji blocks + ZWJ sequences + VS16.
 * Good enough for chat; not a full UAX #29 grapheme clusterizer.
 */
const EMOJI_RX =
  /(?:\p{Extended_Pictographic}(?:\uFE0F|\uFE0E)?(?:\u200D\p{Extended_Pictographic}(?:\uFE0F|\uFE0E)?)*)|\u00A9|\u00AE|[\u2000-\u3300]/gu

export function requiresProcessing(text: string): boolean {
  if (!text) return false
  if (TAG_RX.test(text)) return true
  TAG_RX.lastIndex = 0
  if (URL_RX.test(text)) return true
  URL_RX.lastIndex = 0
  if (MENTION_RX.test(text)) return true
  MENTION_RX.lastIndex = 0
  if (SLASH_CMD_RX.test(text)) return true
  SLASH_CMD_RX.lastIndex = 0
  if (NUMBER_RX.test(text)) return true
  NUMBER_RX.lastIndex = 0
  if (EMOJI_RX.test(text)) return true
  EMOJI_RX.lastIndex = 0
  return false
}

function splitByRegex(tokens: Tok[], type: TokType, rx: RegExp): Tok[] {
  const out: Tok[] = []
  for (const tok of tokens) {
    if (tok.type !== 'text' || !tok.value) {
      out.push(tok)
      continue
    }
    rx.lastIndex = 0
    let last = 0
    let m: RegExpExecArray | null
    const s = tok.value
    while ((m = rx.exec(s)) !== null) {
      if (m.index > last) {
        out.push({ type: 'text', value: s.slice(last, m.index) })
      }
      // Prefer capture group 1 when present (e.g. slash cmds with leading space).
      const full = m[0]
      const core = m[1] ?? full
      if (m[1] !== undefined && full.length > core.length) {
        const lead = full.slice(0, full.length - core.length)
        if (lead) out.push({ type: 'text', value: lead })
        out.push({ type, value: core })
      } else {
        out.push({ type, value: full })
      }
      last = m.index + full.length
      // Zero-width guard
      if (m[0].length === 0) rx.lastIndex++
    }
    if (last < s.length) out.push({ type: 'text', value: s.slice(last) })
  }
  return out
}

/** Split angle-bracket TMP/rich tags vs text. */
function segmentAngleBrackets(raw: string): Tok[] {
  const out: Tok[] = []
  TAG_RX.lastIndex = 0
  let last = 0
  let m: RegExpExecArray | null
  while ((m = TAG_RX.exec(raw)) !== null) {
    if (m.index > last) out.push({ type: 'text', value: raw.slice(last, m.index) })
    out.push({ type: 'tag', value: m[0] })
    last = m.index + m[0].length
  }
  if (last < raw.length) out.push({ type: 'text', value: raw.slice(last) })
  if (out.length === 0 && raw) out.push({ type: 'text', value: raw })
  return out
}

/**
 * Protect content inside <link=…>…</link> (usernames, coords, etc.).
 * Marks inner text tokens as protected.
 */
function protectLinkContents(tokens: Tok[]): Tok[] {
  const out: Tok[] = []
  let inLink = false
  for (const tok of tokens) {
    if (tok.type === 'tag') {
      const lower = tok.value.toLowerCase()
      if (lower.startsWith('<link')) inLink = true
      else if (lower.startsWith('</link')) inLink = false
      out.push(tok)
      continue
    }
    if (inLink && tok.type === 'text') {
      out.push({ type: 'protected', value: tok.value })
    } else {
      out.push(tok)
    }
  }
  return out
}

export function tokenizeChatMessage(raw: string): Tok[] {
  let tokens = segmentAngleBrackets(raw)
  tokens = protectLinkContents(tokens)
  tokens = splitByRegex(tokens, 'protected', URL_RX)
  tokens = splitByRegex(tokens, 'mention', MENTION_RX)
  tokens = splitByRegex(tokens, 'command', SLASH_CMD_RX)
  tokens = splitByRegex(tokens, 'number', NUMBER_RX)
  tokens = splitByRegex(tokens, 'emoji', EMOJI_RX)
  return tokens
}

function extractTextCores(tokens: Tok[]): {
  cores: string[]
  idxs: number[]
  leading: string[]
  trailing: string[]
} {
  const cores: string[] = []
  const idxs: number[] = []
  const leading: string[] = []
  const trailing: string[] = []

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]!
    if (tok.type !== 'text') continue
    const v = tok.value
    if (!v) continue
    const L = v.match(/^\s*/)?.[0].length ?? 0
    const R = v.match(/\s*$/)?.[0].length ?? 0
    if (L + R >= v.length) continue
    leading.push(v.slice(0, L))
    trailing.push(v.slice(v.length - R))
    cores.push(v.slice(L, v.length - R))
    idxs.push(i)
  }
  return { cores, idxs, leading, trailing }
}

function stitch(tokens: Tok[]): string {
  let s = ''
  for (const t of tokens) s += t.value
  return s
}

function majorityLanguage(langs: Array<string | null>): string | null {
  const counts = new Map<string, number>()
  for (const l of langs) {
    if (!l) continue
    const k = l.toLowerCase()
    counts.set(k, (counts.get(k) ?? 0) + 1)
  }
  let best: string | null = null
  let bestN = 0
  for (const [k, n] of counts) {
    if (n > bestN) {
      best = k
      bestN = n
    }
  }
  return best
}

/**
 * Process complex chat text: protect structured spans, translate only prose, reassemble.
 */
export async function processAndTranslate(
  rawText: string,
  target: LanguageCode,
  provider: DclTranslationProvider,
  signal?: AbortSignal
): Promise<TranslationResult> {
  const tokens = tokenizeChatMessage(rawText)
  const { cores, idxs, leading, trailing } = extractTextCores(tokens)

  if (cores.length === 0) {
    return { translatedText: rawText, detectedLanguage: null, fromCache: false }
  }

  const batch = await provider.translateBatch(cores, target, signal)
  const detected = majorityLanguage(batch.map((b) => b.detectedLanguage))

  for (let k = 0; k < idxs.length; k++) {
    const i = idxs[k]!
    const translated = batch[k]?.translatedText ?? cores[k]!
    tokens[i] = {
      type: 'text',
      value: `${leading[k] ?? ''}${translated}${trailing[k] ?? ''}`
    }
  }

  return {
    translatedText: stitch(tokens),
    detectedLanguage: detected,
    fromCache: false
  }
}
