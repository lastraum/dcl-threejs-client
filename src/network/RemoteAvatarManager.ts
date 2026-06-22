import type { Entity } from '@dcl/ecs'
import * as THREE from 'three'
import { AvatarAnimations } from '../avatar/AvatarAnimations'
import { composeAvatarFromProfile } from '../avatar/AvatarComposer'
import { disposeWearableInstance } from '../avatar/loadWearable'
import { AVATAR_YAW_OFFSET, BODY_SHAPE_URN, PEER_URL } from '../avatar/constants'
import { applyAvatarPivotOffset } from '../avatar/feetAlign'
import { updateNameTagAnchor } from '../avatar/headAnchor'
import { defaultProfileIdentity, identityFromAvatarProfile, type ProfileIdentity } from '../avatar/displayName'
import {
  profileFromSerializedEntry,
  resolveRemotePeerProfile,
  seedCommsPeerProfile
} from '../avatar/peerApi'
import type { AvatarProfile, BodyShape } from '../avatar/types'
import { DCL_LOCOMOTION_DEFAULTS } from '../player/locomotion'
import {
  dclToThreeVec,
  dclYawToThreeYaw,
  threeToDclQuat,
  threeToDclVec,
  type DclTransformValues
} from '../bridge/dclTransform'
import { ReservedEntitiesSync } from '../bridge/ReservedEntitiesSync'
import type { AvatarSkeletonTarget } from '../avatar/AvatarAttachTargets'
import { avatarEntityFromAddress, type EntityStore } from '../bridge/EntityStore'
import { clientDebugLog } from '../client/debug/ClientDebugLog'
import { NameTag } from '../client/ui/NameTag'
import { resolveProfileEmote, loadResolvedProfileEmote } from '../avatar/profileEmotes'
import type { AssetCache } from '../rendering/AssetCache'
import { createRemoteAvatarPlaceholder } from '../avatar/remotePlaceholder'
import { stabilizeSkinnedMeshes } from '../rendering/skinnedMeshInstance'
import type { AvatarTransformPayload } from './comms/types'
import { RemoteAvatarLoadQueue } from './RemoteAvatarLoadQueue'

type RemotePeerRecord = {
  address: string
  entity: Entity
  root: THREE.Object3D
  pivot: THREE.Group
  nameTagAnchor: THREE.Object3D
  placeholder: THREE.Group | null
  model: THREE.Group | null
  animations: AvatarAnimations | null
  nameTag: NameTag | null
  identity: ProfileIdentity
  bodyShape: BodyShape
  loading: Promise<void> | null
  hasPosition: boolean
  pendingProfile: AvatarProfile | null
  lastEmoteId: number
  activeEmoteUrn: string | null
  pendingEmote: string | null
  profileSignature: string | null
  deferredProfileReload: boolean
  targetPosition: THREE.Vector3
  velocity: THREE.Vector3
  receivedAt: number
  horizontalSpeed: number
  smoothedSpeed: number
  targetYaw: number
  currentYaw: number
  remoteGrounded: boolean
  remoteJumping: boolean
  jumpCount: number
  prevJumpCount: number
  doubleJumpTriggered: boolean
  verticalVelocity: number
}

function blankProfile(address: string): AvatarProfile {
  return {
    bodyShape: 'male',
    skin: '949494',
    hair: '3a3a3a',
    eyes: '3a3a3a',
    wearables: [BODY_SHAPE_URN.male],
    forceRender: [],
    emotes: [],
    fromWallet: false,
    address: address.toLowerCase()
  }
}

/** Remote player avatars — blank body first, swap to Catalyst profile when ready. */
export class RemoteAvatarManager {
  private readonly root = new THREE.Group()
  private readonly peers = new Map<string, RemotePeerRecord>()
  private contentUrl = ''
  private lambdasUrl = ''
  private assetCache: AssetCache | null = null
  private readonly scene: THREE.Scene
  private readonly loadQueue = new RemoteAvatarLoadQueue()
  private entityStore: EntityStore | null = null
  private localAddress: string | null = null

  constructor(scene: THREE.Scene) {
    this.scene = scene
    this.root.name = 'remote-avatars'
    scene.add(this.root)
  }

  /** Phase 4.5 — register remote peers in the unified EntityStore (owner `'avatar'`). */
  setEntityStore(store: EntityStore | null): void {
    this.entityStore = store
  }

