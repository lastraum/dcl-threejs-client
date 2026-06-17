/** EVM address: `0x` + short head … last 4 (e.g. `0x1234…abcd`). */
export function formatWalletAddress(addr: string | undefined): string {
  if (!addr) return 'unknown'
  const a = addr.trim()
  if (!/^0x[a-fA-F0-9]{40}$/.test(a)) {
    return a.length > 18 ? `${a.slice(0, 12)}…` : a
  }
  const lower = a.toLowerCase()
  return `${lower.slice(0, 6)}…${lower.slice(-4)}`
}

export function isEvmAddress(s: string | undefined): boolean {
  return typeof s === 'string' && /^0x[a-fA-F0-9]{40}$/.test(s.trim())
}
