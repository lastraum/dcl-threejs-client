import * as THREE from 'three'
import type { Entity } from '@dcl/ecs'
import type { CrdtProjection } from './CrdtProjection'
import { dclToThreeVec, threeToDclQuat, threeToDclVec } from './dclTransform'
import { feetDclToPlayerEntityPosition } from '../player/dclPlayerEntity'
import type { MirrorComponents } from './mirrorComponents'
import type { ReservedEntities } from './ProjectionView'
import type { PlayerMirrorIdentity } from './playerMirrorIdentity'
import type { CommsRealmInfo } from '../network/comms/types'

export type EntityPose = {
  position: THREE.Vector3
  rotation: THREE.Quaternion
}

const _euler = new THREE.Euler(0, 0, 0, 'YXZ')

/** Client-owned SDK7 entities: Root (0), Player (1), Camera (2). */
export class ReservedEntitiesSync {
  private playerIdentity: PlayerMirrorIdentity | null = null
  private realmInfo: CommsRealmInfo | null = null
  /** Wall-clock when scene reserved entities were first initialized. */
  private sceneStartMs = 0
  private frameNumber = 0
  private tickNumber = 0

  constructor(
    private readonly projection: CrdtProjection,
    private readonly components: MirrorComponents,
    private readonly reserved: ReservedEntities
  ) {}

  setPlayerIdentity(identity: PlayerMirrorIdentity | null): void {
    this.playerIdentity = identity
    if (identity) this.applyPlayerIdentity()
  }

  /** Host-seeded local player mirror (Admin Tools getPlayer / identity parity). */
  getPlayerIdentity(): PlayerMirrorIdentity | null {
    return this.playerIdentity
  }

  /** Seed / refresh `core::RealmInfo` on RootEntity for SDK `@dcl/sdk/network`. */
  setRealmInfo(info: CommsRealmInfo | null): void {
    this.realmInfo = info
    if (info) this.applyRealmInfo()
  }

  /**
   * ADR-148 EngineInfo — written on RootEntity each renderer round-trip.
   * `tickNumber` should match the scene CRDT tick; `frameNumber` is renderer frames.
   */
  setEngineCounters(frameNumber: number, tickNumber: number): void {
    this.frameNumber = Math.max(0, frameNumber | 0)
    this.tickNumber = Math.max(0, tickNumber | 0)
  }

  /** Seed spawn transforms + MainCamera before scene script hydrates from getState. */
  initialize(spawn: { x: number; y: number; z: number }): void {
    this.sceneStartMs = performance.now()
    this.frameNumber = 0
    this.tickNumber = 0
    const { Transform, MainCamera, CameraMode, PointerLock } = this.components
    const identity = {
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0, w: 1 },
      scale: { x: 1, y: 1, z: 1 },
      parent: this.reserved.root
    }
    this.projection.setRenderer(Transform.componentId, this.reserved.root, identity)
    this.applyEngineInfo()

