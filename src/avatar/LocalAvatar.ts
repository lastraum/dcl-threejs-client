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
import { VrmAvatar } from './vrm/VrmAvatar'
import { VrmLocomotionAnimations } from './vrm/VrmLocomotionAnimations'
import { retargetGltfClipToVrm } from './vrm/mixamoRetarget'
import { applyVrmPivotOffset } from './vrm/vrmFeetAlign'
import { getEquippedCustomAvatar } from './vrm/vrmEquipStorage'
import { getVrmLibraryEntry, loadVrmLibraryBytes } from './vrm/VrmLibrary'
import { OdkAvatar } from './odk/OdkAvatar'
import { OdkLocomotionAnimations } from './odk/OdkLocomotionAnimations'
import { applyOdkRestCorrection, retargetGltfClipToOdk } from './odk/odkRetarget'
import { applyOdkPivotOffset } from './odk/odkFeetAlign'
import type { CustomAvatarFormat } from './vrm/constants'

export type PlayEmoteOptions = {
  loop?: boolean
  peerUrl?: string
}

/** Local player avatar mesh — child of PlayerSystem root, follows capsule + yaw. */
export class LocalAvatar {
  private readonly pivot = new THREE.Group()
  readonly nameTagAnchor = new THREE.Object3D()
  private model: THREE.Object3D | null = null
  private vrmAvatar: VrmAvatar | null = null
  private vrmLocomotion: VrmLocomotionAnimations | null = null
  private odkAvatar: OdkAvatar | null = null
  private odkLocomotion: OdkLocomotionAnimations | null = null
  private renderMode: 'dcl' | 'vrm' | 'odk' = 'dcl'
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
    this.identity = identityFromAvatarProfile(profile, options.profileId)
    this.bodyShape = profile.bodyShape

    const profileAddress = options.profileId ?? profile.address ?? getActiveProfileAddress()
    const equipped = getEquippedCustomAvatar(profileAddress)
    if (equipped) {
      const bytes = await loadVrmLibraryBytes(equipped.contentHash)
      if (bytes) {
        const entry = await getVrmLibraryEntry(equipped.contentHash)
        const format: CustomAvatarFormat = entry?.format ?? equipped.format
        try {
          if (format === 'odk') {
            this.odkAvatar = await OdkAvatar.fromBytes(bytes, entry?.mmlAttachments)
            this.renderMode = 'odk'
            this.model = this.odkAvatar.root
            this.pivot.add(this.model)
            applyOdkPivotOffset(this.pivot, this.model)

            const odkBindPoseOnly =
              typeof window !== 'undefined' &&
              new URLSearchParams(window.location.search).has('odkBindPose')
            if (odkBindPoseOnly) {
              console.info('[avatar] custom ODK/MML equipped — bind pose only (?odkBindPose)')
            } else {
              this.odkLocomotion = new OdkLocomotionAnimations()
              try {
                await this.odkLocomotion.bind(this.odkAvatar.root)
                console.info('[avatar] custom ODK/MML avatar equipped — locomotion active')
              } catch (err) {
                console.warn('[avatar] ODK locomotion bind failed — bind pose only', err)
                this.odkLocomotion.dispose()
                this.odkLocomotion = null
              }
            }
          } else {
            this.vrmAvatar = await VrmAvatar.fromBytes(bytes)
            this.renderMode = 'vrm'
            this.model = this.vrmAvatar.root
            this.pivot.add(this.model)
            this.vrmAvatar.vrm.humanoid.autoUpdateHumanBones = false

            this.vrmLocomotion = new VrmLocomotionAnimations()
            try {
              await this.vrmLocomotion.bind(this.vrmAvatar.vrm, this.vrmAvatar.root)
              applyVrmPivotOffset(this.pivot, this.vrmAvatar.vrm, this.model, {
                measureActivePose: true
              })
              console.info('[avatar] custom VRM equipped — locomotion active')
            } catch (err) {
              console.warn('[avatar] VRM locomotion bind failed — bind pose only', err)
              this.vrmLocomotion.dispose()
              this.vrmLocomotion = null
              applyVrmPivotOffset(this.pivot, this.vrmAvatar.vrm, this.model)
            }
          }

          updateNameTagAnchor(this.nameTagAnchor, this.model)
          return this.identity
        } catch (err) {
          console.warn('[avatar] custom avatar load failed — falling back to DCL compose', err)
          this.vrmAvatar?.dispose()
          this.vrmAvatar = null
          this.odkAvatar?.dispose()
          this.odkAvatar = null
        }
      }
    }

