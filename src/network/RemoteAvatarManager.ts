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
import { VrmAvatar } from '../avatar/vrm/VrmAvatar'
import { VrmLocomotionAnimations } from '../avatar/vrm/VrmLocomotionAnimations'
import { disposeVrmRoot } from '../avatar/vrm/VrmLoader'
import { applyVrmPivotOffset } from '../avatar/vrm/vrmFeetAlign'
import { retargetGltfClipToVrm } from '../avatar/vrm/mixamoRetarget'
import { getVrmRamBytes, getVrmRamFormat } from '../avatar/vrm/vrmRamCache'
import type { CustomAvatarFormat } from '../avatar/vrm/constants'
import { OdkAvatar } from '../avatar/odk/OdkAvatar'
import { formatTag, odkNetInfo, odkNetWarn, shortAddr, shortHash } from '../avatar/odk/odkNetLog'
import { OdkLocomotionAnimations } from '../avatar/odk/OdkLocomotionAnimations'
import { disposeOdkRoot } from '../avatar/odk/OdkLoader'
import { applyOdkPivotOffset } from '../avatar/odk/odkFeetAlign'
import { applyOdkRestCorrection, retargetGltfClipToOdk } from '../avatar/odk/odkRetarget'
import type { AvatarTransformPayload } from './comms/types'
import type { LocomotionMode } from '../player/locomotion'
import { RemoteAvatarLoadQueue } from './RemoteAvatarLoadQueue'
import type { InteractiveNameTagHit } from '../client/ui/overlayHitTest'

