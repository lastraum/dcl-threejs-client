import * as THREE from 'three'
import { AvatarAnimations, type AvatarLocomotionState } from './AvatarAnimations'
import { composeAvatarFromProfile } from './AvatarComposer'
import { disposeWearableInstance } from './loadWearable'
import { PEER_URL } from './constants'
import { applyAvatarPivotOffset } from './feetAlign'
import {
  defaultProfileIdentity,
  identityFromAvatarProfile,
  type ProfileIdentity
} from './displayName'
import { updateNameTagAnchor } from './headAnchor'
import { resolveProfileEmote, loadResolvedProfileEmote, isSceneEmoteUrn } from './profileEmotes'
import type { AssetCache } from '../rendering/AssetCache'
import type { AvatarProfile, BodyShape } from './types'

const warnedUnknownEmotes = new Set<string>()

/** Composed DCL avatar attached to a scene entity (NPC / AvatarShape). */
export class SceneAvatar {
  private readonly pivot = new THREE.Group()
  readonly nameTagAnchor = new THREE.Object3D()
  private model: THREE.Group | null = null
  private animations: AvatarAnimations | null = null
  private identity: ProfileIdentity = defaultProfileIdentity('NPC')
  private bodyShape: BodyShape = 'male'
  private assetCache: AssetCache | null = null
  private peerUrl = PEER_URL

  constructor(parent: THREE.Object3D) {
    this.pivot.name = 'avatar-shape-pivot'
    this.nameTagAnchor.name = 'name-tag-anchor'
    parent.add(this.pivot)
    parent.add(this.nameTagAnchor)
  }

  setAssetCache(cache: AssetCache | null, peerUrl?: string): void {
    this.assetCache = cache
    if (peerUrl) this.peerUrl = peerUrl
  }

  async load(profile: AvatarProfile, fallbackName = 'NPC'): Promise<ProfileIdentity> {
    this.disposeModel()
    this.model = await composeAvatarFromProfile(profile, this.peerUrl, this.assetCache)
    this.pivot.add(this.model)
    this.identity = identityFromAvatarProfile(profile, profile.address)
    this.bodyShape = profile.bodyShape
    if (fallbackName !== 'NPC' && !profile.fromWallet) {
      this.identity = { ...this.identity, displayName: fallbackName }
    }

    this.animations = new AvatarAnimations()
    try {
      await this.animations.bind(this.model, this.pivot, {
        bodyShape: this.bodyShape,
        peerUrl: this.peerUrl,
        assetCache: this.assetCache
      })
      applyAvatarPivotOffset(this.pivot, this.model)
    } catch (err) {
      console.warn('[AvatarShape] idle emote failed — bind pose only', err)
      this.animations.dispose()
      this.animations = null
    }

    updateNameTagAnchor(this.nameTagAnchor, this.model)
    return this.identity
  }

  async playEmote(emoteRef: string, loop?: boolean): Promise<boolean> {
    if (!this.model || !this.animations || !this.assetCache) return false

    const resolved = await resolveProfileEmote(emoteRef, this.bodyShape, this.peerUrl, { loop })
    if (!resolved) {
      if (!isSceneEmoteUrn(emoteRef) && !warnedUnknownEmotes.has(emoteRef)) {
        warnedUnknownEmotes.add(emoteRef)
        console.warn(`[AvatarShape] unknown emote: ${emoteRef}`)
      }
      return false
    }

    try {
      const cached = await loadResolvedProfileEmote(this.assetCache, resolved)
      if (!cached?.animations.length) return false
      const shouldLoop = loop ?? resolved.loop
      const emoteKey = resolved.urn.trim().toLowerCase()
      return this.animations.playProfileEmoteFromGltf(cached, shouldLoop, emoteKey)
    } catch (err) {
      console.warn(`[AvatarShape] emote failed (${emoteRef})`, err)
      return false
    }
  }

  stopEmote(): void {
    this.animations?.stopProfileEmote()
  }

  isProfileEmoteActive(): boolean {
    return this.animations?.isProfileEmoteActive() ?? false
  }

  getIdentity(): ProfileIdentity {
    return this.identity
  }

  setIdentity(identity: ProfileIdentity): void {
    this.identity = identity
  }

  update(delta: number): void {
    this.animations?.update(delta, {
      horizontalSpeed: 0,
      grounded: true,
      locomotionMode: 'jog',
      jumping: false,
      doubleJumping: false,
      falling: false
    } satisfies AvatarLocomotionState)
    updateNameTagAnchor(this.nameTagAnchor, this.model)
  }

  dispose(): void {
    this.disposeModel()
    this.nameTagAnchor.removeFromParent()
    this.pivot.removeFromParent()
  }

  private disposeModel(): void {
    this.animations?.dispose()
    this.animations = null
    if (!this.model) return
    disposeWearableInstance(this.model)
    this.pivot.remove(this.model)
    this.model = null
  }
}
