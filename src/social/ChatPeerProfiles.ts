import { identityFromAvatarProfile, shortenAddress } from '../avatar/displayName'
import { catalystContentUrlForWearables } from '../avatar/catalystEndpoints'
import {
  fetchProfileFaceUrl,
  getCommsPeerProfile,
  profileFromSerializedEntry,
  fetchProfileCached
} from '../avatar/peerApi'
import type { AvatarProfile } from '../avatar/types'

export type PeerChatProfile = {
  displayName: string
  nameColor: string
  faceUrl: string | null
}

export type PeerDisplaySeed = {
  displayName?: string | null
  faceUrl?: string | null
  nameColor?: string | null
}

type ProfileListener = (changedAddresses: ReadonlySet<string> | null) => void

/**
 * Session-scoped display cache (survives scene teardown / SocialService re-init).
 * Keyed by lowercased wallet address.
 */
const sessionByAddress = new Map<string, PeerChatProfile>()
const sessionInFlight = new Map<string, Promise<void>>()

/** Drop one address or the whole session (logout). */
export function clearSessionPeerDisplayCache(address?: string): void {
  if (!address) {
    sessionByAddress.clear()
    sessionInFlight.clear()
    return
  }
  const key = address.toLowerCase()
  sessionByAddress.delete(key)
  sessionInFlight.delete(key)
}

function isPlaceholderName(name: string, address: string): boolean {
  const short = shortenAddress(address)
  return !name || name === short || name === `${address.slice(0, 6)}…${address.slice(-4)}`
}

/**
 * In-memory display names + face snapshots for peers (chat, friends, mentions).
 * Backed by a process-wide session map so opening Friends does not re-fetch 200 profiles.
 */
export class ChatPeerProfiles {
  private peerUrl = 'https://peer.decentraland.org'
  private readonly listeners = new Set<ProfileListener>()
  private notifyTimer: ReturnType<typeof setTimeout> | null = null
  private pendingNotify = new Set<string>()
  private notifyAll = false

  setPeerUrl(url: string): void {
    this.peerUrl = catalystContentUrlForWearables(url)
  }

  setLocal(address: string, displayName: string, faceUrl: string | null, nameColor = '#b8ff66'): void {
    const key = address.toLowerCase()
    sessionByAddress.set(key, { displayName, nameColor, faceUrl })
    this.queueNotify(key)
  }

  rememberSerialized(address: string, serializedProfile: string): void {
    const profile = profileFromSerializedEntry(serializedProfile, address)
    if (profile) this.applyAvatarProfile(address, profile)
  }

  /**
   * Seed from social-rpc FriendProfile / any known display data without network.
   * No-op when existing cache is already as complete or better.
   */
  seed(address: string, seed: PeerDisplaySeed): boolean {
    const key = address.toLowerCase().trim()
    if (!/^0x[a-f0-9]{40}$/.test(key)) return false
    const existing = sessionByAddress.get(key)
    const nextName =
      (seed.displayName?.trim() && seed.displayName.trim()) ||
      existing?.displayName ||
      shortenAddress(key)
    const nextFace = seed.faceUrl?.trim() || existing?.faceUrl || null
    const nextColor = seed.nameColor?.trim() || existing?.nameColor || '#ff6ad5'

    if (
      existing &&
      existing.displayName === nextName &&
      existing.faceUrl === nextFace &&
      existing.nameColor === nextColor
    ) {
      return false
    }
    // Prefer richer existing name over placeholder seed.
    const displayName =
      existing && !isPlaceholderName(existing.displayName, key) && isPlaceholderName(nextName, key)
        ? existing.displayName
        : nextName
    const faceUrl = nextFace || existing?.faceUrl || null
    sessionByAddress.set(key, {
      displayName,
      nameColor: nextColor,
      faceUrl
    })
    this.queueNotify(key)
    return true
  }