type RemotePeerRecord = {
  address: string
  entity: Entity
  root: THREE.Object3D
  pivot: THREE.Group
  nameTagAnchor: THREE.Object3D
  placeholder: THREE.Group | null
  model: THREE.Object3D | null
  animations: AvatarAnimations | null
  vrmAvatar: VrmAvatar | null
  vrmLocomotion: VrmLocomotionAnimations | null
  odkAvatar: OdkAvatar | null
  odkLocomotion: OdkLocomotionAnimations | null
  renderMode: 'dcl' | 'vrm' | 'odk'
  vrmContentHash: string | null
  customAvatarFormat: CustomAvatarFormat | null
  /** Content hash of the custom mesh actually mounted (may lag vrmContentHash during swaps). */
  vrmLoadedHash: string | null
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

const REMOTE_LOCO_SPEED_CAP = DCL_LOCOMOTION_DEFAULTS.runSpeed * 1.15

function inferRemoteLocomotionMode(speed: number): LocomotionMode {
  if (speed > DCL_LOCOMOTION_DEFAULTS.runSpeed * 0.85) return 'run'
  if (speed > DCL_LOCOMOTION_DEFAULTS.jogSpeed * 0.35) return 'jog'
  return 'walk'
}

function remoteTargetLocomotionSpeed(mode: LocomotionMode): number {
  switch (mode) {
    case 'run':
      return DCL_LOCOMOTION_DEFAULTS.runSpeed
    case 'walk':
      return DCL_LOCOMOTION_DEFAULTS.walkSpeed
    default:
      return DCL_LOCOMOTION_DEFAULTS.jogSpeed
  }
}

function resolveRemoteHorizontalSpeed(
  posSpeed: number,
  velocity?: THREE.Vector3
): number {
  const cappedPos = Math.min(Math.max(0, posSpeed), REMOTE_LOCO_SPEED_CAP)
  if (!velocity) return cappedPos
  const wireHoriz = Math.hypot(velocity.x, velocity.z)
  if (wireHoriz > 0.03) return Math.min(wireHoriz, REMOTE_LOCO_SPEED_CAP)
  return cappedPos
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
  private readonly peerReloadSeq = new Map<string, number>()
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

  /**
   * Screen-space hit on a remote avatar body — used for pointer-lock pill hover.
   * Returns the peer's CSS2D pill element when the cursor is over the projected bounds.
   */
  findPeerNearScreenPoint(
    clientX: number,
    clientY: number,
    camera: THREE.Camera | null,
    slopPx = 28
  ): InteractiveNameTagHit | null {
    if (!camera) return null
    const canvas = document.querySelector('#app canvas') as HTMLCanvasElement | null
    if (!canvas) return null
    const canvasRect = canvas.getBoundingClientRect()
    if (canvasRect.width <= 0 || canvasRect.height <= 0) return null

    const _projected = new THREE.Vector3()
    const _box = new THREE.Box3()
    let best: { hit: InteractiveNameTagHit; score: number } | null = null

    for (const [address, record] of this.peers.entries()) {
      if (!record.hasPosition) continue
      const body = record.model ?? record.placeholder
      if (!body) continue

      body.updateWorldMatrix(true, true)
      _box.setFromObject(body)
      if (_box.isEmpty()) continue
      _box.expandByScalar(0.08)

      let minX = Infinity
      let minY = Infinity
      let maxX = -Infinity
      let maxY = -Infinity
      for (const corner of boxCornerPoints(_box)) {
        _projected.copy(corner).project(camera)
        const sx = canvasRect.left + (_projected.x * 0.5 + 0.5) * canvasRect.width
        const sy = canvasRect.top + (-_projected.y * 0.5 + 0.5) * canvasRect.height
        minX = Math.min(minX, sx)
        maxX = Math.max(maxX, sx)
        minY = Math.min(minY, sy)
        maxY = Math.max(maxY, sy)
      }

      const inBounds =
        clientX >= minX - slopPx &&
        clientX <= maxX + slopPx &&
        clientY >= minY - slopPx &&
        clientY <= maxY + slopPx
      if (!inBounds) continue

      const element = document.querySelector<HTMLElement>(
        `.avatar-name-tag--interactive[data-peer-address="${address}"]`
      )
      if (!element) continue

      const cx = (minX + maxX) * 0.5
      const cy = (minY + maxY) * 0.5
      const score = Math.hypot(clientX - cx, clientY - cy)
      if (!best || score < best.score) {
        best = { hit: { address, element }, score }
      }
    }

    return best?.hit ?? null
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

  setPeerVrmHash(
    address: string,
    contentHash: string | null,
    format: CustomAvatarFormat | null = null
  ): void {
    const key = address.toLowerCase()
    const record = this.peers.get(key)
    if (!record) {
      odkNetWarn('setPeerVrmHash — no remote peer record yet', {
        peer: shortAddr(key),
        format: formatTag(format),
        hash: shortHash(contentHash)
      })
      return
    }
    const normalized = contentHash?.toLowerCase() ?? null
    const resolvedFormat = normalized ? (format ?? record.customAvatarFormat ?? 'vrm') : null
    if (record.vrmContentHash === normalized && record.customAvatarFormat === resolvedFormat) {
      if (
        normalized &&
        record.vrmLoadedHash === normalized &&
        (record.vrmAvatar || record.odkAvatar)
      ) {
        odkNetInfo('setPeerVrmHash — already mounted', {
          peer: shortAddr(key),
          format: formatTag(resolvedFormat),
          hash: shortHash(normalized),
          renderMode: record.renderMode
        })
        return
      }
      if (!normalized && record.renderMode === 'dcl') return
    }
    record.vrmContentHash = normalized
    record.customAvatarFormat = resolvedFormat
    if (!normalized) {
      odkNetInfo('setPeerVrmHash — peer cleared custom avatar', {
        peer: shortAddr(key),
        wasMode: record.renderMode
      })
      if (record.renderMode === 'vrm' || record.renderMode === 'odk') {
        void this.reloadPeerAvatar(key, record)
      }
      return
    }
    odkNetInfo('setPeerVrmHash — reload scheduled', {
      peer: shortAddr(key),
      format: formatTag(resolvedFormat),
      hash: shortHash(normalized),
      ramReady: !!getVrmRamBytes(normalized),
      wasMode: record.renderMode
    })
    void this.reloadPeerAvatar(key, record)
  }

  onPeerVrmBytesReady(
    address: string,
    contentHash: string,
    format: CustomAvatarFormat = 'vrm'
  ): void {
    const key = address.toLowerCase()
    const record = this.peers.get(key)
    if (!record) {
      odkNetWarn('onPeerVrmBytesReady — no remote peer record', {
        peer: shortAddr(key),
        format: formatTag(format),
        hash: shortHash(contentHash)
      })
      return
    }
    const hash = contentHash.toLowerCase()
    if (!record.vrmContentHash) {
      record.vrmContentHash = hash
      record.customAvatarFormat = format
    } else if (record.vrmContentHash !== hash) {
      odkNetWarn('onPeerVrmBytesReady — hash mismatch, ignoring', {
        peer: shortAddr(key),
        expected: shortHash(record.vrmContentHash),
        got: shortHash(hash),
        format: formatTag(format)
      })
      return
    } else if (!record.customAvatarFormat) {
      record.customAvatarFormat = format
    }
    if (
      record.vrmLoadedHash === hash &&
      ((record.renderMode === 'vrm' && record.vrmAvatar) ||
        (record.renderMode === 'odk' && record.odkAvatar))
    ) {
      odkNetInfo('onPeerVrmBytesReady — already mounted', {
        peer: shortAddr(key),
        format: formatTag(format),
        hash: shortHash(hash),
        renderMode: record.renderMode
      })
      return
    }
    odkNetInfo('onPeerVrmBytesReady — reload scheduled', {
      peer: shortAddr(key),
      format: formatTag(record.customAvatarFormat ?? format),
      hash: shortHash(hash),
      bytes: getVrmRamBytes(hash)?.byteLength ?? 0
    })
    void this.reloadPeerAvatar(key, record)
  }

  playPeerEmote(address: string, emoteRef: string, incrementalId: number): void {
    const key = address.toLowerCase()
    const record = this.peers.get(key)
    if (!record || incrementalId <= record.lastEmoteId) return
    record.lastEmoteId = incrementalId

    const normalizedRef = emoteRef.trim().toLowerCase()
    const emoteActive =
      record.renderMode === 'vrm'
        ? record.vrmLocomotion?.isProfileEmoteActive()
        : record.renderMode === 'odk'
          ? record.odkLocomotion?.isProfileEmoteActive()
          : record.animations?.isProfileEmoteActive()
    if (record.activeEmoteUrn === normalizedRef && emoteActive) {
      return
    }

    if (!record.model || (record.renderMode === 'dcl' && !record.animations)) {
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
        vrmAvatar: null,
        vrmLocomotion: null,
        odkAvatar: null,
        odkLocomotion: null,
        renderMode: 'dcl',
        vrmContentHash: null,
        customAvatarFormat: null,
        vrmLoadedHash: null,
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
      odkNetInfo('remote peer record created', { peer: shortAddr(key) })
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
    this.peerReloadSeq.delete(key)
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
      const posSpeed = dist / dt
      record.horizontalSpeed = resolveRemoteHorizontalSpeed(posSpeed, velocity)
      record.velocity.set(
        (position.x - prevTarget.x) / dt,
        (position.y - prevTarget.y) / dt,
        (position.z - prevTarget.z) / dt
      )
      if (!velocity) {
        record.verticalVelocity = record.velocity.y
      }
    } else if (velocity) {
      record.horizontalSpeed = resolveRemoteHorizontalSpeed(0, velocity)
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
      const emoteActive =
        record.renderMode === 'vrm'
          ? (record.vrmLocomotion?.isProfileEmoteActive() ?? false)
          : record.renderMode === 'odk'
            ? (record.odkLocomotion?.isProfileEmoteActive() ?? false)
            : (record.animations?.isProfileEmoteActive() ?? false)
      const locomotionMode = inferRemoteLocomotionMode(speed)
      const targetLocomotionSpeed =
        !emoteActive && speed > 0.08 ? remoteTargetLocomotionSpeed(locomotionMode) : 0
      const grounded = record.remoteGrounded && record.verticalVelocity > -8
      const jumping = record.remoteJumping && record.jumpCount <= 1
      const doubleJumping = record.jumpCount >= 2 && !grounded

      const locomotionState = {
        horizontalSpeed: emoteActive ? 0 : speed,
        targetLocomotionSpeed,
        grounded,
        nearGround: grounded,
        verticalVelocity: record.verticalVelocity,
        locomotionMode,
        jumping,
        doubleJumping,
        doubleJumpTriggered: record.doubleJumpTriggered,
        falling: !grounded && !jumping && !doubleJumping && record.verticalVelocity < -1.5
      }
      if (record.renderMode === 'vrm') {
        record.vrmLocomotion?.update(delta, locomotionState)
        record.vrmAvatar?.update(delta)
      } else if (record.renderMode === 'odk') {
        record.odkLocomotion?.update(delta, locomotionState)
        record.odkAvatar?.update(delta)
      } else {
        record.animations?.update(delta, locomotionState)
      }
      const stillEmoting =
        record.renderMode === 'vrm'
          ? record.vrmLocomotion?.isProfileEmoteActive()
          : record.renderMode === 'odk'
            ? record.odkLocomotion?.isProfileEmoteActive()
            : record.animations?.isProfileEmoteActive()
      if (record.activeEmoteUrn && !stillEmoting) {
        record.activeEmoteUrn = null
      }
      if (record.deferredProfileReload && !stillEmoting) {
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

  private tryStartAvatarLoad(
    address: string,
    record: RemotePeerRecord,
    force = false
  ): Promise<void> | null {
    if (!record.hasPosition || record.model) return null
    if (record.loading && !force) return record.loading
    let resolveLoad!: () => void
    const loadPromise = new Promise<void>((resolve) => {
      resolveLoad = resolve
    })
    record.loading = loadPromise
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
    return loadPromise
  }

  private async reloadPeerAvatar(address: string, record: RemotePeerRecord): Promise<void> {
    const key = address.toLowerCase()
    const seq = (this.peerReloadSeq.get(key) ?? 0) + 1
    this.peerReloadSeq.set(key, seq)

    this.loadQueue.cancel(key)
    if (record.loading) {
      await record.loading.catch(() => undefined)
    }
    if (this.peerReloadSeq.get(key) !== seq) return

    this.disposePeerModel(record)
    if (record.hasPosition) {
      this.attachLoadingPresentation(record)
    }

    record.loading = null
    const pendingLoad = this.tryStartAvatarLoad(key, record, true)
    if (pendingLoad) {
      await pendingLoad.catch(() => undefined)
    }
    if (this.peerReloadSeq.get(key) !== seq) return
  }

  private ensureNameTag(record: RemotePeerRecord, loading: boolean): void {
    if (!record.nameTag) {
      record.nameTag = NameTag.attach(record.nameTagAnchor, record.identity.displayName, {
        textColor: record.identity.nameColor,
        claimed: record.identity.hasClaimedName,
        address: record.address,
        interactive: true
      })
    } else {
      record.nameTag.setText(record.identity.displayName)
      record.nameTag.setStyle({
        textColor: record.identity.nameColor,
        claimed: record.identity.hasClaimedName
      })
    }
    record.nameTag.setLoading(loading)
  }

  private attachLoadingPresentation(record: RemotePeerRecord): void {
    if (!record.placeholder) {
      record.placeholder = createRemoteAvatarPlaceholder(true)
      record.pivot.add(record.placeholder)
    }
    this.ensureNameTag(record, true)
    updateNameTagAnchor(record.nameTagAnchor, record.placeholder)
  }

  private finalizeNameTag(record: RemotePeerRecord): void {
    this.ensureNameTag(record, false)
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

      if (record.vrmContentHash) {
        const customBytes = getVrmRamBytes(record.vrmContentHash)
        if (customBytes) {
          const format =
            record.customAvatarFormat ??
            getVrmRamFormat(record.vrmContentHash) ??
            'vrm'
          record.customAvatarFormat = format
          odkNetInfo('loadPeerAvatar — mounting custom mesh', {
            peer: shortAddr(key),
            format: formatTag(format),
            hash: shortHash(record.vrmContentHash),
            bytes: customBytes.byteLength
          })
          if (format === 'odk') {
            await this.loadOdkPeerAvatar(key, record, customBytes)
          } else {
            await this.loadVrmPeerAvatar(key, record, customBytes)
          }
          return
        }
        odkNetInfo('loadPeerAvatar — waiting for DAV bytes', {
          peer: shortAddr(key),
          format: formatTag(record.customAvatarFormat),
          hash: shortHash(record.vrmContentHash)
        })
        if (!record.placeholder) this.attachLoadingPresentation(record)
        return
      }

      const composed = await composeAvatarFromProfile(profile, this.contentUrl || undefined, this.assetCache)
      stabilizeSkinnedMeshes(composed)

      if (!this.peers.has(key)) {
        this.disposeModel(composed)
        return
      }

      if (record.vrmContentHash) {
        this.disposeModel(composed)
        if (!record.placeholder) this.attachLoadingPresentation(record)
        return
      }

      record.model = composed
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

      this.finalizeNameTag(record)

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
      this.finalizeNameTag(record)
    } finally {
      record.loading = null
    }
  }

  private async loadOdkPeerAvatar(
    key: string,
    record: RemotePeerRecord,
    bytes: ArrayBuffer
  ): Promise<void> {
    try {
      this.disposePeerModel(record)
      if (record.hasPosition) {
        this.attachLoadingPresentation(record)
      }

      const odkAvatar = await OdkAvatar.fromBytes(bytes)
      if (!this.peers.has(key)) {
        odkAvatar.dispose()
        return
      }

      record.odkAvatar = odkAvatar
      record.model = odkAvatar.root
      record.renderMode = 'odk'
      record.vrmLoadedHash = record.vrmContentHash
      record.customAvatarFormat = 'odk'

      this.clearLoadingPresentation(record)
      record.pivot.add(odkAvatar.root)
      applyOdkPivotOffset(record.pivot, odkAvatar.root)

      record.odkLocomotion = new OdkLocomotionAnimations()
      try {
        await record.odkLocomotion.bind(odkAvatar.root)
        odkNetInfo('remote ODK locomotion active', {
          peer: shortAddr(record.address),
          name: record.identity.displayName,
          hash: shortHash(record.vrmContentHash)
        })
      } catch (err) {
        console.warn(`[network] remote ODK locomotion failed for ${record.address}`, err)
        record.odkLocomotion.dispose()
        record.odkLocomotion = null
      }

      this.finalizeNameTag(record)

      odkNetInfo('remote ODK avatar mounted', {
        peer: shortAddr(record.address),
        name: record.identity.displayName,
        hash: shortHash(record.vrmContentHash)
      })
      clientDebugLog.log(
        'network',
        `Remote ODK ready · ${record.identity.displayName} (${record.vrmContentHash?.slice(0, 12)}…)`,
        { level: 'success' }
      )

      if (record.pendingEmote) {
        const pending = record.pendingEmote
        record.pendingEmote = null
        void this.applyPeerEmote(record, pending)
      }
    } catch (err) {
      odkNetWarn('remote ODK load failed — falling back to DCL avatar', {
        peer: shortAddr(record.address),
        hash: shortHash(record.vrmContentHash),
        error: err instanceof Error ? err.message : String(err)
      })
      record.vrmContentHash = null
      record.vrmLoadedHash = null
      record.customAvatarFormat = null
      record.renderMode = 'dcl'
      await this.loadPeerAvatar(key, record)
    }
  }

  private async loadVrmPeerAvatar(
    key: string,
    record: RemotePeerRecord,
    bytes: ArrayBuffer
  ): Promise<void> {
    try {
      this.disposePeerModel(record)
      if (record.hasPosition) {
        this.attachLoadingPresentation(record)
      }

      const vrmAvatar = await VrmAvatar.fromBytes(bytes)
      if (!this.peers.has(key)) {
        vrmAvatar.dispose()
        return
      }

      vrmAvatar.vrm.humanoid.autoUpdateHumanBones = false
      record.vrmAvatar = vrmAvatar
      record.model = vrmAvatar.root
      record.renderMode = 'vrm'
      record.vrmLoadedHash = record.vrmContentHash
      record.customAvatarFormat = 'vrm'

      this.clearLoadingPresentation(record)
      record.pivot.add(vrmAvatar.root)

      record.vrmLocomotion = new VrmLocomotionAnimations()
      try {
        await record.vrmLocomotion.bind(vrmAvatar.vrm, vrmAvatar.root)
        applyVrmPivotOffset(record.pivot, vrmAvatar.vrm, vrmAvatar.root, {
          measureActivePose: true
        })
      } catch (err) {
        console.warn(`[network] remote VRM locomotion failed for ${record.address}`, err)
        record.vrmLocomotion.dispose()
        record.vrmLocomotion = null
        applyVrmPivotOffset(record.pivot, vrmAvatar.vrm, vrmAvatar.root)
      }

      this.finalizeNameTag(record)

      clientDebugLog.log(
        'network',
        `Remote VRM ready · ${record.identity.displayName} (${record.vrmContentHash?.slice(0, 12)}…)`,
        { level: 'success' }
      )

      if (record.pendingEmote) {
        const pending = record.pendingEmote
        record.pendingEmote = null
        void this.applyPeerEmote(record, pending)
      }
    } catch (err) {
      console.warn(`[network] remote VRM load failed for ${record.address}`, err)
      record.vrmContentHash = null
      record.vrmLoadedHash = null
      record.renderMode = 'dcl'
      await this.loadPeerAvatar(key, record)
    }
  }

  private async applyPeerEmote(record: RemotePeerRecord, emoteRef: string): Promise<void> {
    if (!record.model) return

    const normalizedRef = emoteRef.trim().toLowerCase()
    const emoteActive =
      record.renderMode === 'vrm'
        ? record.vrmLocomotion?.isProfileEmoteActive()
        : record.renderMode === 'odk'
          ? record.odkLocomotion?.isProfileEmoteActive()
          : record.animations?.isProfileEmoteActive()
    if (record.activeEmoteUrn === normalizedRef && emoteActive) {
      return
    }

    const peerUrl = this.contentUrl || PEER_URL
    const resolved = await resolveProfileEmote(emoteRef, record.bodyShape, peerUrl)
    if (!resolved) return

    try {
      const cached = this.assetCache ? await loadResolvedProfileEmote(this.assetCache, resolved) : null
      if (!cached?.animations.length) return

      if (record.renderMode === 'vrm' && record.vrmAvatar && record.vrmLocomotion) {
        const clip = retargetGltfClipToVrm(cached.animations[0]!, cached.root, record.vrmAvatar.vrm)
        if (clip.tracks.length === 0) return
        if (record.vrmLocomotion.playProfileEmote(clip, resolved.loop)) {
          record.activeEmoteUrn = resolved.urn.trim().toLowerCase()
        }
        return
      }

      if (record.renderMode === 'odk' && record.odkAvatar && record.odkLocomotion) {
        const clip = retargetGltfClipToOdk(
          cached.animations[0]!,
          cached.root,
          record.odkAvatar.root
        )
        const restCorrection = record.odkLocomotion.getRestCorrection()
        if (restCorrection) applyOdkRestCorrection(clip, restCorrection)
        if (clip.tracks.length === 0) return
        if (record.odkLocomotion.playProfileEmote(clip, resolved.loop)) {
          record.activeEmoteUrn = resolved.urn.trim().toLowerCase()
        }
        return
      }

      if (!record.animations) return
      if (record.animations.playProfileEmoteFromGltf(cached, resolved.loop)) {
        record.activeEmoteUrn = resolved.urn.trim().toLowerCase()
      }
    } catch {
      /* scene / profile emote load failures are expected when assets are unavailable */
    }
  }

  private disposePeerModel(record: RemotePeerRecord): void {
    record.pivot.position.set(0, 0, 0)
    record.animations?.dispose()
    record.animations = null
    record.vrmLocomotion?.dispose()
    record.vrmLocomotion = null
    record.odkLocomotion?.dispose()
    record.odkLocomotion = null
    record.activeEmoteUrn = null
    record.vrmLoadedHash = null
    this.clearLoadingPresentation(record)
    if (record.vrmAvatar) {
      record.pivot.remove(record.vrmAvatar.root)
      record.vrmAvatar.dispose()
      record.vrmAvatar = null
      record.model = null
      record.renderMode = 'dcl'
      return
    }
    if (record.odkAvatar) {
      record.pivot.remove(record.odkAvatar.root)
      record.odkAvatar.dispose()
      record.odkAvatar = null
      record.model = null
      record.renderMode = 'dcl'
      return
    }
    if (record.model) {
      this.disposeModel(record.model as THREE.Group)
      record.model = null
      record.renderMode = 'dcl'
    }
  }

  private disposeModel(model: THREE.Group): void {
    if (model.name === 'custom-vrm') {
      disposeVrmRoot(null, model)
    } else if (model.name === 'custom-odk') {
      disposeOdkRoot(model)
    } else {
      disposeWearableInstance(model)
    }
    model.removeFromParent()
  }
}

const _boxCornerScratch = Array.from({ length: 8 }, () => new THREE.Vector3())

function boxCornerPoints(box: THREE.Box3): THREE.Vector3[] {
  const { min, max } = box
  _boxCornerScratch[0]!.set(min.x, min.y, min.z)
  _boxCornerScratch[1]!.set(max.x, min.y, min.z)
  _boxCornerScratch[2]!.set(min.x, max.y, min.z)
  _boxCornerScratch[3]!.set(max.x, max.y, min.z)
  _boxCornerScratch[4]!.set(min.x, min.y, max.z)
  _boxCornerScratch[5]!.set(max.x, min.y, max.z)
  _boxCornerScratch[6]!.set(min.x, max.y, max.z)
  _boxCornerScratch[7]!.set(max.x, max.y, max.z)
  return _boxCornerScratch
}
