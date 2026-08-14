import * as THREE from 'three'
import type { PBLightSource } from '@dcl/ecs/dist/components/generated/pb/decentraland/sdk/components/light_source.gen'
import { color3ToThree, lightIntensityFromCandelas, lightRangeMeters } from './pbColor'
import { configureSpotLightShadow } from '../rendering/spotLightShadow'

/** Stored on `light.userData.lightSource` for LightManager culling. */
export type LightSourceMeta = {
  ecsActive: boolean
  wantsShadow: boolean
  isSpot: boolean
}

function spotTargetName(key: string): string {
  return `${key}-target`
}

function getOrCreateSpotTarget(parent: THREE.Object3D, key: string): THREE.Object3D {
  const name = spotTargetName(key)
  let target = parent.getObjectByName(name) as THREE.Object3D | undefined
  if (!target) {
    target = new THREE.Object3D()
    target.name = name
    parent.add(target)
  }
  target.position.set(0, 0, -1)
  return target
}

function removeSpotTarget(parent: THREE.Object3D, key: string): void {
  const target = parent.getObjectByName(spotTargetName(key))
  if (target) parent.remove(target)
}

function findScene(obj: THREE.Object3D): THREE.Scene | null {
  let o: THREE.Object3D | null = obj
  while (o) {
    if ((o as THREE.Scene).isScene) return o as THREE.Scene
    o = o.parent
  }
  return null
}

function registerWithLightManager(anchor: THREE.Object3D, light: THREE.PointLight | THREE.SpotLight): void {
  const scene = findScene(anchor) ?? findScene(light)
  const reg = scene?.userData.dclRegisterLight as
    | ((l: THREE.PointLight | THREE.SpotLight) => void)
    | undefined
  reg?.(light)
}

function unregisterWithLightManager(
  anchor: THREE.Object3D,
  light: THREE.PointLight | THREE.SpotLight
): void {
  const scene = findScene(anchor) ?? findScene(light)
  const unreg = scene?.userData.dclUnregisterLight as
    | ((l: THREE.PointLight | THREE.SpotLight) => void)
    | undefined
  unreg?.(light)
}

function existingLight(parent: THREE.Object3D, key: string): THREE.Light | undefined {
  const drawn = parent.userData.dclDrawLight as THREE.Object3D | undefined
  if (drawn?.name === key && (drawn as THREE.Light).isLight) return drawn as THREE.Light
  return parent.getObjectByName(key) as THREE.Light | undefined
}

export function syncLightSource(
  parent: THREE.Object3D,
  key: string,
  spec: PBLightSource,
  bindDrawVisual?: (pose: THREE.Object3D, visual: THREE.Object3D) => void
): void {
  let light = existingLight(parent, key)
  const active = spec.active !== false
  const intensity = lightIntensityFromCandelas(spec.intensity)
  const color = color3ToThree(spec.color)
  const distance = lightRangeMeters(spec.intensity, spec.range)

  const isSpot = spec.type?.$case === 'spot'
  if (light) {
    if ((isSpot && !(light instanceof THREE.SpotLight)) || (!isSpot && !(light instanceof THREE.PointLight))) {
      if (light instanceof THREE.PointLight || light instanceof THREE.SpotLight) {
        unregisterWithLightManager(parent, light)
      }
      disposeLight(light)
      light.removeFromParent()
      if (light instanceof THREE.SpotLight) removeSpotTarget(light, key)
      light = undefined
    }
  }

  if (!light) {
    if (isSpot) {
      const spot = new THREE.SpotLight(color, intensity, distance)
      const target = getOrCreateSpotTarget(spot, key)
      spot.target = target
      configureSpotLightShadow(spot)
      light = spot
    } else {
      light = new THREE.PointLight(color, intensity, distance)
    }
    light.name = key
    if (bindDrawVisual) bindDrawVisual(parent, light)
    else parent.add(light)
  }

  light.color.copy(color)
  light.intensity = intensity
  light.userData.lightSource = {
    ecsActive: active,
    wantsShadow: spec.shadow === true,
    isSpot
  } satisfies LightSourceMeta
  light.visible = active
  if (light instanceof THREE.PointLight || light instanceof THREE.SpotLight) {
    light.distance = distance
    light.decay = 2
    registerWithLightManager(light, light)
  }
  // LightManager enables castShadow on up to 3 nearest spot lights when shadow: true.
  light.castShadow = false

  if (light instanceof THREE.SpotLight) {
    light.target = getOrCreateSpotTarget(light, key)
    light.shadow.camera.far = Math.max(distance, 1)
    if (spec.type?.$case === 'spot') {
      const inner = THREE.MathUtils.degToRad(spec.type.spot.innerAngle ?? 21.8)
      const outer = THREE.MathUtils.degToRad(spec.type.spot.outerAngle ?? 30)
      light.angle = outer
      light.penumbra = outer > 0 ? Math.max(0, 1 - inner / outer) : 0
    }
  }
}

export function removeLightSource(
  parent: THREE.Object3D,
  key: string,
  unbindDrawVisual?: (pose: THREE.Object3D) => void
): void {
  const light = existingLight(parent, key)
  if (light) {
    if (light instanceof THREE.PointLight || light instanceof THREE.SpotLight) {
      unregisterWithLightManager(light, light)
    }
    disposeLight(light as THREE.Light)
    unbindDrawVisual?.(parent)
    light.removeFromParent()
  }
  removeSpotTarget(parent, key)
}

function disposeLight(light: THREE.Light): void {
  light.dispose?.()
  if (
    light instanceof THREE.PointLight ||
    light instanceof THREE.SpotLight ||
    light instanceof THREE.DirectionalLight
  ) {
    light.shadow?.map?.dispose()
  }
}