  setLocalAddress(address: string | null): void {
    this.localAddress = address?.toLowerCase() ?? null
  }

  private isLocalPeer(address: string): boolean {
    const key = address.toLowerCase()
    return !!this.localAddress && key === this.localAddress
  }

  /** Remote peers with a known scene position. */
  get visiblePeerCount(): number {
    let count = 0
    for (const record of this.peers.values()) {
      if (record.hasPosition) count++
    }
    return count
  }

  setCatalystEndpoints(contentUrl: string, lambdasUrl: string): void {
    this.contentUrl = contentUrl.replace(/\/$/, '')
    this.lambdasUrl = lambdasUrl.replace(/\/$/, '')
  }

  setAssetCache(cache: AssetCache | null): void {
    this.assetCache = cache
  }

  setCameraPosition(position: THREE.Vector3): void {
    this.loadQueue.setCameraPosition(position)
  }

  /** Scene asset hydration — throttle remote composes so scene GLTF attach wins. */
  setHydrationLoading(active: boolean): void {
    this.loadQueue.setHydrationMode(active)
  }

  setSceneAssetPressure(gltfInflight: number, textureInflight = 0): void {
    this.loadQueue.setSceneAssetPressure(gltfInflight, textureInflight)
  }

  getAttachSkeleton(address: string): AvatarSkeletonTarget | null {
    const record = this.peers.get(address.toLowerCase())
    if (!record) return null
    const model = record.model ?? record.placeholder
    if (!model) return null
    return { model, nameTagAnchor: record.nameTagAnchor }
  }

  /** Scene chat line shown inside the peer's overhead name-tag pill. */
  showPeerNameTagChat(address: string, text: string): void {
    const record = this.peers.get(address.toLowerCase())
    record?.nameTag?.showChat(text)
  }

  getPlayerTransformDclForAddress(address: string): DclTransformValues | null {
    const record = this.peers.get(address.toLowerCase())
    if (!record || !record.hasPosition) return null
    const pos = threeToDclVec(record.root.position)
    const rot = threeToDclQuat(ReservedEntitiesSync.playerRotationFromYaw(record.currentYaw))
    return {
      position: { x: pos.x, y: pos.y, z: pos.z },
      rotation: { x: rot.x, y: rot.y, z: rot.z, w: rot.w },
      scale: { x: 1, y: 1, z: 1 }
    }
  }

  playPeerEmote(address: string, emoteRef: string, incrementalId: number): void {
    const key = address.toLowerCase()
    const record = this.peers.get(key)
    if (!record || incrementalId <= record.lastEmoteId) return
    record.lastEmoteId = incrementalId

    const normalizedRef = emoteRef.trim().toLowerCase()
    if (
      record.activeEmoteUrn === normalizedRef &&
      record.animations?.isProfileEmoteActive()
    ) {
      return
    }

    if (!record.model || !record.animations) {
      record.pendingEmote = emoteRef
      return
    }
    void this.applyPeerEmote(record, emoteRef)
  }

  upsertPeer(address: string, positionDcl?: THREE.Vector3): void {
    const key = address.toLowerCase()
    if (this.isLocalPeer(key)) return
    let record = this.peers.get(key)
    if (!record) {
      const entity = avatarEntityFromAddress(key)
      const root = this.entityStore?.upsertAvatar(entity) ?? new THREE.Object3D()
      root.name = `remote-${key.slice(0, 8)}`
      root.visible = false
      const pivot = new THREE.Group()
      pivot.name = 'remote-pivot'
      const nameTagAnchor = new THREE.Object3D()
      nameTagAnchor.name = 'remote-name-tag'
      root.add(pivot)
      root.add(nameTagAnchor)
      if (!this.entityStore) this.root.add(root)

      record = {
        address: key,
        entity,
        root,
        pivot,
        nameTagAnchor,
        placeholder: null,
        model: null,
        animations: null,
        nameTag: null,
        identity: defaultProfileIdentity(key.slice(0, 8)),
        bodyShape: 'male',
        loading: null,
        hasPosition: false,
        pendingProfile: null,
        lastEmoteId: 0,
        activeEmoteUrn: null,
        pendingEmote: null,
        profileSignature: null,
        deferredProfileReload: false,
        targetPosition: new THREE.Vector3(),
        velocity: new THREE.Vector3(),
        receivedAt: performance.now(),
        horizontalSpeed: 0,
        smoothedSpeed: 0,
        targetYaw: 0,
        currentYaw: 0,
        remoteGrounded: true,
        remoteJumping: false,
        jumpCount: 0,
        prevJumpCount: 0,
        doubleJumpTriggered: false,
        verticalVelocity: 0
      }
      this.peers.set(key, record)
    }

    if (positionDcl) {
      const position = dclToThreeVec(positionDcl)
      record.hasPosition = true
      record.targetPosition.copy(position)
      record.root.position.copy(position)
      record.root.visible = true
      if (!record.model && !record.placeholder) {
        this.attachLoadingPresentation(record)
      }
    }

    this.tryStartAvatarLoad(key, record)
  }

