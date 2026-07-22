/**
 * Collection + creator metadata for backpack items.
 *
 * Catalyst wearable/emote metadata carries a `collectionAddress` but never the
 * collection's display name or its creator, so those come from the marketplace
 * API's collection directory (~5.6k rows, 6 paged requests, memoized per
 * session). Creator addresses resolve to profile names via the Catalyst
 * lambdas `/profiles` batch endpoint.
 */

const MARKETPLACE_API = 'https://marketplace-api.decentraland.org/v1'

const DIRECTORY_PAGE_SIZE = 1000
const DIRECTORY_MAX_PAGES = 20
const PROFILE_BATCH_SIZE = 60

export type CollectionDirectoryEntry = {
  name: string
  /** Creator wallet address (lowercase). */
  creator: string
}

type CollectionRow = {
  name?: string
  creator?: string
  contractAddress?: string
}

let directoryCache: Promise<Map<string, CollectionDirectoryEntry>> | null = null

/**
 * Full marketplace collection directory keyed by lowercase contract address.
 * Memoized per session; a failed fetch clears the memo so the next call retries.
 */
export function loadCollectionDirectory(): Promise<Map<string, CollectionDirectoryEntry>> {
  if (directoryCache) return directoryCache
  const promise = fetchCollectionDirectory().catch((err) => {
    if (directoryCache === promise) directoryCache = null
    throw err
  })
  directoryCache = promise
  return promise
}

async function fetchCollectionDirectory(): Promise<Map<string, CollectionDirectoryEntry>> {
  const out = new Map<string, CollectionDirectoryEntry>()
  for (let page = 0; page < DIRECTORY_MAX_PAGES; page++) {
    const res = await fetch(
      `${MARKETPLACE_API}/collections?first=${DIRECTORY_PAGE_SIZE}&skip=${page * DIRECTORY_PAGE_SIZE}`
    )
    if (!res.ok) throw new Error(`collection directory failed (${res.status})`)
    const raw = (await res.json()) as { data?: CollectionRow[]; total?: number }
    const rows = Array.isArray(raw.data) ? raw.data : []
    for (const row of rows) {
      const contract = row.contractAddress?.trim().toLowerCase()
      const name = row.name?.trim()
      if (!contract || !name) continue
      out.set(contract, { name, creator: row.creator?.trim().toLowerCase() ?? '' })
    }
    const total = typeof raw.total === 'number' ? raw.total : out.size
    if (rows.length < DIRECTORY_PAGE_SIZE || out.size >= total) break
  }
  return out
}

const creatorNameCache = new Map<string, string>()

type ProfileHit = {
  avatars?: Array<{ name?: string; ethAddress?: string; userId?: string }>
}

function shortAddress(address: string): string {
  return address.length > 12 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address
}

/**
 * Resolve creator wallet addresses to profile display names (batched POST to
 * lambdas `/profiles`). Addresses without a profile fall back to `0x1234…abcd`.
 */
export async function resolveCreatorNames(
  addresses: string[],
  lambdasUrl: string
): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const missing: string[] = []
  for (const raw of addresses) {
    const addr = raw.trim().toLowerCase()
    if (!addr) continue
    const cached = creatorNameCache.get(addr)
    if (cached) out.set(addr, cached)
    else missing.push(addr)
  }
  if (!missing.length) return out

  const base = lambdasUrl.replace(/\/$/, '')
  for (let i = 0; i < missing.length; i += PROFILE_BATCH_SIZE) {
    const batch = missing.slice(i, i + PROFILE_BATCH_SIZE)
    try {
      const res = await fetch(`${base}/profiles`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: batch })
      })
      if (!res.ok) continue
      const hits = (await res.json()) as ProfileHit[]
      if (!Array.isArray(hits)) continue
      for (const hit of hits) {
        const avatar = hit.avatars?.[0]
        const addr = (avatar?.ethAddress ?? avatar?.userId)?.trim().toLowerCase()
        const name = avatar?.name?.trim()
        if (addr && name) {
          creatorNameCache.set(addr, name)
          out.set(addr, name)
        }
      }
    } catch {
      /* leave batch unresolved — falls back to short addresses below */
    }
  }
  // Do not cache short-address fallbacks — a transient /profiles failure must not
  // freeze "0x1234…abcd" for the rest of the page session.
  for (const addr of missing) {
    if (out.has(addr)) continue
    out.set(addr, shortAddress(addr))
  }
  return out
}

