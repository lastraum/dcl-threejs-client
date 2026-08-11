/**
 * Client-wide camera near/far policy (platform law).
 *
 * Largest workable near + smallest workable far improves depth precision
 * (see Three.js Roadmap z-fighting guide). No scene-name forks; VC and freecam share this.
 */
import type * as THREE from 'three'

/** Default perspective near — do not drop to 0.001 “for safety”. */
export const CLIENT_CAMERA_NEAR = 0.1

/**
 * Close freecam / over-shoulder — smaller near so hair, face, and hands are not
 * sliced by the near plane when boom is ~0.5–2 m behind the head.
 */
export const CLIENT_CAMERA_NEAR_CLOSE = 0.04

/** Floor on far when sizing from world bounds. */
export const CLIENT_CAMERA_FAR_MIN = 800

/**
 * Near plane vs freecam boom distance (m). Close zoom → tighter near.
 */
export function clientCameraNearForBoomDistance(distM: number): number {
  if (!Number.isFinite(distM) || distM <= 0.4) return CLIENT_CAMERA_NEAR_CLOSE
  if (distM >= 3.5) return CLIENT_CAMERA_NEAR
  // Lerp 0.4 → 3.5 m
  const t = (distM - 0.4) / (3.5 - 0.4)
  const s = t * t * (3 - 2 * t)
  return CLIENT_CAMERA_NEAR_CLOSE + (CLIENT_CAMERA_NEAR - CLIENT_CAMERA_NEAR_CLOSE) * s
}

/**
 * Apply platform near/far to a perspective camera and refresh the projection matrix.
 * @param farHint preferred far (world diagonal etc.); clamped to CLIENT_CAMERA_FAR_MIN minimum
 */
export function applyClientCameraDepth(
  camera: THREE.PerspectiveCamera,
  opts?: { near?: number; far?: number }
): void {
  const near = opts?.near ?? CLIENT_CAMERA_NEAR
  camera.near = Math.max(CLIENT_CAMERA_NEAR_CLOSE, near)
  if (opts?.far !== undefined && Number.isFinite(opts.far)) {
    camera.far = Math.max(CLIENT_CAMERA_FAR_MIN, opts.far)
  }
  camera.updateProjectionMatrix()
}

/** Far from axis-aligned world footprint (plaza / multi-parcel). */
export function farFromWorldDiagonal(width: number, depth: number, scale = 1.25): number {
  const diagonal = Math.hypot(width, depth)
  return Math.max(CLIENT_CAMERA_FAR_MIN, diagonal * scale)
}
