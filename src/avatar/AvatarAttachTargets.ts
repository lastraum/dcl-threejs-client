import * as THREE from 'three'
import type { Entity } from '@dcl/ecs'
import type { DclTransformValues } from '../bridge/dclTransform'

export type AvatarSkeletonTarget = {
  model: THREE.Object3D
  nameTagAnchor: THREE.Object3D
}

/** Runtime hooks for resolving attach targets (local player, remotes, NPCs). */
export type AvatarAttachTargetResolver = {
  getLocalWallet(): string | undefined
  getLocalSkeleton(): AvatarSkeletonTarget | null
  getRemoteSkeleton(avatarId: string): AvatarSkeletonTarget | null
  getNpcSkeleton(entity: Entity): AvatarSkeletonTarget | null
  /** Player feet / PlayerEntity transform in DCL meters (SDK `findPlayerTransform`). */
  getPlayerTransformDcl(avatarId: string | undefined): DclTransformValues | null
}