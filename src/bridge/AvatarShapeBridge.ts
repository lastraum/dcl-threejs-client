import type { Entity } from '@dcl/ecs'
import type * as THREE from 'three'
import {
  avatarShapeNameKey,
  avatarShapeSignature,
  profileFromAvatarShape,
  resolveShapeIdentity
} from '../avatar/avatarShapeProfile'
import {
  resolveAvatarShapeExpressionAction,
  type AvatarShapeExpressionState
} from '../avatar/avatarShapeEmote'
import { SceneAvatar } from '../avatar/SceneAvatar'
import { identityShowsNameTag, type ProfileIdentity } from '../avatar/displayName'
import { NameTag, type NameTagStyle } from '../client/ui/NameTag'
import type { AssetCache } from '../rendering/AssetCache'
import type { AvatarSkeletonTarget } from '../avatar/AvatarAttachTargets'
import type { MirrorComponents } from './mirrorComponents'
import type { ProjectionView } from './ProjectionView'

type AvatarEntry = {
  avatar: SceneAvatar
  nameTag: NameTag | null
  signature: string
  nameKey: string
  identity: ProfileIdentity
  loading: boolean
  expression: AvatarShapeExpressionState
  pendingEmote: { emoteRef: string; loop: boolean } | null
  pendingSignatureReload: string | null
}

function applyIdentity(tag: NameTag, identity: ProfileIdentity): void {
  tag.setText(identity.displayName)
  tag.setStyle({
    textColor: identity.nameColor,
    claimed: identity.hasClaimedName
  } satisfies NameTagStyle)
}

function syncNameTag(entry: AvatarEntry, identity: ProfileIdentity): void {
  entry.identity = identity
  if (!identityShowsNameTag(identity)) {
    entry.nameTag?.dispose()
    entry.nameTag = null
    return
  }
  if (!entry.nameTag) {
    entry.nameTag = NameTag.attach(entry.avatar.nameTagAnchor, identity.displayName, {
      textColor: identity.nameColor,
      claimed: identity.hasClaimedName
    })
    return
  }
  applyIdentity(entry.nameTag, identity)
}

function playAvatarShapeEmote(entry: AvatarEntry, emoteRef: string, loop: boolean): void {
  if (entry.loading) {
    entry.pendingEmote = { emoteRef, loop }
    return
  }
  void entry.avatar.playEmote(emoteRef, loop)
}

function flushPendingAvatarShapeEmote(entry: AvatarEntry): void {
  if (!entry.pendingEmote || entry.loading) return
  const pending = entry.pendingEmote
  entry.pendingEmote = null
  void entry.avatar.playEmote(pending.emoteRef, pending.loop)
}

/** Compose and attach avatars for mirror entities with `AvatarShape`. */
export class AvatarShapeBridge {
  private readonly avatars = new Map<Entity, AvatarEntry>()
  private assetCache: AssetCache | null = null
  private peerUrl = ''

  constructor(
    private readonly ecs: MirrorComponents,
    private readonly getNode: (entity: Entity) => THREE.Group | undefined
  ) {}

  setAssetCache(cache: AssetCache | null, peerUrl?: string): void {
    this.assetCache = cache
    if (peerUrl) this.peerUrl = peerUrl.replace(/\/$/, '')
    for (const entry of this.avatars.values()) {
      entry.avatar.setAssetCache(cache, this.peerUrl || undefined)
    }
  }

