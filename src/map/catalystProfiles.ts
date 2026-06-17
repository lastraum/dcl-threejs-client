import { catalystProfilesEndpoint } from './mapConfig'
import type { PlayerProfile } from './types'
import { normalizeWallet } from './peerParcel'

const BATCH_SIZE = 50
const FALLBACK: PlayerProfile = { displayName: '?', faceUrl: null }

function deployedAvatar(profileBody: unknown, wallet: string): Record<string, unknown> | null {
  const profiles = Array.isArray(profileBody) ? profileBody : profileBody ? [profileBody] : []
  const profile = profiles[0] as { avatars?: unknown[] } | undefined
  const avatars = profile?.avatars
  if (!Array.isArray(avatars) || avatars.length === 0) return null

  const address = normalizeWallet(wallet)
  const entry =
    avatars.find((row) => {
      const r = row as { userId?: string; ethAddress?: string }
      return normalizeWallet(String(r?.userId ?? r?.ethAddress ?? '')) === address
    }) ?? avatars[0]

  return entry as Record<string, unknown>
}

export function resolveFaceSnapshotUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw.trim()) return null
  const v = raw.trim()
  if (v.startsWith('http://') || v.startsWith('https://')) return v
  return `https://profile-images.decentraland.org/entities/${v}/face.png`
}

export function profileFromBody(data: unknown, wallet: string): PlayerProfile {
  const deployed = deployedAvatar(data, wallet)
  const avatar = deployed?.avatar as { snapshots?: { face256?: unknown }; name?: unknown } | undefined
  const rawName = deployed?.name ?? avatar?.name
  const name =
    typeof rawName === 'string' && rawName.trim()
      ? rawName.trim()
      : `${normalizeWallet(wallet).slice(0, 6)}…`

  return {
    displayName: name,
    faceUrl: resolveFaceSnapshotUrl(avatar?.snapshots?.face256)
  }
}

export async function fetchCatalystProfiles(wallets: string[]): Promise<Map<string, PlayerProfile>> {
  const result = new Map<string, PlayerProfile>()
  const unique = [...new Set(wallets.map(normalizeWallet).filter(Boolean))]
  if (!unique.length) return result

  const base = catalystProfilesEndpoint()

  for (let i = 0; i < unique.length; i += BATCH_SIZE) {
    const batch = unique.slice(i, i + BATCH_SIZE)
    try {
      if (batch.length === 1) {
        const wallet = batch[0]
        const res = await fetch(`${base}/${encodeURIComponent(wallet)}`, {
          headers: { Accept: 'application/json' }
        })
        if (!res.ok) {
          result.set(wallet, profileFromBody(null, wallet))
          continue
        }
        const data = await res.json()
        result.set(wallet, profileFromBody(data, wallet))
        continue
      }

      const res = await fetch(base, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ ids: batch })
      })
      if (!res.ok) throw new Error(`profiles ${res.status}`)
      const data = await res.json()
      const profiles = Array.isArray(data) ? data : []
      for (let j = 0; j < batch.length; j++) {
        const wallet = batch[j]
        result.set(wallet, profileFromBody(profiles[j], wallet))
      }
    } catch {
      for (const wallet of batch) {
        result.set(wallet, profileFromBody(null, wallet))
      }
    }
  }

  return result
}

export function getCachedProfile(
  cache: Map<string, PlayerProfile>,
  wallet: string
): PlayerProfile {
  return cache.get(normalizeWallet(wallet)) ?? FALLBACK
}
