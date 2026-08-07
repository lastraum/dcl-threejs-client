/** Lambdas `wearables-by-owner` row — `urn` is often the asset; tokens live in individualData. */
export type OwnedWearableApiRow = {
  urn?: string
  amount?: number
  individualData?: Array<{ id?: string; tokenId?: string }>
}

export type OwnedWearableEntry = { urn: string; amount?: number }

/**
 * Expand wearables-by-owner rows into **item** URNs (with tokenId).
 * Catalyst profile deploys reject asset URNs and fake `:0` tokens the user does not own.
 *
 * Prefer `individualData.tokenId` (on-chain ERC-721 id) over `individualData.id`.
 * Catalyst sometimes suffixes the mint/issued # on `id` while `tokenId` holds the
 * packed Collection V2 id — marketplace transfers need the packed id.
 *
 * @see Wearable + WearableIndividualDataItem in dcl-catalyst-client schemas
 */
export function expandOwnedWearableRows(raw: OwnedWearableApiRow[]): OwnedWearableEntry[] {
  const out: OwnedWearableEntry[] = []
  for (const row of raw) {
    const assetUrn = row.urn?.trim()
    const individuals = Array.isArray(row.individualData) ? row.individualData : []
    if (individuals.length) {
      for (const ind of individuals) {
        const tokenPart =
          ind.tokenId != null && String(ind.tokenId).length > 0
            ? String(ind.tokenId).trim()
            : null
        // On-chain tokenId first — never trust id's trailing segment alone (often issuedId).
        let full = ''
        if (assetUrn && tokenPart && /^\d+$/.test(tokenPart)) {
          full = `${assetUrn}:${tokenPart}`
        } else if (ind.id?.trim()) {
          full = ind.id.trim()
        } else if (assetUrn && tokenPart) {
          full = `${assetUrn}:${tokenPart}`
        }
        if (full) out.push({ urn: full, amount: 1 })
      }
      continue
    }
    // No individual tokens listed — keep asset urn only if caller can handle it.
    if (assetUrn) out.push({ urn: assetUrn, amount: row.amount ?? 1 })
  }
  return out
}
