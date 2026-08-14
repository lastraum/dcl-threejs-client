/** EIP-191 message for Pet Barn update/delete (must match Worker + deploy Action). */
export function petBarnActionMessage(
  action: 'update' | 'delete',
  targetId: string,
  glbSha256: string | null | undefined,
  timestampMs: number
): string {
  const sha = (glbSha256 && String(glbSha256).trim().toLowerCase()) || 'none'
  return `petbarn:v1:${action}:${targetId}:${sha}:${timestampMs}`
}

/** Hex SHA-256 of file bytes (lowercase, no 0x) — binds update signatures to the GLB. */
export async function sha256HexOfBlob(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer()
  const digest = await crypto.subtle.digest('SHA-256', buf)
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

export function isPetBarnListingOwner(
  listingWallet: string | undefined,
  sessionAddress: string | undefined
): boolean {
  const owner = listingWallet?.trim().toLowerCase()
  const me = sessionAddress?.trim().toLowerCase()
  if (!owner || !me) return false
  if (!owner.startsWith('0x') || owner.length < 10) return false
  return owner === me
}
