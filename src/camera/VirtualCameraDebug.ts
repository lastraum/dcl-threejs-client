import * as THREE from 'three'
import type { Entity } from '@dcl/ecs'
import { clientDebugLog } from '../client/debug/ClientDebugLog'
export type VcPoseSnapshot = {
  x: number
  y: number
  z: number
}

export type VcRotationSnapshot = {
  yawDeg: number
  pitchDeg: number
}

export type VcLensParityReport = {
  vcEntity: Entity
  /** Three.js display space (what the lens uses). */
  lensPos: VcPoseSnapshot
  lensRot: VcRotationSnapshot | null
  gizmoEntityRot: VcRotationSnapshot | null
  /** ECS world pose resolved on the client projection. */
  ecsWorldPos: VcPoseSnapshot | null
  /** Scene-graph node world position for the VC entity (gizmo mesh), if mounted. */
  gizmoWorldPos: VcPoseSnapshot | null
  /** DCL scene space — matches worker getWorldPosition. */
  ecsDclPos: VcPoseSnapshot | null
  lensEcsDeltaM: number | null
  lensGizmoDeltaM: number | null
  mainCameraVcEntity: Entity | null
  vcTransformLocal: VcPoseSnapshot | null
  vcTransformParent: Entity | null
  vcLookAtEntity: Entity | null
  bridgeActive: boolean
  inactiveReason: string | null
}

function readUrlFlag(name: string): boolean {
  if (typeof window === 'undefined') return false
  return new URLSearchParams(window.location.search).has(name)
}

/** Always log bind + parity mismatches; `?vcdebug` logs every active frame. */
export function vcDebugVerbose(): boolean {
  return readUrlFlag('vcdebug')
}

function fmt(v: VcPoseSnapshot | null): string {
  if (!v) return 'null'
  return `(${v.x.toFixed(2)}, ${v.y.toFixed(2)}, ${v.z.toFixed(2)})`
}

function fmtRot(v: VcRotationSnapshot | null): string {
  if (!v) return 'null'
  return `(yaw=${v.yawDeg.toFixed(1)}° pitch=${v.pitchDeg.toFixed(1)}°)`
}

/** Camera/lens yaw-pitch in Three display space (degrees). */
export function yawPitchFromThreeQuat(q: THREE.Quaternion): VcRotationSnapshot {
  const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(q).normalize()
  const yawDeg = (Math.atan2(forward.x, forward.z) * 180) / Math.PI
  const pitchDeg = (Math.asin(THREE.MathUtils.clamp(forward.y, -1, 1)) * 180) / Math.PI
  return { yawDeg, pitchDeg }
}

/** Entity +Z forward yaw-pitch in Three display space (matches direction cone). */
export function yawPitchFromEntityDisplayQuat(q: THREE.Quaternion): VcRotationSnapshot {
  const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(q).normalize()
  const yawDeg = (Math.atan2(forward.x, forward.z) * 180) / Math.PI
  const pitchDeg = (Math.asin(THREE.MathUtils.clamp(forward.y, -1, 1)) * 180) / Math.PI
  return { yawDeg, pitchDeg }
}

function dist(a: VcPoseSnapshot, b: VcPoseSnapshot): number {
  const dx = a.x - b.x
  const dy = a.y - b.y
  const dz = a.z - b.z
  return Math.sqrt(dx * dx + dy * dy + dz * dz)
}

export function vec3FromThree(v: THREE.Vector3): VcPoseSnapshot {
  return { x: v.x, y: v.y, z: v.z }
}

export function vec3FromDcl(x: number, y: number, z: number): VcPoseSnapshot {
  return { x, y, z }
}

export function logVcLensParity(
  label: string,
  report: VcLensParityReport,
  options?: { throttleMs?: number; force?: boolean }
): void {
  const mismatch =
    report.lensEcsDeltaM !== null && report.lensEcsDeltaM > 0.08
  const level = mismatch || report.inactiveReason ? 'warn' : 'info'
  const force = options?.force === true || mismatch || report.inactiveReason !== null

  clientDebugLog.log(
    'vc-lens',
    [
      `${label}`,
      `vc=e${report.vcEntity}`,
      `main→vc=${report.mainCameraVcEntity ?? 'null'}`,
      `bridgeActive=${report.bridgeActive}`,
      report.inactiveReason ? `inactive=${report.inactiveReason}` : null,
      `lensThree=${fmt(report.lensPos)}`,
      `ecsWorldThree=${fmt(report.ecsWorldPos)}`,
      `gizmoWorldThree=${fmt(report.gizmoWorldPos)}`,
      `ecsDcl=${fmt(report.ecsDclPos)}`,
      report.lensEcsDeltaM !== null ? `Δlens↔ecs=${report.lensEcsDeltaM.toFixed(3)}m` : null,
      report.lensGizmoDeltaM !== null ? `Δlens↔gizmo=${report.lensGizmoDeltaM.toFixed(3)}m` : null,
      report.vcTransformLocal ?
        `vcLocalDcl=${fmt(report.vcTransformLocal)} parent=e${report.vcTransformParent ?? 0}`
      : 'vcLocal=null',
      report.vcLookAtEntity !== null ? `lookAt=e${report.vcLookAtEntity}` : 'lookAt=cleared',
      report.lensRot ? `lensRot=${fmtRot(report.lensRot)}` : null,
      report.gizmoEntityRot ? `gizmoRot=${fmtRot(report.gizmoEntityRot)}` : null
    ]
      .filter(Boolean)
      .join(' '),
    {
      level,
      throttleMs: force ? undefined : (options?.throttleMs ?? 800),
      alsoConsole: true
    }
  )
}

export function logVcWorkerBind(
  vcEntity: Entity,
  poseDcl: VcPoseSnapshot,
  label: string
): void {
  const line = `[vc-lens] worker ${label} vc=e${vcEntity} worldDcl=${fmt(poseDcl)}`
  console.log(line)
}

export function computeLensEcsDelta(
  lens: VcPoseSnapshot,
  ecsWorld: VcPoseSnapshot | null
): number | null {
  if (!ecsWorld) return null
  return dist(lens, ecsWorld)
}