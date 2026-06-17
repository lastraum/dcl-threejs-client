import * as THREE from 'three'
import { AvatarAnimations, type AvatarLocomotionState } from './AvatarAnimations'
import { composeAvatarFromProfile } from './AvatarComposer'
import { disposeWearableInstance } from './loadWearable'
import { AVATAR_YAW_OFFSET, PEER_URL, PROFILE_STORAGE_KEY } from './constants'
import { applyAvatarPivotOffset } from './feetAlign'
import {
  avatarShapeDisplayName,
  defaultProfileIdentity,
  identityFromAvatarProfile,
  type ProfileIdentity
} from './displayName'
import { updateNameTagAnchor } from './headAnchor'
import { resolveAvatarProfile } from './peerApi'
import { resolveProfileEmote, loadResolvedProfileEmote, isSceneEmoteUrn, type ResolvedProfileEmote } from './profileEmotes'
import type { AssetCache } from '../rendering/AssetCache'
import type { ComposeOptions } from './AvatarComposer'
import type { BodyShape } from './types'

export type PlayEmoteOptions = {
  loop?: boolean
  peerUrl?: string
}

/** Local player avatar mesh — child of PlayerSystem root, follows capsule + yaw. */
export class LocalAvatar {
  private readonly pivot = new THREE.Group()
  readonly nameTagAnchor = new THREE.Object3D()
  private model: THREE.Group | null = null
  private animations: AvatarAnimations | null = null
  private identity: ProfileIdentity = defaultProfileIdentity()
  private bodyShape: BodyShape = 'male'
  private assetCache: AssetCache | null = null
  private peerUrl = PEER_URL
  private vfxScene: THREE.Scene | null = null
  private activeEmoteUrn: string | null = null
  private emotePlaySeq = 0

  constructor(parent: THREE.Object3D) {
    this.pivot.name = 'avatar-pivot'
    this.nameTagAnchor.name = 'name-tag-anchor'
    parent.add(this.pivot)
    parent.add(this.nameTagAnchor)
  }

  setAssetCache(cache: AssetCache | null, peerUrl?: string): void {
    this.assetCache = cache
    if (peerUrl) this.peerUrl = peerUrl
  }

  async load(options: ComposeOptions = {}): Promise<ProfileIdentity> {
    this.disposeModel()
    const profile = await resolveAvatarProfile(options.profileId, options.bodyShape)
    this.model = await composeAvatarFromProfile(profile, this.peerUrl, this.assetCache)
    this.pivot.add(this.model)
    this.identity = identityFromAvatarProfile(profile, options.profileId)
    this.bodyShape = profile.bodyShape

    this.animations = new AvatarAnimations()
    try {
      await this.animations.bind(this.model, this.pivot, {
        bodyShape: profile.bodyShape,
        peerUrl: this.peerUrl,
        assetCache: this.assetCache
      })
      if (this.vfxScene) {
        this.animations.setVfxScene(this.vfxScene)
      }
      applyAvatarPivotOffset(this.pivot, this.model)
    } catch (err) {
      console.warn('[avatar] idle emote failed — avatar stays in bind pose', err)
      this.animations.dispose()
      this.animations = null
    }

    updateNameTagAnchor(this.nameTagAnchor, this.model)
    return this.identity
  }

  getIdentity(): ProfileIdentity {
    return this.identity
  }

  setIdentity(identity: ProfileIdentity): void {
    this.identity = identity
  }

  setYaw(yaw: number): void {
    this.pivot.rotation.y = yaw + AVATAR_YAW_OFFSET
  }

  setBodyVisible(visible: boolean): void {
    if (this.model) this.model.visible = visible
  }

  async playEmote(emoteId: string, options: PlayEmoteOptions = {}): Promise<ResolvedProfileEmote | null> {
    if (!this.model || !this.animations) return null

    const normalizedId = emoteId.trim().toLowerCase()
    if (this.animations.isProfileEmoteActive() && this.activeEmoteUrn === normalizedId) {
      return null
    }

    const seq = ++this.emotePlaySeq
    const resolved = await resolveProfileEmote(
      emoteId,
      this.bodyShape,
      options.peerUrl ?? this.peerUrl
    )
    if (seq !== this.emotePlaySeq) return null
    if (!resolved) {
      if (!isSceneEmoteUrn(emoteId)) {
        console.warn(`[avatar] unknown emote: ${emoteId}`)
      }
      return null
    }

    try {
      const cached = this.assetCache
        ? await loadResolvedProfileEmote(this.assetCache, resolved)
        : null
      if (seq !== this.emotePlaySeq) return null
      if (!cached?.animations.length) {
        console.warn(`[avatar] emote has no animation clip: ${resolved.url}`)
        return null
      }

      const loop = options.loop ?? resolved.loop
      const emoteKey = resolved.urn.trim().toLowerCase()
      if (this.animations.playProfileEmoteFromGltf(cached, loop, emoteKey)) {
        this.activeEmoteUrn = emoteKey
        return resolved
      }
      return null
    } catch (err) {
      if (seq !== this.emotePlaySeq) return null
      console.warn(`[avatar] emote load failed (${emoteId})`, err)
      return null
    }
  }

  stopEmote(): void {
    this.emotePlaySeq++
    this.activeEmoteUrn = null
    this.animations?.stopProfileEmote()
  }

  isProfileEmoteActive(): boolean {
    return this.animations?.isProfileEmoteActive() ?? false
  }

  update(delta: number, state: AvatarLocomotionState): void {
    this.animations?.update(delta, state)
    updateNameTagAnchor(this.nameTagAnchor, this.model)
  }

  setLocomotionVfxScene(scene: THREE.Scene | null): void {
    this.vfxScene = scene
    this.animations?.setVfxScene(scene)
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

function normalizeProfileAddress(value: string): string | undefined {
  const trimmed = value.trim()
  if (!trimmed || trimmed === 'default') return undefined
  const address = trimmed.toLowerCase()
  return /^0x[a-f0-9]{40}$/.test(address) ? address : undefined
}

function readStoredProfile(): string | undefined {
  if (typeof window === 'undefined') return undefined
  const params = new URLSearchParams(window.location.search)
  const fromUrl = params.get('profile')
  const normalized = fromUrl ? normalizeProfileAddress(fromUrl) : undefined
  if (normalized) {
    localStorage.setItem(PROFILE_STORAGE_KEY, normalized)
    return normalized
  }
  const stored = localStorage.getItem(PROFILE_STORAGE_KEY)
  return stored ? normalizeProfileAddress(stored) : undefined
}

/** Active wallet from `?profile=` or localStorage — used by sidebar + local avatar. */
export function getActiveProfileAddress(): string | undefined {
  return readStoredProfile()
}

export function avatarOptionsFromUrl(): ComposeOptions {
  const profileId = readStoredProfile()
  const shape = new URLSearchParams(typeof window !== 'undefined' ? window.location.search : '').get('body')
  return {
    profileId: profileId || undefined,
    bodyShape: shape === 'female' ? 'female' : shape === 'male' ? 'male' : undefined
  }
}

export function mirrorAvatarNameOverride(mirrorName?: string | null): string | undefined {
  const label = avatarShapeDisplayName(mirrorName)
  return label === 'NPC' ? undefined : label
}
