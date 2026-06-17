import { normalizeUrn } from './constants'
import type { AvatarProfile, WearableDefinition } from './types'

const CACHE_KEY = 'dcl-client-avatar-cache'

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
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(store))
  } catch (err) {
    console.warn('[avatar] failed to persist profile cache', err)
  }
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
  store[key] = bundle
  writeStore(store)
}
