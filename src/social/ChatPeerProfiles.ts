import { identityFromAvatarProfile } from '../avatar/displayName'
import {
  fetchProfileFaceUrl,
  getCommsPeerProfile,
  profileFromSerializedEntry,
  resolveRemotePeerProfile
} from '../avatar/peerApi'
import type { AvatarProfile } from '../avatar/types'

export type PeerChatProfile = {
  displayName: string
  nameColor: string
  faceUrl: string | null
}

/** In-memory display names + face snapshots for connected peers. */
export class ChatPeerProfiles {
  private peerUrl = 'https://peer.decentraland.org'
  private readonly byAddress = new Map<string, PeerChatProfile>()
  private readonly listeners = new Set<() => void>()

  setPeerUrl(url: string): void {
    this.peerUrl = url.replace(/\/$/, '')
  }

  setLocal(address: string, displayName: string, faceUrl: string | null, nameColor = '#b8ff66'): void {
    this.byAddress.set(address.toLowerCase(), { displayName, nameColor, faceUrl })
    this.notify()
  }

  rememberSerialized(address: string, serializedProfile: string): void {
    const profile = profileFromSerializedEntry(serializedProfile, address)
    if (profile) this.applyAvatarProfile(address, profile)
  }

  async ensurePeer(address: string): Promise<void> {
    const key = address.toLowerCase()
    if (this.byAddress.has(key)) return

    const commsProfile = getCommsPeerProfile(key)
    if (commsProfile) {
      this.applyAvatarProfile(key, commsProfile)
      return
    }

    const profile = await resolveRemotePeerProfile(key, this.peerUrl)
    if (profile) {
      this.applyAvatarProfile(key, profile)
      return
    }
    const faceUrl = await fetchProfileFaceUrl(key, this.peerUrl)
    this.byAddress.set(key, {
      displayName: `${key.slice(0, 6)}…${key.slice(-4)}`,
      nameColor: '#ff6ad5',
      faceUrl
    })
    this.notify()
  }

  get(address: string | undefined): PeerChatProfile | null {
    if (!address) return null
    return this.byAddress.get(address.toLowerCase()) ?? null
  }

  onUpdate(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  clear(): void {
    this.byAddress.clear()
    this.listeners.clear()
  }

  private applyAvatarProfile(address: string, profile: AvatarProfile): void {
    const key = address.toLowerCase()
    const identity = identityFromAvatarProfile(profile, key)
    const existing = this.byAddress.get(key)
    this.byAddress.set(key, {
      displayName: identity.displayName,
      nameColor: identity.nameColor,
      faceUrl: existing?.faceUrl ?? null
    })
    this.notify()
    void fetchProfileFaceUrl(key, this.peerUrl).then((faceUrl) => {
      if (!faceUrl) return
      const current = this.byAddress.get(key)
      if (!current) return
      this.byAddress.set(key, { ...current, faceUrl })
      this.notify()
    })
  }

  private notify(): void {
    for (const listener of this.listeners) listener()
  }
}
