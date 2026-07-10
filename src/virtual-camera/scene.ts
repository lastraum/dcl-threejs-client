/**
 * SDK7 scene facade — uses the scene singleton `engine` from @dcl/sdk/ecs.
 * In ThreejsClient the same module is injected via worker requireMap as `@lastslice/virtual-camera/scene`.
 */
import { engine, type Entity } from '@dcl/sdk/ecs'
import type { Quaternion } from '@dcl/sdk/math'
import * as core from './core'

export type { VcPoseCache, VcWorldPose } from './core'

export const readVcWorldPose = (cameraEntity: Entity) => core.readVcWorldPose(engine, cameraEntity)
export const readVcRotationQuaternion = (cameraEntity: Entity): Quaternion =>
  core.readVcRotationQuaternion(engine, cameraEntity)
export const writeVcWorldPoseUnderRoot = (cameraEntity: Entity, pose: core.VcWorldPose) =>
  core.writeVcWorldPoseUnderRoot(engine, cameraEntity, pose)
export const reparentVcPreserveWorldUnderRoot = (cameraEntity: Entity) =>
  core.reparentVcPreserveWorldUnderRoot(engine, cameraEntity)
export const publishVcWorldPoseUnderRoot = (cameraEntity: Entity) =>
  core.publishVcWorldPoseUnderRoot(engine, cameraEntity)
export const rigEulerToQuaternion = core.rigEulerToQuaternion
export const worldYawPitchFromForward = core.worldYawPitchFromForward
export const worldYawPitchFromLookAt = core.worldYawPitchFromLookAt
export const syncRigCacheFromEcs = (camera: core.VcPoseCache) => core.syncRigCacheFromEcs(engine, camera)
export const pushRigEulerToEcs = (camera: core.VcPoseCache, opts?: { identityRotation?: boolean }) =>
  core.pushRigEulerToEcs(engine, camera, opts)
export const horizontalYawRadFromRotation = core.horizontalYawRadFromRotation
export const commitVcPoseForLensBind = (camera: core.VcPoseCache) =>
  core.commitVcPoseForLensBind(engine, camera)
export const bindMainCameraToVirtualCamera = (virtualEntity: Entity, transitionSeconds = 0) =>
  core.bindMainCameraToVirtualCamera(engine, virtualEntity, transitionSeconds)
export const clearMainCameraVirtualCamera = () => core.clearMainCameraVirtualCamera(engine)