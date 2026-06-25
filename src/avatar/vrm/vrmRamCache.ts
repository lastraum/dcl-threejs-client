import type { CustomAvatarFormat } from './constants'

/**
 * In-memory custom avatar bytes received from peers — never written to IndexedDB.
 */
const ramByHash = new Map<string, ArrayBuffer>()
const formatByHash = new Map<string, CustomAvatarFormat>()

function key(hash: string): string {
  return hash.toLowerCase()
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

export function clearVrmRamCache(): void {
  ramByHash.clear()
  formatByHash.clear()
}