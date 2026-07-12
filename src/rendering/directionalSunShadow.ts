import * as THREE from 'three'
import { renderQuality, RenderQualityTier, SHADOW_MAP_SIZE } from './RenderQualitySettings'

/** Ortho half-extent (m) around focus — wider = softer large-area contact, less dense texels. */
const SUN_SHADOW_EXTENT_M: Record<RenderQualityTier, number> = {
  [RenderQualityTier.Low]: 36,
  [RenderQualityTier.Medium]: 52,
  [RenderQualityTier.High]: 60
}
/** Distance along sun direction from focus to the light. */
const SUN_SHADOW_DISTANCE_M = 100
/** PCF blur radius — higher = broader, softer edges (Unity soft directional feel). */
const SUN_SHADOW_RADIUS: Record<RenderQualityTier, number> = {
  [RenderQualityTier.Low]: 2.5,
  [RenderQualityTier.Medium]: 4,
  [RenderQualityTier.High]: 5
}

const _focus = new THREE.Vector3()
const _dir = new THREE.Vector3()

/**
 * Soft directional sun/moon shadows (Unity Explorer Directional Light: Soft).
 * Single ortho map following the camera focus — not full cascades (cost).
 */
export function configureDirectionalSunShadow(light: THREE.DirectionalLight): void {
  light.castShadow = true
  applyDirectionalShadowQuality(light)
  light.shadow.autoUpdate = true
}

function applyDirectionalShadowQuality(light: THREE.DirectionalLight): void {
  const tier = renderQuality.getTier()
  const size = SHADOW_MAP_SIZE[tier]
  const extent = SUN_SHADOW_EXTENT_M[tier]
  light.shadow.mapSize.set(size, size)
  // Slightly positive-leaning normal bias + small constant bias reduces acne without
  // lifting shadows off the ground (peter-panning) as badly as large constant bias alone.
  light.shadow.bias = -0.00012
  light.shadow.normalBias = 0.035
  light.shadow.radius = SUN_SHADOW_RADIUS[tier]

  const cam = light.shadow.camera as THREE.OrthographicCamera
  cam.near = 1
  cam.far = SUN_SHADOW_DISTANCE_M * 2.4
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
  if (!enabled) {
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
  if (!light.castShadow && !light.shadow.map) return
  const size = SHADOW_MAP_SIZE[renderQuality.getTier()]
  if (light.shadow.mapSize.x !== size) {
    light.shadow.mapSize.set(size, size)
    light.shadow.map?.dispose()
    light.shadow.map = null
    applyDirectionalShadowQuality(light)
  }
}
