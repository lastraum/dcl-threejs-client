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
  /** Avatar (or fallback camera) focus used for nearest-N + distance cull. */
  private readonly focusPos = new THREE.Vector3()
  private readonly lastCullFocus = new THREE.Vector3()
  private readonly worldPos = new THREE.Vector3()
  private readonly cullDistSq = LIGHT_CULL_DISTANCE_M * LIGHT_CULL_DISTANCE_M
  private activeNearbyCount = 0
  private lastCullAt = 0
  /**
   * Registered ECS lights — avoids full scene.traverse on every walk cull
   * (CBD ~4k meshes made traverse the silent walk-tax).
   */
  private readonly registered = new Set<THREE.PointLight | THREE.SpotLight>()
  /** Re-cull when focus moves this far (m²). Was 0.85² — walk re-culled constantly. */
  private static readonly FOCUS_MOVE_M2 = 2.5 * 2.5
  /** Max time between full light culls while standing still (ms). */
  private static readonly CULL_INTERVAL_MS = 250

  constructor(scene: THREE.Scene) {
    this.scene = scene
    // Bridge LightSourceSync without a hard import cycle.
    scene.userData.dclRegisterLight = (light: THREE.PointLight | THREE.SpotLight) => {
      this.registerLight(light)
    }
    scene.userData.dclUnregisterLight = (light: THREE.PointLight | THREE.SpotLight) => {
      this.unregisterLight(light)
    }
  }

  /** Call when an ECS LightSource light is created or replaced. */
  registerLight(light: THREE.PointLight | THREE.SpotLight): void {
    this.registered.add(light)
  }

  /** Call when light is removed from the scene graph. */
  unregisterLight(light: THREE.PointLight | THREE.SpotLight): void {
    this.registered.delete(light)
  }

  /** ECS lights active this frame (within cull distance, nearest tier cap). */
  getActiveNearbyCount(): number {
    return this.activeNearbyCount
  }

  /**
   * Re-evaluate which managed lights are visible and may cast shadows.
   * @param focusPosition Avatar world position (prefer feet/root) — not the camera.
   * Phase C: skip full scene.traverse when focus is still (dirty-gated).
   */
  update(focusPosition: THREE.Vector3): void {
    const now = performance.now()
    const moved =
      this.lastCullAt <= 0 ||
      this.lastCullFocus.distanceToSquared(focusPosition) > LightManager.FOCUS_MOVE_M2
    if (!moved && now - this.lastCullAt < LightManager.CULL_INTERVAL_MS) {
      return
    }
    this.lastCullAt = now
    this.lastCullFocus.copy(focusPosition)
    this.focusPos.copy(focusPosition)
    const maxLights = renderQuality.getMaxActiveLights()
    const shadowsOn = renderQuality.shadowsEnabled()
    const candidates: Candidate[] = []

    // One-time / sparse discovery: seed registry from scene when empty (hydration).
    if (this.registered.size === 0) {
      this.scene.traverse((obj) => {
        if (!(obj instanceof THREE.PointLight || obj instanceof THREE.SpotLight)) return
        if (!obj.userData.lightSource) return
        this.registered.add(obj)
      })
    }

    for (const light of [...this.registered]) {
      if (!light.parent) {
        this.registered.delete(light)
        continue
      }
      const meta = light.userData.lightSource as LightSourceMeta | undefined
      if (!meta) {
        this.registered.delete(light)
        continue
      }

      if (!meta.ecsActive || maxLights <= 0) {
        light.visible = false
        light.castShadow = false
        continue
      }
      if (meta.skipCull) {
        light.visible = true
        light.castShadow = false
        continue
      }

      light.getWorldPosition(this.worldPos)
      const distSq = this.focusPos.distanceToSquared(this.worldPos)
      if (distSq > this.cullDistSq) {
        light.visible = false
        light.castShadow = false
        continue
      }

      candidates.push({ light, distSq, meta })
    }

    if (maxLights <= 0) {
      this.activeNearbyCount = 0
      return
    }

    candidates.sort((a, b) => a.distSq - b.distSq)

    let shadowSlots = shadowsOn ? MAX_SHADOW_SPOT_LIGHTS : 0
    let activeCount = 0
    for (let i = 0; i < candidates.length; i++) {
      const { light, meta } = candidates[i]!
      const active = i < maxLights
      if (active) activeCount++
      light.visible = active
      if (!active) {
        light.castShadow = false
        continue
      }
      if (meta.isSpot && meta.wantsShadow && shadowSlots > 0 && light instanceof THREE.SpotLight) {
        configureSpotLightShadow(light)
        light.castShadow = shadowsOn
        if (shadowsOn) shadowSlots--
      } else {
        light.castShadow = false
      }
    }
    this.activeNearbyCount = activeCount
  }
}