  applyPeerProfile(address: string, serializedProfile: string): void {
    const key = address.toLowerCase()
    if (this.isLocalPeer(key)) return
    const profile = profileFromSerializedEntry(serializedProfile, key)
    if (!profile) return

    let record = this.peers.get(key)
    if (!record) {
      this.upsertPeer(key)
      record = this.peers.get(key)
    }
    if (!record) return

    if (record.profileSignature === serializedProfile) return

    seedCommsPeerProfile(key, serializedProfile)
    record.pendingProfile = profile
    record.profileSignature = serializedProfile
    record.bodyShape = profile.bodyShape
    record.identity = identityFromAvatarProfile(profile, key)
    if (!record.model && record.hasPosition) {
      this.attachLoadingPresentation(record)
    }
    if (record.model) {
      if (record.animations?.isProfileEmoteActive()) {
        record.deferredProfileReload = true
        return
      }
      void this.reloadPeerAvatar(key, record)
    } else {
      this.tryStartAvatarLoad(key, record)
    }
  }

  removePeer(address: string): void {
    const key = address.toLowerCase()
    const record = this.peers.get(key)
    if (!record) return
    this.loadQueue.cancel(key)
    this.disposePeerModel(record)
    record.nameTag?.dispose()
    if (this.entityStore) {
      this.entityStore.removeAvatar(record.entity)
    } else {
      record.root.removeFromParent()
    }
    this.peers.delete(key)
  }

  updatePeerTransform(
    address: string,
    positionDcl: THREE.Vector3,
    yawDcl: number,
    velocity?: THREE.Vector3,
    locomotion?: Pick<AvatarTransformPayload, 'isGrounded' | 'isJumping' | 'jumpCount'>
  ): void {
    const key = address.toLowerCase()
    if (this.isLocalPeer(key)) return
    const position = dclToThreeVec(positionDcl)
    const yaw = dclYawToThreeYaw(yawDcl)
    if (!this.peers.has(key)) {
      this.upsertPeer(key, positionDcl)
      clientDebugLog.log(
        'network',
        `Remote peer first transform · ${key.slice(0, 8)}… dcl=(${positionDcl.x.toFixed(1)},${positionDcl.y.toFixed(1)},${positionDcl.z.toFixed(1)}) three=(${position.x.toFixed(1)},${position.y.toFixed(1)},${position.z.toFixed(1)})`,
        { throttleMs: 0, throttleKey: `first-pos:${key}` }
      )
      return
    }
    const record = this.peers.get(key)
    if (!record) return

    const now = performance.now()
    const dt = (now - record.receivedAt) / 1000
    const prevTarget = record.targetPosition.clone()
    const prevVy = record.verticalVelocity

    if (record.hasPosition && dt > 0.001) {
      const dist = position.distanceTo(prevTarget)
      record.horizontalSpeed = dist / dt
      record.velocity.set(
        (position.x - prevTarget.x) / dt,
        (position.y - prevTarget.y) / dt,
        (position.z - prevTarget.z) / dt
      )
      record.verticalVelocity = record.velocity.y
    }

    if (locomotion) {
      if (locomotion.isGrounded !== undefined) {
        record.remoteGrounded = locomotion.isGrounded
        if (locomotion.isGrounded) {
          record.jumpCount = 0
          record.prevJumpCount = 0
        }
      }
      if (locomotion.isJumping !== undefined) record.remoteJumping = locomotion.isJumping
      if (locomotion.jumpCount !== undefined) {
        record.prevJumpCount = record.jumpCount
        record.jumpCount = locomotion.jumpCount
        if (record.jumpCount >= 2 && record.prevJumpCount < 2) {
          record.doubleJumpTriggered = true
        }
      }
    } else if (velocity && velocity.y > 6 && prevVy <= 3 && !record.remoteGrounded) {
      record.doubleJumpTriggered = true
      record.jumpCount = Math.max(record.jumpCount, 2)
    }

    if (velocity) {
      record.verticalVelocity = velocity.y
      if (velocity.y > 2) record.remoteJumping = true
    }

    if (!record.hasPosition) {
      record.root.position.copy(position)
      record.root.visible = true
    }

    record.hasPosition = true
    record.targetPosition.copy(position)
    record.targetYaw = yaw
    record.receivedAt = now

    this.loadQueue.updatePeerDistance(key, record.targetPosition)
    this.tryStartAvatarLoad(key, record)
  }