    const feetDcl = dclToThreeVec(new THREE.Vector3(spawn.x, spawn.y, spawn.z))
    const playerEntityDcl = feetDclToPlayerEntityPosition(feetDcl)
    const playerT = {
      position: { x: playerEntityDcl.x, y: playerEntityDcl.y, z: playerEntityDcl.z },
      rotation: { x: 0, y: 0, z: 0, w: 1 },
      scale: { x: 1, y: 1, z: 1 },
      parent: this.reserved.root
    }
    const cameraT = {
      position: { x: spawn.x, y: spawn.y, z: spawn.z },
      rotation: { x: 0, y: 0, z: 0, w: 1 },
      scale: { x: 1, y: 1, z: 1 },
      parent: this.reserved.root
    }
    this.projection.setRenderer(Transform.componentId, this.reserved.player, playerT)
    this.projection.setRenderer(Transform.componentId, this.reserved.camera, cameraT)
    this.projection.setRenderer(MainCamera.componentId, this.reserved.camera, {})
    // CameraEntity #2 — plaza fishing / camera systems call PointerLock.get / CameraMode.get
    // during onStart. Missing components throw Uncaught [getFrom] and abort init (rods never spawn).
    this.projection.setRenderer(CameraMode.componentId, this.reserved.camera, {
      mode: 1 // CT_THIRD_PERSON
    })
    this.projection.setRenderer(PointerLock.componentId, this.reserved.camera, {
      isPointerLocked: false
    })
  }

  syncPlayer(pose: EntityPose): void {
    this.writeTransform(this.reserved.player, pose)
  }

  syncCamera(pose: EntityPose): void {
    this.writeTransform(this.reserved.camera, pose)
  }

  /** Apply latest client poses immediately before a renderer CRDT round-trip. */
  prepareRendererRoundTrip(player: EntityPose, camera: EntityPose): void {
    this.syncPlayer(player)
    this.syncCamera(camera)
    if (this.playerIdentity) this.applyPlayerIdentity()
    if (this.realmInfo) this.applyRealmInfo()
    this.applyEngineInfo()
  }

  private applyPlayerIdentity(): void {
    if (!this.playerIdentity) return
    this.applyPlayerIdentityToEntity(this.reserved.player, this.playerIdentity)
  }

  /**
   * Host-owned player mirror (local reserved PlayerEntity or remote synthetic avatar entity).
   * Scenes read PlayerIdentityData / AvatarBase / AvatarEquippedData via getEntitiesWith.
   */
  applyPlayerIdentityToEntity(entity: Entity, identity: PlayerMirrorIdentity): void {
    const { PlayerIdentityData, AvatarBase, AvatarEquippedData } = this.components
    this.projection.setRenderer(PlayerIdentityData.componentId, entity, {
      address: identity.address,
      isGuest: identity.isGuest
    })
    this.projection.setRenderer(AvatarBase.componentId, entity, {
      name: identity.displayName,
      bodyShapeUrn: identity.bodyShapeUrn,
      skinColor: identity.skinColor,
      hairColor: identity.hairColor,
      eyesColor: identity.eyesColor
    })
    this.projection.setRenderer(AvatarEquippedData.componentId, entity, {
      wearableUrns: identity.wearableUrns,
      emoteUrns: identity.emoteUrns
    })
  }

  /** Drop host-owned identity components when a remote peer leaves. */
  clearPlayerIdentityOnEntity(entity: Entity): void {
    const { PlayerIdentityData, AvatarBase, AvatarEquippedData } = this.components
    const ids = [
      PlayerIdentityData.componentId,
      AvatarBase.componentId,
      AvatarEquippedData.componentId
    ]
    this.projection.clearLwwSlotsForEntities(new Set([entity]), ids)
  }

  private applyRealmInfo(): void {
    const info = this.realmInfo
    if (!info) return
    const { RealmInfo } = this.components
    this.projection.setRenderer(RealmInfo.componentId, this.reserved.root, {
      baseUrl: info.baseUrl || info.domain || '',
      realmName: info.realmName || '',
      networkId: Number.isFinite(info.networkId) ? info.networkId : 1,
      commsAdapter: info.commsAdapter || '',
      isPreview: info.isPreview === true,
      room: info.room,
      isConnectedSceneRoom: info.isConnectedSceneRoom === true
    })
  }

  private applyEngineInfo(): void {
    const { EngineInfo } = this.components
    const start = this.sceneStartMs || performance.now()
    if (!this.sceneStartMs) this.sceneStartMs = start
    const totalRuntime = Math.max(0, (performance.now() - this.sceneStartMs) / 1000)
    this.projection.setRenderer(EngineInfo.componentId, this.reserved.root, {
      frameNumber: this.frameNumber,
      totalRuntime,
      tickNumber: this.tickNumber
    })
  }

  private writeTransform(entity: Entity, pose: EntityPose): void {
    const { Transform } = this.components
    const prev = this.projection.get(Transform.componentId, entity) as
      | { scale?: { x: number; y: number; z: number } }
      | undefined
    this.projection.setRenderer(Transform.componentId, entity, {
      position: { x: pose.position.x, y: pose.position.y, z: pose.position.z },
      rotation: { x: pose.rotation.x, y: pose.rotation.y, z: pose.rotation.z, w: pose.rotation.w },
      scale: prev?.scale ?? { x: 1, y: 1, z: 1 },
      parent: this.reserved.root
    })
  }

  /** Debug helper — yaw-only player rotation in SDK space. */
  static playerRotationFromYaw(yaw: number): THREE.Quaternion {
    _euler.set(0, yaw, 0)
    return new THREE.Quaternion().setFromEuler(_euler)
  }

  static cameraPose(camera: THREE.Camera): EntityPose {
    return {
      position: threeToDclVec(camera.position),
      rotation: threeToDclQuat(camera.quaternion)
    }
  }
}