    this.renderMode = 'dcl'
    this.model = await composeAvatarFromProfile(profile, this.peerUrl, this.assetCache)
    this.pivot.add(this.model)

    this.animations = new AvatarAnimations()
    try {
      await this.animations.bind(this.model as THREE.Group, this.pivot, {
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

  getModel(): THREE.Object3D | null {
    return this.model
  }

  isVrmMode(): boolean {
    return this.renderMode === 'vrm'
  }

  isCustomAvatarMode(): boolean {
    return this.renderMode === 'vrm' || this.renderMode === 'odk'
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
    if (!this.model) return null

    const normalizedId = emoteId.trim().toLowerCase()
    if (this.isProfileEmoteActive() && this.activeEmoteUrn === normalizedId) {
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

      if (this.renderMode === 'vrm' && this.vrmAvatar && this.vrmLocomotion) {
        const clip = retargetGltfClipToVrm(cached.animations[0]!, cached.root, this.vrmAvatar.vrm)
        if (clip.tracks.length === 0) {
          console.warn(`[avatar] VRM emote retarget produced no tracks: ${resolved.url}`)
          return null
        }
        if (this.vrmLocomotion.playProfileEmote(clip, loop)) {
          this.activeEmoteUrn = emoteKey
          return resolved
        }
        return null
      }

      if (this.renderMode === 'odk' && this.odkAvatar && this.odkLocomotion) {
        const clip = retargetGltfClipToOdk(cached.animations[0]!, cached.root, this.odkAvatar.root)
        const restCorrection = this.odkLocomotion.getRestCorrection()
        if (restCorrection) applyOdkRestCorrection(clip, restCorrection)
        if (clip.tracks.length === 0) {
          console.warn(`[avatar] ODK emote retarget produced no tracks: ${resolved.url}`)
          return null
        }
        if (this.odkLocomotion.playProfileEmote(clip, loop)) {
          this.activeEmoteUrn = emoteKey
          return resolved
        }
        return null
      }

      if (!this.animations) return null
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
    if (this.renderMode === 'vrm') {
      this.vrmLocomotion?.stopProfileEmote()
    } else if (this.renderMode === 'odk') {
      this.odkLocomotion?.stopProfileEmote()
    } else {
      this.animations?.stopProfileEmote()
    }
  }

  isProfileEmoteActive(): boolean {
    if (this.renderMode === 'vrm') {
      return this.vrmLocomotion?.isProfileEmoteActive() ?? false
    }
    if (this.renderMode === 'odk') {
      return this.odkLocomotion?.isProfileEmoteActive() ?? false
    }
    return this.animations?.isProfileEmoteActive() ?? false
  }

  update(delta: number, state: AvatarLocomotionState): void {
    if (this.renderMode === 'vrm') {
      this.vrmLocomotion?.update(delta, state)
      this.vrmAvatar?.update(delta)
    } else if (this.renderMode === 'odk') {
      this.odkLocomotion?.update(delta, state)
      this.odkAvatar?.update(delta)
    } else {
      this.animations?.update(delta, state)
    }
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
    this.pivot.position.set(0, 0, 0)
    this.animations?.dispose()
    this.animations = null
    if (this.vrmAvatar) {
      this.vrmLocomotion?.dispose()
      this.vrmLocomotion = null
      this.pivot.remove(this.vrmAvatar.root)
      this.vrmAvatar.dispose()
      this.vrmAvatar = null
      this.model = null
      this.renderMode = 'dcl'
      return
    }
    if (this.odkAvatar) {
      this.odkLocomotion?.dispose()
      this.odkLocomotion = null
      this.pivot.remove(this.odkAvatar.root)
      this.odkAvatar.dispose()
      this.odkAvatar = null
      this.model = null
      this.renderMode = 'dcl'
      return
    }
    if (!this.model) return
    disposeWearableInstance(this.model as THREE.Group)
    this.pivot.remove(this.model)
    this.model = null
    this.renderMode = 'dcl'
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
