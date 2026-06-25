/**
 * In-memory VRM bytes received from peers — never written to IndexedDB.
 */
const ramByHash = new Map<string, ArrayBuffer>()

function key(hash: string): string {
  return hash.toLowerCase()
}

export function getVrmRamBytes(contentHash: string): ArrayBuffer | null {
  return ramByHash.get(key(contentHash)) ?? null
}

export function putVrmRamBytes(contentHash: string, bytes: ArrayBuffer): void {
  ramByHash.set(key(contentHash), bytes)
}

export function hasVrmRamBytes(contentHash: string): boolean {
  return ramByHash.has(key(contentHash))
}

export function deleteVrmRamBytes(contentHash: string): void {
  ramByHash.delete(key(contentHash))
}

export function clearVrmRamCache(): void {
  ramByHash.clear()
}