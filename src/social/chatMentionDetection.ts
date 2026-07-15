import { guestDisplayNameFromAddress } from '../auth/guestIdentity'
import { formatWalletAddress, isEvmAddress } from './walletLabel'
import { appendLinkifiedText, type LinkifyChatOptions } from './linkifyText'

const MENTION_RE = /@([^\s@]+)/g
/** Explorer-style unclaimed guest: Guest10e7#b63d (head + tail of wallet hex). */
const GUEST_DISCRIMINATOR_RE = /^guest[-_]?([a-f0-9]{4})(?:#([a-f0-9]{4}))?$/i

/** Lowercase tokens that count as an @-mention of the signed-in user. */
export function selfMentionTokens(
  sessionAddress: string | null | undefined,
  selfDisplayName?: string | null
): Set<string> {
  const targets = new Set<string>()
  const addr = sessionAddress?.trim()
  if (!addr || !isEvmAddress(addr)) return targets

  const lowAddr = addr.toLowerCase()
  const hex = lowAddr.slice(2)
  const head4 = hex.slice(0, 4)
  const tail4 = hex.slice(-4)

  targets.add(lowAddr)

  const shortW = formatWalletAddress(addr)
  targets.add(shortW.toLowerCase())
  if (shortW.includes('…')) {
    targets.add(shortW.replace(/…/g, '...').toLowerCase())
  }
  targets.add(`${lowAddr.slice(0, 6)}...${lowAddr.slice(-4)}`)
  targets.add(`${lowAddr.slice(0, 6)}…${lowAddr.slice(-4)}`)

  // Our guest label + common Explorer variants derived from the same wallet
  const ourGuest = guestDisplayNameFromAddress(lowAddr) // Guest-10e7
  targets.add(ourGuest.toLowerCase())
  targets.add(ourGuest.replace(/-/g, '').toLowerCase()) // guest10e7
  targets.add(`guest${head4}#${tail4}`) // guest10e7#b63d
  targets.add(`guest-${head4}#${tail4}`)
  targets.add(`guest_${head4}#${tail4}`)
  targets.add(`#${head4}${tail4}`)
  targets.add(`#${tail4}`)

  const dn = selfDisplayName?.trim()
  if (dn && dn.toLowerCase() !== 'you') {
    targets.add(dn.toLowerCase())
    targets.add(dn.replace(/\s+/g, '_').toLowerCase())
    targets.add(dn.replace(/\s+/g, '').toLowerCase())
    targets.add(dn.replace(/-/g, '').toLowerCase())
    // Guest-10e7 → also Guest10e7#tail when name is our guest form
    const m = GUEST_DISCRIMINATOR_RE.exec(dn.replace(/\s+/g, ''))
    if (m?.[1]) {
      targets.add(`guest${m[1].toLowerCase()}#${tail4}`)
      targets.add(`guest-${m[1].toLowerCase()}`)
    }
  }

  return targets
}

function normalizeMentionToken(raw: string): string {
  // Keep # (DCL guest discriminators); strip trailing sentence punctuation only.
  return raw.toLowerCase().replace(/[.,!?;:]+$/g, '')
}

/** Token matches local user via explicit set or Guest{head}#{tail} vs wallet. */
export function mentionTokenMatchesSelf(
  token: string,
  targets: Set<string>,
  sessionAddress?: string | null
): boolean {
  if (targets.size === 0) return false
  const t = normalizeMentionToken(token)
  if (!t) return false
  if (targets.has(t)) return true

  // Full wallet or long 0x prefix typed by hand
  if (t.startsWith('0x') && t.length >= 10) {
    for (const target of targets) {
      if (!target.startsWith('0x') || target.includes('…') || target.includes('...')) continue
      if (target === t || (target.length === 42 && (target.startsWith(t) || t.startsWith(target)))) {
        return true
      }
    }
  }

  // Guest10e7#b63d ↔ local wallet head/tail even if display name differs
  const addr = sessionAddress?.trim().toLowerCase()
  if (addr && isEvmAddress(addr)) {
    const hex = addr.slice(2)
    const head4 = hex.slice(0, 4)
    const tail4 = hex.slice(-4)
    const gm = GUEST_DISCRIMINATOR_RE.exec(t)
    if (gm) {
      const head = (gm[1] ?? '').toLowerCase()
      const tail = (gm[2] ?? '').toLowerCase()
      if (head === head4 && (!tail || tail === tail4)) return true
    }
  }

  return false
}

/** Whether `text` includes an @-mention of the signed-in user (wallet short form, full `0x` address, or display name). */
export function textChatMentionsSelf(
  text: string,
  sessionAddress: string | null | undefined,
  selfDisplayName?: string | null
): boolean {
  if (!text?.trim()) return false
  const targets = selfMentionTokens(sessionAddress, selfDisplayName)
  if (targets.size === 0) return false

  MENTION_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = MENTION_RE.exec(text)) !== null) {
    if (mentionTokenMatchesSelf(m[1] ?? '', targets, sessionAddress)) return true
  }
  return false
}

/**
 * Render chat body: links + purple chip on @-tokens that mention the local user.
 * `selfTargets` from {@link selfMentionTokens}.
 */
export function appendChatTextWithSelfMentions(
  container: HTMLElement,
  text: string,
  selfTargets: Set<string>,
  linkOpts: LinkifyChatOptions = {},
  sessionAddress?: string | null
): void {
  if (!selfTargets.size) {
    appendLinkifiedText(container, text, linkOpts)
    return
  }

  MENTION_RE.lastIndex = 0
  let last = 0
  let m: RegExpExecArray | null
  let any = false

  while ((m = MENTION_RE.exec(text)) !== null) {
    const token = m[1] ?? ''
    if (!mentionTokenMatchesSelf(token, selfTargets, sessionAddress)) continue
    any = true
    const start = m.index
    if (start > last) {
      appendLinkifiedText(container, text.slice(last, start), linkOpts)
    }
    const chip = document.createElement('span')
    chip.className = 'chat-panel__mention-self'
    chip.textContent = text.slice(start, start + m[0].length)
    container.appendChild(chip)
    last = start + m[0].length
  }

  if (!any) {
    appendLinkifiedText(container, text, linkOpts)
    return
  }
  if (last < text.length) {
    appendLinkifiedText(container, text.slice(last), linkOpts)
  }
}
