import * as THREE from 'three'
import { renderQuality, SHADOW_MAP_SIZE } from './RenderQualitySettings'

/** Ortho half-extent (m) for sun shadow frustum around the focus point. */
const SUN_SHADOW_EXTENT_M = 48
/** Distance along sun direction from focus to the light. */
const SUN_SHADOW_DISTANCE_M = 90
const _focus = new THREE.Vector3()
const _dir = new THREE.Vector3()

/**
 * Soft directional sun shadows (Unity Explorer Directional Light: Soft shadows).
 * One cascade-style ortho map following the camera/player focus.
 */
export function configureDirectionalSunShadow(light: THREE.DirectionalLight): void {
  light.castShadow = true
  const size = SHADOW_MAP_SIZE[renderQuality.getTier()]
  light.shadow.mapSize.set(size, size)
  light.shadow.bias = -0.00025
  light.shadow.normalBias = 0.04
  light.shadow.radius = 3.5
  light.shadow.autoUpdate = true

  const cam = light.shadow.camera as THREE.OrthographicCamera
  cam.near = 0.5
  cam.far = SUN_SHADOW_DISTANCE_M * 2.2
  cam.left = -SUN_SHADOW_EXTENT_M
  cam.right = SUN_SHADOW_EXTENT_M
  cam.top = SUN_SHADOW_EXTENT_M
  cam.bottom = -SUN_SHADOW_EXTENT_M
  cam.updateProjectionMatrix()
}

/** Re-center the sun light + ortho shadow camera on the play focus (camera). */
export function updateDirectionalSunShadowFocus(
  light: THREE.DirectionalLight,
  focusWorld: THREE.Vector3,
  sunDirFromSurface: THREE.Vector3,
  enabled: boolean
): void {
  if (!enabled) {
    light.castShadow = false
    return
  }
  light.castShadow = true
  _focus.copy(focusWorld)
  _dir.copy(sunDirFromSurface).normalize()
  // Directional light "from" the sun toward the scene: place light along +dir from focus.
  light.target.position.copy(_focus)
  light.position.copy(_focus).addScaledVector(_dir, SUN_SHADOW_DISTANCE_M)
  light.target.updateMatrixWorld()
  light.shadow.camera.updateMatrixWorld()
}

export function refreshDirectionalSunShadowMapSize(light: THREE.DirectionalLight): void {
  if (!light.castShadow) return
  const size = SHADOW_MAP_SIZE[renderQuality.getTier()]
  if (light.shadow.mapSize.x !== size) {
    light.shadow.mapSize.set(size, size)
    light.shadow.map?.dispose()
    light.shadow.map = null
  }
}
