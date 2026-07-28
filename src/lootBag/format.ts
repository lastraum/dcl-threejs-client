import { formatEther } from 'viem'
import { DEFAULT_DEPOSITOR_BID_RATE_BPS } from './config'

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

/**
 * Net mMANA (wei) a claimer receives when taking tokens instead of the prize.
 * Uses depositor bid rate (default 85% of backing); protocol keeps the remainder.
 */
export function takeTokensNetWei(
  backing: bigint,
  depositorBidRateBps: number = DEFAULT_DEPOSITOR_BID_RATE_BPS
): bigint {
  if (backing <= 0n) return 0n
  const bps = BigInt(Math.max(0, Math.min(10_000, Math.floor(depositorBidRateBps))))
  return (backing * bps) / 10_000n
}

/**
 * On-chain weight = WEIGHT_SCALE / backing (wei), so chance ∝ 1/backing.
 * @see GachaPoolUpgradeable.WEIGHT_SCALE = 1e36
 */
const WEIGHT_SCALE = 10n ** 36n

/**
 * Map positionId → display chance string (e.g. "12.4%") for the active shelf.
 * Matches contract inverse-backing weights.
 */
export function computeClaimChanceLabels(
  positions: readonly { positionId: number; backing: bigint }[]
): Map<number, string> {
  let total = 0n
  const weights = new Map<number, bigint>()
  for (const p of positions) {
    if (p.backing <= 0n) {
      weights.set(p.positionId, 0n)
      continue
    }
    const w = WEIGHT_SCALE / p.backing
    weights.set(p.positionId, w)
    total += w
  }
  const out = new Map<number, string>()
  for (const [id, w] of weights) {
    if (total === 0n || w === 0n) {
      out.set(id, '—')
      continue
    }
    // One decimal place, half-up: tenths of a percent
    const tenths = (w * 1000n + total / 2n) / total
    const whole = tenths / 10n
    const frac = tenths % 10n
    out.set(id, `${whole}.${frac}%`)
  }
  return out
}
