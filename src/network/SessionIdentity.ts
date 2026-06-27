import { getActiveProfileAddress } from '../avatar/LocalAvatar'
import { PEER_URL } from '../avatar/constants'
import { fetchCommsProfileEntityCached, fetchProfileCached, type CommsProfileEntity } from '../avatar/peerApi'
import type { AvatarProfile } from '../avatar/types'
import type { AuthIdentity } from '@dcl/crypto/dist/types'
import type { LoginResult } from '../auth/AuthClient'
import { persistProfileAddress } from '../auth/identityStore'

/** Local session wallet + Catalyst profile — foundation for multiplayer login. */
export class SessionIdentity {
  private address: string | undefined
  private profile: AvatarProfile | null = null
  private commsProfile: CommsProfileEntity | null = null
  private identity: AuthIdentity | null = null
  private contentUrl = PEER_URL
  private lambdasUrl = `${PEER_URL}/lambdas`

  constructor(contentUrl = PEER_URL, lambdasUrl?: string) {
    this.contentUrl = contentUrl.replace(/\/$/, '')
    this.lambdasUrl = (lambdasUrl ?? `${this.contentUrl}/lambdas`).replace(/\/$/, '')
    this.address = getActiveProfileAddress()
  }

  setCatalystEndpoints(contentUrl: string, lambdasUrl: string): void {
    this.contentUrl = contentUrl.replace(/\/$/, '')
    this.lambdasUrl = lambdasUrl.replace(/\/$/, '')
  }

  applyLogin(choice: LoginResult | null): void {
    if (!choice || choice.kind === 'guest') {
      this.address = undefined
      this.identity = null
      this.profile = null
      this.commsProfile = null
      return
    }
    this.address = choice.address.toLowerCase()
    this.identity = choice.identity
    persistProfileAddress(this.address)
  }

  /** Wallet from login; else optional ?profile= / localStorage preview (guest-only). */
  private resolveActiveAddress(): string | undefined {
    if (this.identity) {
      return this.address ?? getActiveProfileAddress()
    }
    return getActiveProfileAddress()
  }

  getAddress(): string | undefined {
    return this.address
  }

  getAuthIdentity(): AuthIdentity | null {
    return this.identity
  }

  getProfile(): AvatarProfile | null {
    return this.profile
  }

  getCommsProfileEntity(): CommsProfileEntity | null {
    return this.commsProfile
  }

  getLambdasUrl(): string {
    return this.lambdasUrl
  }

  /** Fetch Catalyst profile for the active wallet. */
  async connect(onProgress?: (msg: string) => void): Promise<AvatarProfile | null> {
    this.address = this.resolveActiveAddress()
    if (!this.address) {
      onProgress?.('Guest mode — default avatar')
      this.profile = null
      this.commsProfile = null
      return null
    }

    onProgress?.(`Connecting to Catalyst for ${this.address.slice(0, 8)}…`)
    const [profile, commsProfile] = await Promise.all([
      fetchProfileCached(this.address, this.lambdasUrl),
      fetchCommsProfileEntityCached(this.address, this.lambdasUrl, this.contentUrl)
    ])
    this.profile = profile
    this.commsProfile = commsProfile
    if (this.profile) {
      onProgress?.(`Profile loaded: ${this.profile.displayName ?? this.address.slice(0, 8)}`)
    } else {
      onProgress?.('Profile fetch failed — default avatar')
    }
    return this.profile
  }

  setAddress(address: string): void {
    this.address = address.toLowerCase()
    this.profile = null
    this.commsProfile = null
    this.identity = null
  }

  /** Update in-memory profile after local backpack equip/unequip (not persisted to Catalyst yet). */
  setProfile(profile: AvatarProfile): void {
    this.profile = profile
  }
}