  async sync(view: ProjectionView): Promise<void> {
    const { AvatarShape, Transform } = this.ecs
    const active = new Set<Entity>()

    for (const [entity] of view.getEntitiesWith(AvatarShape)) {
      if (entity === view.RootEntity || entity === view.PlayerEntity || entity === view.CameraEntity) {
        continue
      }
      if (!Transform.has(entity)) continue

      active.add(entity)
      const node = this.getNode(entity)
      if (!node) continue

      const shape = AvatarShape.get(entity)
      const signature = avatarShapeSignature(shape)
      const nameKey = avatarShapeNameKey(shape)
      let entry = this.avatars.get(entity)

      if (!entry) {
        const avatar = new SceneAvatar(node)
        avatar.setAssetCache(this.assetCache, this.peerUrl || undefined)
        const identity = await resolveShapeIdentity(shape)
        entry = {
          avatar,
          nameTag: null,
          signature: '',
          nameKey,
          identity,
          loading: false,
          expression: { lastTriggerId: '', lastTimestamp: undefined },
          pendingEmote: null,
          pendingSignatureReload: null
        }
        syncNameTag(entry, identity)
        this.avatars.set(entity, entry)
      } else if (entry.nameKey !== nameKey) {
        entry.nameKey = nameKey
        syncNameTag(entry, await resolveShapeIdentity(shape))
      }

      if (entry.signature !== signature && !entry.loading) {
        if (entry.avatar.isProfileEmoteActive()) {
          entry.pendingSignatureReload = signature
        } else {
          entry.pendingSignatureReload = null
          entry.loading = true
          entry.signature = signature
          const profile = profileFromAvatarShape(shape)
          try {
            await entry.avatar.load(profile, entry.identity.displayName)
            syncNameTag(entry, await resolveShapeIdentity(shape))
          } catch (err) {
            console.warn(`[AvatarShape] entity ${entity} compose failed:`, err)
            entry.signature = ''
          } finally {
            entry.loading = false
            flushPendingAvatarShapeEmote(entry)
          }
        }
      } else if (entry.pendingSignatureReload && !entry.avatar.isProfileEmoteActive() && !entry.loading) {
        const pendingSignature = entry.pendingSignatureReload
        entry.pendingSignatureReload = null
        if (entry.signature !== pendingSignature) {
          entry.loading = true
          entry.signature = pendingSignature
          const profile = profileFromAvatarShape(shape)
          try {
            await entry.avatar.load(profile, entry.identity.displayName)
            syncNameTag(entry, await resolveShapeIdentity(shape))
          } catch (err) {
            console.warn(`[AvatarShape] entity ${entity} compose failed:`, err)
            entry.signature = ''
          } finally {
            entry.loading = false
            flushPendingAvatarShapeEmote(entry)
          }
        }
      }

      const expressionAction = resolveAvatarShapeExpressionAction(shape, entry.expression)
      if (expressionAction?.type === 'stop') {
        entry.pendingEmote = null
        entry.avatar.stopEmote()
      } else if (expressionAction?.type === 'play') {
        playAvatarShapeEmote(entry, expressionAction.emoteRef, expressionAction.loop)
      } else {
        flushPendingAvatarShapeEmote(entry)
      }
    }

    for (const [entity, entry] of this.avatars) {
      if (!active.has(entity)) {
        entry.nameTag?.dispose()
        entry.avatar.dispose()
        this.avatars.delete(entity)
      }
    }
  }

  getNpcSkeleton(entity: Entity): AvatarSkeletonTarget | null {
    const entry = this.avatars.get(entity)
    if (!entry) return null
    const model = entry.avatar.getModel()
    if (!model) return null
    return { model, nameTagAnchor: entry.avatar.nameTagAnchor }
  }

  playEmote(entity: Entity, emoteRef: string, loop: boolean): void {
    const entry = this.avatars.get(entity)
    if (!entry) return
    playAvatarShapeEmote(entry, emoteRef, loop)
  }

  stopEmote(entity: Entity): void {
    const entry = this.avatars.get(entity)
    if (!entry) return
    entry.pendingEmote = null
    entry.avatar.stopEmote()
  }

  update(delta: number): void {
    for (const entry of this.avatars.values()) {
      entry.avatar.update(delta)
    }
  }

  dispose(): void {
    for (const entry of this.avatars.values()) {
      entry.nameTag?.dispose()
      entry.avatar.dispose()
    }
    this.avatars.clear()
  }
}
