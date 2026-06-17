import * as THREE from 'three'
import { renderQuality, SHADOW_MAP_SIZE } from './RenderQualitySettings'

/** Shared spot-light shadow settings — called when LightManager enables castShadow. */
export function configureSpotLightShadow(light: THREE.SpotLight): void {
  const size = SHADOW_MAP_SIZE[renderQuality.getTier()]
  light.shadow.mapSize.set(size, size)
  light.shadow.camera.near = 0.25
  light.shadow.camera.far = Math.max(light.distance, 1)
  light.shadow.bias = -0.0001
  light.shadow.normalBias = 0.015
  light.shadow.radius = 2
}
