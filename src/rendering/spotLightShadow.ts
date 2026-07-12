import type * as THREE from 'three'
import { renderQuality } from './RenderQualitySettings'

/** Shared spot-light shadow settings — called when LightManager enables castShadow. */
export function configureSpotLightShadow(light: THREE.SpotLight): void {
  const size = renderQuality.getShadowMapSize()
  if (size <= 0) {
    light.castShadow = false
    return
  }
  light.shadow.mapSize.set(size, size)
  light.shadow.bias = -0.0002
  light.shadow.normalBias = 0.02
  light.shadow.radius = renderQuality.getShadowQuality() === 'ultra' ? 3 : 2
}
