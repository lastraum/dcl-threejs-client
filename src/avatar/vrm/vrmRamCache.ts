import type { CustomAvatarFormat } from './constants'

/**
 * In-memory custom avatar bytes received from peers — never written to IndexedDB.
 *
 * **Survives World rebuild** (tour /goto / follow teleport). Cleared only when leaving
 * play or signing out — otherwise every teleport forced multi‑MB re-fetches and remotes
 * fell back to DCL bodies until DAV finished again.
 */
const ramByHash = new Map<string, ArrayBuffer>()
const formatByHash = new Map<string, CustomAvatarFormat>()

/** Peer wallet → last known DAV equip (hash + format). Session-scoped with RAM. */
const peerEquipByAddress = new Map<string, { hash: string; format: CustomAvatarFormat }>()

function key(hash: string): string {
  return hash.toLowerCase()
}

function addrKey(address: string): string {
  return address.toLowerCase()
}

export function getVrmRamBytes(contentHash: string): ArrayBuffer | null {
  return ramByHash.get(key(contentHash)) ?? null
}

export function getVrmRamFormat(contentHash: string): CustomAvatarFormat | null {
  return formatByHash.get(key(contentHash)) ?? null
}

export function putVrmRamBytes(
  contentHash: string,
  bytes: ArrayBuffer,
  format: CustomAvatarFormat = 'vrm'
): void {
  const k = key(contentHash)
  ramByHash.set(k, bytes)
  formatByHash.set(k, format === 'odk' ? 'odk' : 'vrm')
}

export function hasVrmRamBytes(contentHash: string): boolean {
  return ramByHash.has(key(contentHash))
}

export function deleteVrmRamBytes(contentHash: string): void {
  const k = key(contentHash)
  ramByHash.delete(k)
  formatByHash.delete(k)
}

/** Remember which custom avatar a peer last announced (for post-teleport remount). */
export function setSessionPeerVrmEquip(
  address: string,
  contentHash: string,
  format: CustomAvatarFormat = 'vrm'
): void {
  const a = addrKey(address)
  const h = key(contentHash)
  if (!a || !h) return
  peerEquipByAddress.set(a, { hash: h, format: format === 'odk' ? 'odk' : 'vrm' })
}

export function clearSessionPeerVrmEquip(address: string): void {
  peerEquipByAddress.delete(addrKey(address))
}

export function getSessionPeerVrmEquip(
  address: string
): { hash: string; format: CustomAvatarFormat } | null {
  return peerEquipByAddress.get(addrKey(address)) ?? null
}

/** Iterate session peer equips (World rebuild hydration). */
export function forEachSessionPeerVrmEquip(
  fn: (address: string, hash: string, format: CustomAvatarFormat) => void
): void {
  for (const [address, equip] of peerEquipByAddress) {
    fn(address, equip.hash, equip.format)
  }
}

export function sessionPeerVrmEquipCount(): number {
  return peerEquipByAddress.size
}

/**
 * Drop all peer VRM bytes + equip map.
 * Call when leaving play / signing out — **not** on World.dispose (tour teleports).
 */
export function clearVrmRamCache(): void {
  ramByHash.clear()
  formatByHash.clear()
  peerEquipByAddress.clear()
}