  update(delta: number): void {
    const alpha = 1 - Math.exp(-8 * delta)
    const speedAlpha = 1 - Math.exp(-10 * delta)

    for (const [key, record] of this.peers.entries()) {
      if (record.hasPosition) {
        record.root.position.lerp(record.targetPosition, alpha)
      }

      // Snap facing while moving so rotation does not trail position interpolation.
      if (record.horizontalSpeed > 0.35) {
        record.currentYaw = record.targetYaw
      } else {
        record.currentYaw += (record.targetYaw - record.currentYaw) * alpha
      }
      record.pivot.rotation.y = record.currentYaw + AVATAR_YAW_OFFSET

      record.smoothedSpeed += (record.horizontalSpeed - record.smoothedSpeed) * speedAlpha
      const speed = record.smoothedSpeed
      const emoteActive = record.animations?.isProfileEmoteActive() ?? false
      const locomotionMode =
        speed > DCL_LOCOMOTION_DEFAULTS.runSpeed * 0.85
          ? 'run'
          : speed > DCL_LOCOMOTION_DEFAULTS.jogSpeed * 0.35
            ? 'jog'
            : 'walk'
      const grounded = record.remoteGrounded && record.verticalVelocity > -8
      const jumping = record.remoteJumping && record.jumpCount <= 1
      const doubleJumping = record.jumpCount >= 2 && !grounded

      record.animations?.update(delta, {
        horizontalSpeed: emoteActive ? 0 : speed,
        grounded,
        nearGround: grounded,
        verticalVelocity: record.verticalVelocity,
        locomotionMode,
        jumping,
        doubleJumping,
        doubleJumpTriggered: record.doubleJumpTriggered,
        falling: !grounded && !jumping && !doubleJumping && record.verticalVelocity < -1.5
      })
      if (record.activeEmoteUrn && record.animations && !record.animations.isProfileEmoteActive()) {
        record.activeEmoteUrn = null
      }
      if (record.deferredProfileReload && !record.animations?.isProfileEmoteActive()) {
        record.deferredProfileReload = false
        void this.reloadPeerAvatar(key, record)
      }
      record.doubleJumpTriggered = false

      const nameTagTarget = record.model ?? record.placeholder
      if (nameTagTarget) {
        updateNameTagAnchor(record.nameTagAnchor, nameTagTarget)
      }
    }
  }

  dispose(): void {
    for (const key of [...this.peers.keys()]) {
      this.removePeer(key)
    }
    this.root.removeFromParent()
  }

  private tryStartAvatarLoad(address: string, record: RemotePeerRecord, force = false): void {
    if (!record.hasPosition || record.loading || record.model) return
    let resolveLoad!: () => void
    record.loading = new Promise<void>((resolve) => {
      resolveLoad = resolve
    })
    this.loadQueue.enqueue(
      address,
      record.targetPosition,
      async () => {
        try {
          await this.loadPeerAvatar(address, record)
        } finally {
          resolveLoad()
        }
      },
      force
    )
  }

  private async reloadPeerAvatar(address: string, record: RemotePeerRecord): Promise<void> {
    if (record.loading) return
    this.loadQueue.cancel(address)
    this.disposePeerModel(record)
    record.nameTag?.dispose()
    record.nameTag = null
    this.tryStartAvatarLoad(address, record, true)
    await record.loading
  }

