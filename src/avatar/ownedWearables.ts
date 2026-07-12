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
 * @see Wearable + WearableIndividualDataItem in dcl-catalyst-client schemas
 */
export function expandOwnedWearableRows(raw: OwnedWearableApiRow[]): OwnedWearableEntry[] {
  const out: OwnedWearableEntry[] = []
  for (const row of raw) {
    const assetUrn = row.urn?.trim()
    const individuals = Array.isArray(row.individualData) ? row.individualData : []
    if (individuals.length) {
      for (const ind of individuals) {
        const full =
          ind.id?.trim() ||
          (assetUrn && ind.tokenId != null && String(ind.tokenId).length
            ? `${assetUrn}:${String(ind.tokenId)}`
            : '')
        if (full) out.push({ urn: full, amount: 1 })
      }
      continue
    }
    // No individual tokens listed — keep asset urn only if caller can handle it.
    if (assetUrn) out.push({ urn: assetUrn, amount: row.amount ?? 1 })
  }
  return out
}