  /**
   * Ensure we have display data. Uses session cache + in-flight dedupe.
   * Fast path for friends list: no RFC4 wait (offline friends never broadcast).
   */
  async ensurePeer(address: string, opts?: { fast?: boolean }): Promise<void> {
    const key = address.toLowerCase()
    if (!/^0x[a-f0-9]{40}$/.test(key)) return

    const hit = sessionByAddress.get(key)
    // Complete enough — skip network.
    if (hit && hit.faceUrl && !isPlaceholderName(hit.displayName, key)) return

    const inflight = sessionInFlight.get(key)
    if (inflight) return inflight

    const work = this.loadPeer(key, opts?.fast !== false).finally(() => {
      sessionInFlight.delete(key)
    })
    sessionInFlight.set(key, work)
    return work
  }

  get(address: string | undefined): PeerChatProfile | null {
    if (!address) return null
    return sessionByAddress.get(address.toLowerCase()) ?? null
  }

  /** True if session cache already has a usable row. */
  has(address: string): boolean {
    return sessionByAddress.has(address.toLowerCase())
  }

  onUpdate(listener: ProfileListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /**
   * Drop listeners only — keep session cache for the client session.
   * Use clearSessionPeerDisplayCache() on logout.
   */
  clear(): void {
    this.listeners.clear()
    if (this.notifyTimer) {
      clearTimeout(this.notifyTimer)
      this.notifyTimer = null
    }
    this.pendingNotify.clear()
    this.notifyAll = false
  }

  private async loadPeer(key: string, fast: boolean): Promise<void> {
    const commsProfile = getCommsPeerProfile(key)
    if (commsProfile) {
      this.applyAvatarProfile(key, commsProfile)
      return
    }

    // Fast: lambda/profile cache only (friends list). Slow path not used for bulk ensure.
    if (fast) {
      const profile = await fetchProfileCached(key, this.peerUrl)
      if (profile) {
        this.applyAvatarProfile(key, profile)
        return
      }
      const faceUrl = await fetchProfileFaceUrl(key, this.peerUrl)
      const existing = sessionByAddress.get(key)
      if (existing?.faceUrl === faceUrl && existing.displayName) {
        return
      }
      sessionByAddress.set(key, {
        displayName: existing?.displayName ?? shortenAddress(key),
        nameColor: existing?.nameColor ?? '#ff6ad5',
        faceUrl: faceUrl ?? existing?.faceUrl ?? null
      })
      this.queueNotify(key)
      return
    }

    // Non-fast: still avoid long RFC4 wait — use cached profile fetch.
    const profile = await fetchProfileCached(key, this.peerUrl)
    if (profile) {
      this.applyAvatarProfile(key, profile)
      return
    }
    const faceUrl = await fetchProfileFaceUrl(key, this.peerUrl)
    sessionByAddress.set(key, {
      displayName: shortenAddress(key),
      nameColor: '#ff6ad5',
      faceUrl
    })
    this.queueNotify(key)
  }

  private applyAvatarProfile(address: string, profile: AvatarProfile): void {
    const key = address.toLowerCase()
    const identity = identityFromAvatarProfile(profile, key)
    const existing = sessionByAddress.get(key)
    sessionByAddress.set(key, {
      displayName: identity.displayName,
      nameColor: identity.nameColor,
      faceUrl: existing?.faceUrl ?? null
    })
    this.queueNotify(key)
    // Face snapshot is separate; only notify again if it actually changes.
    void fetchProfileFaceUrl(key, this.peerUrl).then((faceUrl) => {
      if (!faceUrl) return
      const current = sessionByAddress.get(key)
      if (!current || current.faceUrl === faceUrl) return
      sessionByAddress.set(key, { ...current, faceUrl })
      this.queueNotify(key)
    })
  }

  private queueNotify(address: string | null): void {
    if (address) this.pendingNotify.add(address.toLowerCase())
    else this.notifyAll = true
    if (this.notifyTimer != null) return
    // Coalesce hundreds of face arrivals into one UI tick.
    this.notifyTimer = setTimeout(() => {
      this.notifyTimer = null
      const all = this.notifyAll
      const changed = all ? null : new Set(this.pendingNotify)
      this.pendingNotify.clear()
      this.notifyAll = false
      for (const listener of this.listeners) listener(changed)
    }, 120)
  }
}
