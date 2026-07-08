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
  return normalizePointer(target.baseParcel)
}

export function gatekeeperRealmNameForComms(target: GatekeeperCommsContext): string {
  const fromTarget = target.realmName?.trim()
  if (fromTarget) return fromTarget
  return realmNameForCommsPointer(target.pointer)
}