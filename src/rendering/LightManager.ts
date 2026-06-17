import * as THREE from 'three'
import type { LightSourceMeta } from '../bridge/LightSourceSync'
import {
  LIGHT_CULL_DISTANCE_M,
  MAX_SHADOW_SPOT_LIGHTS,
  renderQuality
} from './RenderQualitySettings'
import { configureSpotLightShadow } from './spotLightShadow'

type Candidate = {
  light: THREE.PointLight | THREE.SpotLight
  distSq: number
  meta: LightSourceMeta
}

/** Distance + quality-tier culling for ECS LightSource lights (does not create lights). */
export class LightManager {
  private readonly scene: THREE.Scene
  private readonly viewPos = new THREE.Vector3()
  private readonly worldPos = new THREE.Vector3()
  private readonly cullDistSq = LIGHT_CULL_DISTANCE_M * LIGHT_CULL_DISTANCE_M
  private activeNearbyCount = 0

  constructor(scene: THREE.Scene) {
    this.scene = scene
  }

  /** ECS lights active this frame (within cull distance, nearest tier cap). */
  getActiveNearbyCount(): number {
    return this.activeNearbyCount
  }

  /** Re-evaluate which managed lights are visible and may cast shadows. */
  update(viewPosition: THREE.Vector3): void {
    this.viewPos.copy(viewPosition)
    const maxLights = renderQuality.getMaxActiveLights()
    const candidates: Candidate[] = []

    this.scene.traverse((obj) => {
      if (!(obj instanceof THREE.PointLight || obj instanceof THREE.SpotLight)) return

      const meta = obj.userData.lightSource as LightSourceMeta | undefined
      if (!meta) return

      if (!meta.ecsActive) {
        obj.visible = false
        obj.castShadow = false
        return
      }

      obj.getWorldPosition(this.worldPos)
      const distSq = this.viewPos.distanceToSquared(this.worldPos)
      if (distSq > this.cullDistSq) {
        obj.visible = false
        obj.castShadow = false
        return
      }

      candidates.push({ light: obj, distSq, meta })
    })

    candidates.sort((a, b) => a.distSq - b.distSq)

    let shadowSlots = MAX_SHADOW_SPOT_LIGHTS
    let activeCount = 0
    for (let i = 0; i < candidates.length; i++) {
      const { light, meta } = candidates[i]
      const active = i < maxLights
      if (active) activeCount++
      light.visible = active
      if (!active) {
        light.castShadow = false
        continue
      }
      if (meta.isSpot && meta.wantsShadow && shadowSlots > 0 && light instanceof THREE.SpotLight) {
        configureSpotLightShadow(light)
        light.castShadow = true
        shadowSlots--
      } else {
        light.castShadow = false
      }
    }
    this.activeNearbyCount = activeCount
  }
}
