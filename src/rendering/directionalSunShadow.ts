import * as THREE from 'three'
import { renderQuality, type ShadowQuality, SHADOW_MAP_SIZE } from './RenderQualitySettings'

function shadowKeepM(): number {
  const slider = renderQuality.getShadowsDistanceM()
  if (slider <= 0) return 0
  return Math.max(16, slider)
}

function shadowExtentM(quality: Exclude<ShadowQuality, 'off'>): number {
  const keep = shadowKeepM()
  if (keep <= 0) return 0
  const byQuality = { low: 0.4, medium: 0.5, high: 0.56, ultra: 0.7 }[quality]
  return Math.max(16, keep * byQuality)
}
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
  light.shadow.autoUpdate = false
  light.shadow.needsUpdate = true
}

const _lastFocus = new THREE.Vector3()
const _lastSun = new THREE.Vector3()
let lastShadowFocusAt = 0
const SHADOW_RECAST_MOVE_M = 2.4
const SHADOW_RECAST_MS = 250

function applyDirectionalShadowQuality(light: THREE.DirectionalLight): void {
  const q = renderQuality.getShadowQuality()
  if (q === 'off') {
    light.castShadow = false
    return
  }
  const size = SHADOW_MAP_SIZE[q]
  const keep = shadowKeepM()
  const extent = keep > 0 ? shadowExtentM(q) : 16
  const lightDist = keep > 0 ? keep : 32
  light.shadow.mapSize.set(size, size)
  // Slightly positive-leaning normal bias + small constant bias reduces acne without
  // lifting shadows off the ground (peter-panning) as badly as large constant bias alone.
  light.shadow.bias = -0.00012
  light.shadow.normalBias = 0.035
  light.shadow.radius = SUN_SHADOW_RADIUS[q]

  const cam = light.shadow.camera as THREE.OrthographicCamera
  cam.near = 1
  cam.far = lightDist * 2
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
  const keep = shadowKeepM()
  light.position.copy(_focus).addScaledVector(_dir, keep > 0 ? keep : 32)
  light.target.updateMatrixWorld()
  light.updateMatrixWorld()
  light.shadow.camera.updateMatrixWorld()
  light.shadow.camera.updateProjectionMatrix()

  const now = performance.now()
  const moved = _lastFocus.distanceToSquared(_focus) > SHADOW_RECAST_MOVE_M * SHADOW_RECAST_MOVE_M
  const sunTurned = _lastSun.distanceToSquared(_dir) > 0.0004
  if (moved || sunTurned || now - lastShadowFocusAt >= SHADOW_RECAST_MS) {
    light.shadow.needsUpdate = true
    _lastFocus.copy(_focus)
    _lastSun.copy(_dir)
    lastShadowFocusAt = now
  }
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
