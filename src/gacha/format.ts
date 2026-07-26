import { formatEther } from 'viem'

export function shortAddr(a: string | undefined | null): string {
  if (!a || a.length < 12) return a ?? '—'
  return `${a.slice(0, 6)}…${a.slice(-4)}`
}

/**
 * Format wei → MANA with locale thousand separators.
 * e.g. 24992 → "24,992" · 21.71 → "21.71" · 0.0012 → "0.0012"
 */
export function formatMana(wei: bigint | string | number, digits = 2): string {
  try {
    const b = typeof wei === 'bigint' ? wei : BigInt(wei)
    const s = formatEther(b)
    const n = Number(s)
    if (!Number.isFinite(n)) return s
    if (n === 0) return '0'

    if (n >= 1000) {
      return n.toLocaleString(undefined, {
        maximumFractionDigits: 0,
        minimumFractionDigits: 0
      })
    }
    if (n >= 1) {
      return n.toLocaleString(undefined, {
        maximumFractionDigits: digits,
        minimumFractionDigits: 0
      })
    }
    // Sub-1 MANA: keep enough precision without scientific notation
    const frac = Math.min(4, digits + 2)
    return n.toLocaleString(undefined, {
      maximumFractionDigits: frac,
      minimumFractionDigits: 0
    })
  } catch {
    return '—'
  }
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