  private attachLoadingPresentation(record: RemotePeerRecord): void {
    if (!record.placeholder) {
      record.placeholder = createRemoteAvatarPlaceholder(true)
      record.pivot.add(record.placeholder)
    }
    record.nameTag?.dispose()
    record.nameTag = NameTag.attach(record.nameTagAnchor, record.identity.displayName, {
      textColor: record.identity.nameColor,
      claimed: record.identity.hasClaimedName,
      address: record.address,
      interactive: true
    })
    updateNameTagAnchor(record.nameTagAnchor, record.placeholder)
  }

  private clearLoadingPresentation(record: RemotePeerRecord): void {
    if (record.placeholder) {
      record.pivot.remove(record.placeholder)
      this.disposeModel(record.placeholder)
      record.placeholder = null
    }
  }

  private async loadPeerAvatar(address: string, record: RemotePeerRecord): Promise<void> {
    const key = address.toLowerCase()
    try {
      if (!this.peers.has(key)) return

      const profile =
        record.pendingProfile ??
        (await resolveRemotePeerProfile(address, this.lambdasUrl || undefined)) ??
        blankProfile(address)
      record.identity = identityFromAvatarProfile(profile, address)
      record.bodyShape = profile.bodyShape
      record.pendingProfile = profile

      if (!record.model && !record.placeholder) {
        this.attachLoadingPresentation(record)
      } else if (!record.nameTag) {
        this.attachLoadingPresentation(record)
      }

      if (!this.peers.has(key)) return

      record.model = await composeAvatarFromProfile(profile, this.contentUrl || undefined, this.assetCache)
      stabilizeSkinnedMeshes(record.model)

      if (!this.peers.has(key)) {
        this.disposeModel(record.model)
        record.model = null
        return
      }

      this.clearLoadingPresentation(record)

      record.pivot.add(record.model)

      record.animations = new AvatarAnimations()
      try {
        await record.animations.bind(record.model, record.pivot, {
          bodyShape: record.bodyShape,
          peerUrl: this.contentUrl || undefined,
          assetCache: this.assetCache
        })
        record.animations.setVfxScene(this.scene)
        applyAvatarPivotOffset(record.pivot, record.model)
      } catch (err) {
        console.warn(`[network] remote emotes failed for ${address}`, err)
        record.animations.dispose()
        record.animations = null
      }

      record.nameTag?.dispose()
      record.nameTag = NameTag.attach(record.nameTagAnchor, record.identity.displayName, {
        textColor: record.identity.nameColor,
        claimed: record.identity.hasClaimedName,
        address: record.address,
        interactive: true
      })

      const { x, y, z } = record.targetPosition
      clientDebugLog.log(
        'network',
        `Remote avatar ready · ${record.identity.displayName} @ x=${x.toFixed(1)} y=${y.toFixed(1)} z=${z.toFixed(1)}`,
        { level: 'success' }
      )

      if (record.pendingEmote) {
        const pending = record.pendingEmote
        record.pendingEmote = null
        void this.applyPeerEmote(record, pending)
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      clientDebugLog.log('network', `Remote avatar failed · ${address.slice(0, 8)}… ${msg}`, { level: 'error' })
      console.warn(`[network] remote avatar failed for ${address}`, err)
    } finally {
      record.loading = null
    }
  }

  private async applyPeerEmote(record: RemotePeerRecord, emoteRef: string): Promise<void> {
    if (!record.model || !record.animations) return

    const normalizedRef = emoteRef.trim().toLowerCase()
    if (record.activeEmoteUrn === normalizedRef && record.animations.isProfileEmoteActive()) {
      return
    }

    const peerUrl = this.contentUrl || PEER_URL
    const resolved = await resolveProfileEmote(emoteRef, record.bodyShape, peerUrl)
    if (!resolved) return

    try {
      const cached = this.assetCache ? await loadResolvedProfileEmote(this.assetCache, resolved) : null
      if (!cached?.animations.length) return
      if (record.animations.playProfileEmoteFromGltf(cached, resolved.loop)) {
        record.activeEmoteUrn = resolved.urn.trim().toLowerCase()
      }
    } catch {
      /* scene / profile emote load failures are expected when assets are unavailable */
    }
  }

  private disposePeerModel(record: RemotePeerRecord): void {
    record.animations?.dispose()
    record.animations = null
    record.activeEmoteUrn = null
    this.clearLoadingPresentation(record)
    if (record.model) {
      this.disposeModel(record.model)
      record.model = null
    }
  }

  private disposeModel(model: THREE.Group): void {
    disposeWearableInstance(model)
    model.removeFromParent()
  }
}
