import type { Entity, IEngine } from '@dcl/ecs'
import * as extended from '@dcl/ecs/dist/components'
import * as generated from '@dcl/ecs/dist/components/generated/index.gen'
import { getWorldPosition, getWorldRotation } from '@dcl/sdk/ecs'
import { Quaternion, Vector3 } from '@dcl/sdk/math'

export type VcWorldPose = {
  position: { x: number; y: number; z: number }
  rotation: Quaternion
}

export type VcPoseCache = {
  cameraEntity: Entity
  position: { x: number; y: number; z: number }
  yawDeg: number
  pitchDeg: number
  rollDeg: number
}

export type MainCameraBindValue = {
  virtualCameraEntity?: Entity | null
}

/** ECS Transform world pose — single source of truth for lens + gizmo origin. */
export function readVcWorldPose(engine: IEngine, cameraEntity: Entity): VcWorldPose {
  const p = getWorldPosition(engine, cameraEntity)
  return {
    position: { x: p.x, y: p.y, z: p.z },
    rotation: getWorldRotation(engine, cameraEntity)
  }
}

export function readVcRotationQuaternion(engine: IEngine, cameraEntity: Entity): Quaternion {
  return getWorldRotation(engine, cameraEntity)
}

export function writeVcWorldPoseUnderRoot(engine: IEngine, cameraEntity: Entity, pose: VcWorldPose): void {
  const Transform = extended.Transform(engine)
  const pos = Vector3.create(pose.position.x, pose.position.y, pose.position.z)
  const scale = Vector3.create(1, 1, 1)
  if (!Transform.getOrNull(cameraEntity)) {
    Transform.createOrReplace(cameraEntity, {
      parent: engine.RootEntity,
      position: pos,
      rotation: pose.rotation,
      scale
    })
    return
  }
  const tr = Transform.getMutable(cameraEntity)
  tr.parent = engine.RootEntity
  tr.position = pos
  tr.rotation = pose.rotation
  tr.scale = scale
}

export function reparentVcPreserveWorldUnderRoot(engine: IEngine, cameraEntity: Entity): boolean {
  const Transform = extended.Transform(engine)
  const tr = Transform.getOrNull(cameraEntity)
  if (!tr || tr.parent === engine.RootEntity) return false
  writeVcWorldPoseUnderRoot(engine, cameraEntity, readVcWorldPose(engine, cameraEntity))
  return true
}

export function publishVcWorldPoseUnderRoot(engine: IEngine, cameraEntity: Entity): void {
  writeVcWorldPoseUnderRoot(engine, cameraEntity, readVcWorldPose(engine, cameraEntity))
}

export function rigEulerToQuaternion(yawDeg: number, pitchDeg: number, rollDeg = 0): Quaternion {
  return Quaternion.fromEulerDegrees(-pitchDeg, yawDeg, rollDeg)
}

export function worldYawPitchFromForward(
  position: { x: number; y: number; z: number },
  rotation: Quaternion
): { yawDeg: number; pitchDeg: number } {
  const f = Vector3.rotate(Vector3.Forward(), rotation)
  const mag = Math.hypot(f.x, f.y, f.z)
  if (mag < 1e-4) return { yawDeg: 0, pitchDeg: 0 }
  const fx = f.x / mag
  const fy = f.y / mag
  const fz = f.z / mag
  return worldYawPitchFromLookAt(position, {
    x: position.x + fx * 6,
    y: position.y + fy * 6,
    z: position.z + fz * 6
  })
}

export function worldYawPitchFromLookAt(
  position: { x: number; y: number; z: number },
  lookAt: { x: number; y: number; z: number }
): { yawDeg: number; pitchDeg: number } {
  const dx = lookAt.x - position.x
  const dy = lookAt.y - position.y
  const dz = lookAt.z - position.z
  const yawRad = Math.atan2(dx, dz)
  const dist = Math.sqrt(dx * dx + dz * dz)
  const pitchRad = Math.atan2(dy, Math.max(1e-5, dist))
  return { yawDeg: (yawRad * 180) / Math.PI, pitchDeg: (pitchRad * 180) / Math.PI }
}

