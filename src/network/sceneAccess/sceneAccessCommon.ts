import type { SceneMetadata } from '../../dcl/content/types'
import { isParcelPointer, normalizePointer, realmNameForCommsPointer } from '../catalyst/pointer'

export type GatekeeperCommsContext = {
  pointer: string
  baseParcel: string
  realmName?: string
}

const ETH_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/

export function normalizeWalletAddress(address: string): string {
  return address.trim().toLowerCase()
}

export function blacklistFromMetadata(metadata: SceneMetadata): string[] {
  const policy = metadata.policy
  if (!policy || typeof policy !== 'object') return []
  const raw = policy.blacklist
  if (!Array.isArray(raw)) return []

  const out: string[] = []
  for (const entry of raw) {
    if (typeof entry === 'string' && ETH_ADDRESS_RE.test(entry.trim())) {
      out.push(normalizeWalletAddress(entry))
    }
  }
  return out
}

export function isAddressMetadataBlacklisted(
  blacklist: string[] | undefined,
  address: string
): boolean {
  if (!blacklist?.length) return false
  const normalized = normalizeWalletAddress(address)
  return blacklist.some((entry) => normalizeWalletAddress(entry) === normalized)
}

export function gatekeeperParcelForComms(target: GatekeeperCommsContext): string {
  const pointer = normalizePointer(target.pointer)
  if (isParcelPointer(pointer)) return pointer
  // Worlds: gatekeeper + stream-access always use 0,0 (not scene baseParcel).
  return '0,0'
}

/**
 * Realm name for gatekeeper `get-scene-adapter` / scene-stream-access.
 * Worlds must be **lowercase** so adapter joins match stream-key ingress rooms
 * (companion + `/scene-stream-access` always lowercases; about API may return mixed case e.g. RickRoll.dcl.eth).
 */
export function gatekeeperRealmNameForComms(target: GatekeeperCommsContext): string {
  const pointer = normalizePointer(target.pointer)
  if (isParcelPointer(pointer)) {
    const fromTarget = target.realmName?.trim()
    return fromTarget || 'main'
  }
  const fromTarget = target.realmName?.trim()
  const name = fromTarget || realmNameForCommsPointer(target.pointer)
  return name.toLowerCase()
}