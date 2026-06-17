import type { LivePeer } from './types'

const PARCEL_SIZE_M = 16
const MAX_ABS_COORD = 50_000

export function normalizeWallet(wallet: string): string {
  return wallet.trim().toLowerCase()
}

export function parcelKeyFromPeer(peer: LivePeer): string {
  return `${peer.parcel[0]},${peer.parcel[1]}`
}

export function parcelIndicesFromPeer(peer: LivePeer): { px: number; py: number } | null {
  const [px, py] = peer.parcel
  if (Number.isFinite(px) && Number.isFinite(py)) {
    return { px, py }
  }

  const pos = peer.position
  if (pos && isFinitePosition(pos)) {
    return {
      px: Math.floor(pos.x / PARCEL_SIZE_M),
      py: Math.floor(pos.z / PARCEL_SIZE_M)
    }
  }

  return null
}

export function isFinitePosition(pos: { x: number; y: number; z: number }): boolean {
  return (
    [pos.x, pos.y, pos.z].every((n) => Number.isFinite(n)) &&
    Math.abs(pos.x) < MAX_ABS_COORD &&
    Math.abs(pos.y) < MAX_ABS_COORD &&
    Math.abs(pos.z) < MAX_ABS_COORD
  )
}
