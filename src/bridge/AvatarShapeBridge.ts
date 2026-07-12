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
import {
  defaultProfileIdentity,
  identityShowsNameTag,
  type ProfileIdentity
} from '../avatar/displayName'
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
  /** Cap concurrent full composes — sequential await of many NPCs freezes the async frame (~1fps). */
  private composeInFlight = 0
  /** During hydration keep 1; after play-ready allow a small burst so plaza NPCs appear. */
  private maxComposeInFlight = 1
  private static readonly MAX_COMPOSE_HYDRATION = 1
  private static readonly MAX_COMPOSE_PLAY = 2
  private readonly composeFailedUntil = new Map<Entity, number>()
  private static readonly COMPOSE_RETRY_MS = 8_000

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

  /** Call when scene play-ready so NPC AvatarShapes compose faster than hydration. */
  setPlayReady(playReady: boolean): void {
    this.maxComposeInFlight = playReady
      ? AvatarShapeBridge.MAX_COMPOSE_PLAY
      : AvatarShapeBridge.MAX_COMPOSE_HYDRATION
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
        // Placeholder identity — never await profile fetch inside syncAsyncBridges.
        const identity: ProfileIdentity = defaultProfileIdentity(
          typeof shape.name === 'string' && shape.name.trim() ? shape.name.trim() : 'Guest'
        )
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
        const created = entry
        void resolveShapeIdentity(shape).then((resolved) => {
          if (this.avatars.get(entity) !== created) return
          created.nameKey = avatarShapeNameKey(shape)
          syncNameTag(created, resolved)
        })
      } else if (entry.nameKey !== nameKey) {
        entry.nameKey = nameKey
        const current = entry
        void resolveShapeIdentity(shape).then((resolved) => {
          if (this.avatars.get(entity) !== current) return
          syncNameTag(current, resolved)
        })
      }

      if (entry.signature !== signature && !entry.loading) {
        if (entry.avatar.isProfileEmoteActive()) {
          entry.pendingSignatureReload = signature
        } else {
          this.startCompose(entity, entry, shape, signature)
        }
      } else if (entry.pendingSignatureReload && !entry.avatar.isProfileEmoteActive() && !entry.loading) {
        const pendingSignature = entry.pendingSignatureReload
        entry.pendingSignatureReload = null
        if (entry.signature !== pendingSignature) {
          this.startCompose(entity, entry, shape, pendingSignature)
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
        this.composeFailedUntil.delete(entity)
      }
    }
  }

  /**
   * Start at most one full wearable compose per bridge tick (fire-and-forget).
   * Awaiting many NPC AvatarShapes in one syncAsyncBridges call freezes the main thread.
   */
  private startCompose(
    entity: Entity,
    entry: AvatarEntry,
    shape: Parameters<typeof profileFromAvatarShape>[0],
    signature: string
  ): void {
    if (entry.loading) return
    if (this.composeInFlight >= this.maxComposeInFlight) {
      entry.pendingSignatureReload = signature
      return
    }
    const failedUntil = this.composeFailedUntil.get(entity) ?? 0
    if (performance.now() < failedUntil) {
      entry.pendingSignatureReload = signature
      return
    }

    entry.loading = true
    entry.signature = signature
    entry.pendingSignatureReload = null
    this.composeInFlight++
    const profile = profileFromAvatarShape(shape)
    void entry.avatar
      .load(profile, entry.identity.displayName)
      .then(async () => {
        syncNameTag(entry, await resolveShapeIdentity(shape))
        this.composeFailedUntil.delete(entity)
      })
      .catch((err) => {
        console.warn(`[AvatarShape] entity ${entity} compose failed:`, err)
        entry.signature = ''
        this.composeFailedUntil.set(entity, performance.now() + AvatarShapeBridge.COMPOSE_RETRY_MS)
      })
      .finally(() => {
        entry.loading = false
        this.composeInFlight = Math.max(0, this.composeInFlight - 1)
        flushPendingAvatarShapeEmote(entry)
      })
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
    this.composeFailedUntil.clear()
    this.composeInFlight = 0
  }
}
