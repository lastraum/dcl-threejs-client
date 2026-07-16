import { normalizeUrn } from './constants'
import type { AvatarProfile, WearableDefinition } from './types'

/**
 * localStorage key for resolved peer avatar profile + wearable defs.
 * Prunes by age/count and shrinks on QuotaExceededError (see docs/ARCHITECTURE.md).
 */
const CACHE_KEY = 'dcl-client-avatar-cache'
/** Soft cap — enough for a busy world without blowing origin quota. */
const MAX_ENTRIES = 24
/** ~2.5MB JSON ceiling for the whole store (wearable defs are fat). */
const MAX_JSON_CHARS = 2_500_000

export type CachedAvatarBundle = {
  fingerprint: string
  profile: AvatarProfile
  wearables: WearableDefinition[]
  cachedAt: number
}

type CacheStore = Record<string, CachedAvatarBundle>

/** Stable key from equipped URNs + body colors — reused when profile unchanged. */
export function profileWearableFingerprint(profile: AvatarProfile): string {
  return JSON.stringify({
    bodyShape: profile.bodyShape,
    skin: profile.skin,
    hair: profile.hair,
    eyes: profile.eyes,
    wearables: profile.wearables.map(normalizeUrn).sort(),
    forceRender: [...profile.forceRender].map(normalizeUrn).sort()
  })
}

function isQuotaError(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'QuotaExceededError'
}

function sortedEntries(store: CacheStore): Array<[string, CachedAvatarBundle]> {
  return Object.entries(store).sort(
    (a, b) => (a[1].cachedAt ?? 0) - (b[1].cachedAt ?? 0)
  )
}

/** Drop oldest until under entry + JSON size caps. */
export function pruneAvatarCacheStore(
  store: CacheStore,
  opts?: { maxEntries?: number; maxJsonChars?: number }
): CacheStore {
  const maxEntries = opts?.maxEntries ?? MAX_ENTRIES
  const maxJsonChars = opts?.maxJsonChars ?? MAX_JSON_CHARS
  let entries = sortedEntries(store)
  while (entries.length > maxEntries) {
    entries.shift()
  }
  let result: CacheStore = Object.fromEntries(entries)
  while (entries.length > 1 && JSON.stringify(result).length > maxJsonChars) {
    entries.shift()
    result = Object.fromEntries(entries)
  }
  return result
}

function readStore(): CacheStore {
  if (typeof window === 'undefined') return {}
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as CacheStore
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function writeStore(store: CacheStore): void {
  if (typeof window === 'undefined') return
  let next = pruneAvatarCacheStore(store)
  const tryWrite = (s: CacheStore): boolean => {
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify(s))
      return true
    } catch (err) {
      if (!isQuotaError(err)) {
        console.warn('[avatar] failed to persist profile cache', err)
        return true // non-quota — stop retrying
      }
      return false
    }
  }

  if (tryWrite(next)) return

  // Aggressive half-prune
  next = pruneAvatarCacheStore(next, {
    maxEntries: Math.max(4, Math.floor(MAX_ENTRIES / 2)),
    maxJsonChars: Math.floor(MAX_JSON_CHARS / 2)
  })
  if (tryWrite(next)) {
    console.warn('[avatar] profile cache quota — pruned to', Object.keys(next).length, 'entries')
    return
  }

  // Keep only the newest single entry (the write we just attempted)
  const newest = sortedEntries(next).slice(-1)
  next = Object.fromEntries(newest)
  if (tryWrite(next)) {
    console.warn('[avatar] profile cache quota — kept newest entry only')
    return
  }

  // Nuclear: clear key and try one entry
  try {
    localStorage.removeItem(CACHE_KEY)
  } catch {
    /* ignore */
  }
  if (newest.length && tryWrite(Object.fromEntries(newest))) {
    console.warn('[avatar] profile cache quota — cleared store, rewrote newest')
    return
  }
  console.warn('[avatar] profile cache quota — giving up persist this frame')
}

export function readCachedAvatar(address: string, fingerprint: string): CachedAvatarBundle | null {
  const key = address.toLowerCase()
  const entry = readStore()[key]
  if (!entry || entry.fingerprint !== fingerprint) return null
  return entry
}

export function writeCachedAvatar(address: string, bundle: CachedAvatarBundle): void {
  const key = address.toLowerCase()
  const store = readStore()
  store[key] = { ...bundle, cachedAt: bundle.cachedAt || Date.now() }
  writeStore(store)
}

/** Test / debug helper — wipe the cache key. */
export function clearAvatarProfileCache(): void {
  if (typeof window === 'undefined') return
  try {
    localStorage.removeItem(CACHE_KEY)
  } catch {
    /* ignore */
  }
}
