import { getActiveProfileAddress } from '../avatar/LocalAvatar'
import { PEER_URL } from '../avatar/constants'
import { applyExtendedColorsToSerializedProfile } from '../avatar/extendedColors'
import {
  avatarEntryToCommsEntity,
  fetchCommsProfileEntityCached,
  fetchProfileCached,
  type CommsProfileEntity,
  type LambdaAvatarEntry
} from '../avatar/peerApi'
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
  /** Guest login uses a browser-only key; Polygon loot bag meta-tx still needs MetaMask. */
  private guest = false
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
    if (!choice) {
      this.address = undefined
      this.identity = null
      this.guest = false
      this.profile = null
      this.commsProfile = null
      return
    }
    // Wallet or stable guest both carry address + AuthIdentity for LiveKit / Catalyst.
    this.address = choice.address.toLowerCase()
    this.identity = choice.identity
    this.guest = choice.kind === 'guest'
    persistProfileAddress(this.address)
    this.profile = null
    this.commsProfile = null
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

  /** True when logged in as browser guest (not MetaMask). */
  isGuest(): boolean {
    return this.guest
  }

  getAuthIdentity(): AuthIdentity | null {
    return this.identity
  }

  getProfile(): AvatarProfile | null {
    return this.profile
  }

  getCommsProfileEntity(): CommsProfileEntity | null {
    if (!this.commsProfile) return null
    // Inject D3JS extension keys (brows / facial hair colors) at read time so every
    // announce carries the current localStorage values without a Catalyst deploy.
    return {
      ...this.commsProfile,
      serializedProfile: applyExtendedColorsToSerializedProfile(
        this.commsProfile.serializedProfile,
        this.address
      )
    }
  }

  /** Rebuild the comms profile from a just-deployed entry (version already bumped) so
   *  peers hear the new version instead of the stale connect-time snapshot. */
  applyDeployedProfileEntry(entry: LambdaAvatarEntry): void {
    this.commsProfile = avatarEntryToCommsEntity(entry, this.contentUrl)
  }

  getLambdasUrl(): string {
    return this.lambdasUrl
  }

  getContentUrl(): string {
    return this.contentUrl
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
