import { formatWalletAddress, isEvmAddress } from './walletLabel'

/** Whether `text` includes an @-mention of the signed-in user (wallet short form, full `0x` address, or display name). */
export function textChatMentionsSelf(
  text: string,
  sessionAddress: string | null | undefined,
  selfDisplayName?: string | null
): boolean {
  const addr = sessionAddress?.trim()
  if (!text?.trim() || !addr || !isEvmAddress(addr)) return false

  const lowAddr = addr.toLowerCase()
  const targets = new Set<string>()
  targets.add(lowAddr)

  const shortW = formatWalletAddress(addr)
  targets.add(shortW.toLowerCase())
  if (shortW.includes('…')) {
    targets.add(shortW.replace(/…/g, '...').toLowerCase())
  }

  const dn = selfDisplayName?.trim()
  if (dn) {
    targets.add(dn.replace(/\s+/g, '_').toLowerCase())
  }

  const re = /@([^\s@]+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const token = (m[1] ?? '').toLowerCase()
    if (targets.has(token)) return true
  }
  return false
}