/** "mvfw_2023-looks" → "Mvfw 2023 Looks" (slug display for v1/third-party/off-chain URNs). */
function humanizeSlug(slug: string): string {
  return slug
    .replace(/[-_]+/g, ' ')
    .trim()
    .replace(/\b[a-z]/g, (c) => c.toUpperCase())
}

type UrnCollectionRef =
  | { kind: 'v2'; contract: string }
  | { kind: 'named'; collectionName: string; creatorName?: string }
  | null

/**
 * Where a wearable/emote URN's collection info comes from:
 * - collections-v2 (matic/ethereum) → marketplace directory by contract
 * - off-chain (base-avatars / base-emotes / …) → Decentraland's free catalog
 * - collections-v1 → legacy Ethereum collection slug (creator unknown)
 * - collections-thirdparty → third-party name + collection slug
 */
export function collectionRefFromUrn(urn: string): UrnCollectionRef {
  const parts = urn.trim().toLowerCase().split(':')
  // urn:decentraland:{network}:collections-v2:0x{contract}:{item}
  const v2 = parts.indexOf('collections-v2')
  if (v2 >= 0 && parts[v2 + 1]?.startsWith('0x')) {
    return { kind: 'v2', contract: parts[v2 + 1]! }
  }
  const offChain = parts.indexOf('off-chain')
  if (offChain >= 0 && parts[offChain + 1]) {
    return {
      kind: 'named',
      collectionName: humanizeSlug(parts[offChain + 1]!),
      creatorName: 'Decentraland'
    }
  }
  const v1 = parts.indexOf('collections-v1')
  if (v1 >= 0 && parts[v1 + 1]) {
    return { kind: 'named', collectionName: humanizeSlug(parts[v1 + 1]!) }
  }
  // urn:decentraland:matic:collections-thirdparty:{thirdparty}:{collection}:{item}
  const tp = parts.indexOf('collections-thirdparty')
  if (tp >= 0 && parts[tp + 1]) {
    const collection = parts[tp + 2]
    return {
      kind: 'named',
      collectionName: humanizeSlug(collection || parts[tp + 1]!),
      creatorName: humanizeSlug(parts[tp + 1]!)
    }
  }
  return null
}

export type CollectionAnnotatable = {
  urn: string
  collectionName?: string
  creatorAddress?: string
  creatorName?: string
}

/**
 * Fill collectionName / creatorName on backpack items in place. Returns whether
 * anything changed (callers skip re-render when nothing resolved). Directory or
 * profile failures degrade per-item: v2 collections fall back to a short
 * contract address so grouping still works.
 */
export async function annotateItemsWithCollections(
  items: CollectionAnnotatable[],
  lambdasUrl: string
): Promise<boolean> {
  let changed = false
  const v2Items: Array<{ item: CollectionAnnotatable; contract: string }> = []

  for (const item of items) {
    const ref = collectionRefFromUrn(item.urn)
    if (!ref) continue
    if (ref.kind === 'v2') {
      v2Items.push({ item, contract: ref.contract })
      continue
    }
    if (item.collectionName !== ref.collectionName || item.creatorName !== ref.creatorName) {
      item.collectionName = ref.collectionName
      if (ref.creatorName) item.creatorName = ref.creatorName
      changed = true
    }
  }

  if (v2Items.length) {
    let directory: Map<string, CollectionDirectoryEntry> | null = null
    try {
      directory = await loadCollectionDirectory()
    } catch (err) {
      console.warn('[backpack] collection directory unavailable', err)
    }
    for (const { item, contract } of v2Items) {
      const entry = directory?.get(contract)
      const name = entry?.name ?? shortAddress(contract)
      if (item.collectionName !== name) {
        item.collectionName = name
        changed = true
      }
      if (entry?.creator && item.creatorAddress !== entry.creator) {
        item.creatorAddress = entry.creator
        changed = true
      }
    }

    const addresses = [
      ...new Set(v2Items.map(({ item }) => item.creatorAddress).filter((a): a is string => !!a))
    ]
    if (addresses.length) {
      const names = await resolveCreatorNames(addresses, lambdasUrl)
      for (const { item } of v2Items) {
        const name = item.creatorAddress ? names.get(item.creatorAddress) : undefined
        if (name && item.creatorName !== name) {
          item.creatorName = name
          changed = true
        }
      }
    }
  }

  return changed
}