export function syncRigCacheFromEcs(engine: IEngine, camera: VcPoseCache): void {
  const pose = readVcWorldPose(engine, camera.cameraEntity)
  camera.position.x = pose.position.x
  camera.position.y = pose.position.y
  camera.position.z = pose.position.z
  const aim = worldYawPitchFromForward(pose.position, pose.rotation)
  camera.yawDeg = aim.yawDeg
  camera.pitchDeg = aim.pitchDeg
  camera.rollDeg = 0
}

export function pushRigEulerToEcs(
  engine: IEngine,
  camera: VcPoseCache,
  opts?: { identityRotation?: boolean }
): void {
  writeVcWorldPoseUnderRoot(engine, camera.cameraEntity, {
    position: { ...camera.position },
    rotation:
      opts?.identityRotation ?
        Quaternion.Identity()
      : rigEulerToQuaternion(camera.yawDeg, camera.pitchDeg, camera.rollDeg)
  })
}

export function horizontalYawRadFromRotation(rotation: Quaternion): number {
  const f = Vector3.rotate(Vector3.Forward(), rotation)
  return Math.atan2(f.x, f.z)
}

export function commitVcPoseForLensBind(engine: IEngine, camera: VcPoseCache): void {
  publishVcWorldPoseUnderRoot(engine, camera.cameraEntity)
  syncRigCacheFromEcs(engine, camera)
}

/**
 * Before MainCamera binds CameraEntity → VC: ensure VirtualCamera + Transform exist and
 * world pose is published under RootEntity (client lens reads this via CRDT).
 */
export function prepareVcForMainCameraBind(
  engine: IEngine,
  cameraEntity: Entity,
  value: MainCameraBindValue | null | undefined
): void {
  if (cameraEntity !== engine.CameraEntity) return
  const vcEntity = value?.virtualCameraEntity
  if (vcEntity === undefined || vcEntity === null) return

  const Transform = extended.Transform(engine)
  const VirtualCamera = generated.VirtualCamera(engine)

  if (!VirtualCamera.has(vcEntity)) {
    VirtualCamera.createOrReplace(vcEntity, {})
  }

  if (!Transform.has(vcEntity)) {
    Transform.createOrReplace(vcEntity, {
      parent: engine.RootEntity,
      position: Vector3.create(0, 0, 0),
      rotation: Quaternion.Identity(),
      scale: Vector3.create(1, 1, 1)
    })
    return
  }

  publishVcWorldPoseUnderRoot(engine, vcEntity)
}

/** Scene helper — bind explorer camera to a virtual camera (instant cut). */
export function bindMainCameraToVirtualCamera(
  engine: IEngine,
  virtualEntity: Entity,
  transitionSeconds = 0
): void {
  prepareVcForMainCameraBind(engine, engine.CameraEntity, { virtualCameraEntity: virtualEntity })
  const VirtualCamera = generated.VirtualCamera(engine)
  const MainCamera = generated.MainCamera(engine)
  if (VirtualCamera.has(virtualEntity)) {
    const vc = VirtualCamera.getMutable(virtualEntity)
    vc.defaultTransition = {
      transitionMode: { $case: 'time' as const, time: Math.max(0, transitionSeconds) }
    }
  }
  MainCamera.createOrReplace(engine.CameraEntity, { virtualCameraEntity: virtualEntity })
  const pose = readVcWorldPose(engine, virtualEntity)
  console.log(
    `[vc-lens] worker bindMainCamera vc=e${virtualEntity} worldDcl=(${pose.position.x.toFixed(2)}, ${pose.position.y.toFixed(2)}, ${pose.position.z.toFixed(2)})`
  )
}

export function clearMainCameraVirtualCamera(engine: IEngine): void {
  const MainCamera = generated.MainCamera(engine)
  MainCamera.createOrReplace(engine.CameraEntity, {})
}