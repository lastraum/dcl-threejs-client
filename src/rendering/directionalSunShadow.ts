import * as THREE from 'three'
import { AOI_SHELL_KEEP_M } from '../dcl/multiScene/caps'
import { renderQuality, type ShadowQuality, SHADOW_MAP_SIZE } from './RenderQualitySettings'

/** Ortho half-extent (m) around focus — tracks the visual keep band, not 200 m. */
const SUN_SHADOW_EXTENT_M: Record<Exclude<ShadowQuality, 'off'>, number> = {
  low: 32,
  medium: 40,
  high: 48,
  ultra: 56
}
/** Light sits this far along the sun from the player — same as neighbor visual keep. */
const SUN_SHADOW_DISTANCE_M = AOI_SHELL_KEEP_M
/** PCF blur radius — higher = broader, softer edges (Unity soft directional feel). */
const SUN_SHADOW_RADIUS: Record<Exclude<ShadowQuality, 'off'>, number> = {
  low: 2.5,
  medium: 4,
  high: 5,
  ultra: 6
}

const _focus = new THREE.Vector3()
const _dir = new THREE.Vector3()

/**
 * Soft directional sun/moon shadows (Unity Explorer Directional Light: Soft).
 * Single ortho map following the camera focus — not full cascades (cost).
 */
export function configureDirectionalSunShadow(light: THREE.DirectionalLight): void {
  if (!renderQuality.shadowsEnabled()) {
    light.castShadow = false
    return
  }
  light.castShadow = true
  applyDirectionalShadowQuality(light)
  light.shadow.autoUpdate = true
}

function applyDirectionalShadowQuality(light: THREE.DirectionalLight): void {
  const q = renderQuality.getShadowQuality()
  if (q === 'off') {
    light.castShadow = false
    return
  }
  const size = SHADOW_MAP_SIZE[q]
  const extent = SUN_SHADOW_EXTENT_M[q]
  light.shadow.mapSize.set(size, size)
  // Slightly positive-leaning normal bias + small constant bias reduces acne without
  // lifting shadows off the ground (peter-panning) as badly as large constant bias alone.
  light.shadow.bias = -0.00012
  light.shadow.normalBias = 0.035
  light.shadow.radius = SUN_SHADOW_RADIUS[q]

  const cam = light.shadow.camera as THREE.OrthographicCamera
  cam.near = 1
  cam.far = AOI_SHELL_KEEP_M * 2
  cam.left = -extent
  cam.right = extent
  cam.top = extent
  cam.bottom = -extent
  cam.updateProjectionMatrix()
}

/** Re-center the light + ortho shadow camera on the play focus (camera). */
export function updateDirectionalSunShadowFocus(
  light: THREE.DirectionalLight,
  focusWorld: THREE.Vector3,
  sunDirFromSurface: THREE.Vector3,
  enabled: boolean
): void {
  if (!enabled || !renderQuality.shadowsEnabled()) {
    light.castShadow = false
    return
  }
  light.castShadow = true
  applyDirectionalShadowQuality(light)

  _focus.copy(focusWorld)
  _dir.copy(sunDirFromSurface).normalize()
  // Place light along celestial direction from focus so the ortho frustum covers the player.
  light.target.position.copy(_focus)
  light.position.copy(_focus).addScaledVector(_dir, SUN_SHADOW_DISTANCE_M)
  light.target.updateMatrixWorld()
  light.updateMatrixWorld()
  light.shadow.camera.updateMatrixWorld()
  light.shadow.camera.updateProjectionMatrix()
}

export function refreshDirectionalSunShadowMapSize(light: THREE.DirectionalLight): void {
  if (!renderQuality.shadowsEnabled()) {
    light.castShadow = false
    return
  }
  if (!light.castShadow && !light.shadow.map) return
  const size = renderQuality.getShadowMapSize()
  if (size <= 0) {
    light.castShadow = false
    return
  }
  if (light.shadow.mapSize.x !== size) {
    light.shadow.mapSize.set(size, size)
    light.shadow.map?.dispose()
    light.shadow.map = null
    applyDirectionalShadowQuality(light)
  }
}
