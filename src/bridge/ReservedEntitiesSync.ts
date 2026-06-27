import * as THREE from 'three'
import type { Entity } from '@dcl/ecs'
import type { CrdtProjection } from './CrdtProjection'
import { dclToThreeVec, threeToDclQuat, threeToDclVec } from './dclTransform'
import { feetDclToPlayerEntityPosition } from '../player/dclPlayerEntity'
import type { MirrorComponents } from './mirrorComponents'
import type { ReservedEntities } from './ProjectionView'
import type { PlayerMirrorIdentity } from './playerMirrorIdentity'

export type EntityPose = {
  position: THREE.Vector3
  rotation: THREE.Quaternion
}

const _euler = new THREE.Euler(0, 0, 0, 'YXZ')

/** Client-owned SDK7 entities: Root (0), Player (1), Camera (2). */
export class ReservedEntitiesSync {
  private playerIdentity: PlayerMirrorIdentity | null = null

  constructor(
    private readonly projection: CrdtProjection,
    private readonly components: MirrorComponents,
    private readonly reserved: ReservedEntities
  ) {}

  setPlayerIdentity(identity: PlayerMirrorIdentity | null): void {
    this.playerIdentity = identity
    if (identity) this.applyPlayerIdentity()
  }

  /** Seed spawn transforms + MainCamera before scene script hydrates from getState. */
  initialize(spawn: { x: number; y: number; z: number }): void {
    const { Transform, MainCamera } = this.components
    const identity = {
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0, w: 1 },
      scale: { x: 1, y: 1, z: 1 },
      parent: this.reserved.root
    }
    this.projection.setRenderer(Transform.componentId, this.reserved.root, identity)

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
  }

  private applyPlayerIdentity(): void {
    const identity = this.playerIdentity
    if (!identity) return

    const { PlayerIdentityData, AvatarBase, AvatarEquippedData } = this.components
    const entity = this.reserved.player

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
