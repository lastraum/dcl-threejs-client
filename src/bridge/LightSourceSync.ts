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

export function syncLightSource(parent: THREE.Object3D, key: string, spec: PBLightSource): void {
  let light = parent.getObjectByName(key) as THREE.Light | undefined
  const active = spec.active !== false
  const intensity = lightIntensityFromCandelas(spec.intensity)
  const color = color3ToThree(spec.color)
  const distance = lightRangeMeters(spec.intensity, spec.range)

  const isSpot = spec.type?.$case === 'spot'
  if (light) {
    if ((isSpot && !(light instanceof THREE.SpotLight)) || (!isSpot && !(light instanceof THREE.PointLight))) {
      disposeLight(light)
      parent.remove(light)
      if (light instanceof THREE.SpotLight) removeSpotTarget(parent, key)
      light = undefined
    }
  }

  if (!light) {
    if (isSpot) {
      const target = getOrCreateSpotTarget(parent, key)
      const spot = new THREE.SpotLight(color, intensity, distance)
      spot.target = target
      configureSpotLightShadow(spot)
      light = spot
    } else {
      light = new THREE.PointLight(color, intensity, distance)
    }
    light.name = key
    parent.add(light)
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
  }
  // LightManager enables castShadow on up to 3 nearest spot lights when shadow: true.
  light.castShadow = false

  if (light instanceof THREE.SpotLight) {
    light.target = getOrCreateSpotTarget(parent, key)
    light.shadow.camera.far = Math.max(distance, 1)
    if (spec.type?.$case === 'spot') {
      const inner = THREE.MathUtils.degToRad(spec.type.spot.innerAngle ?? 21.8)
      const outer = THREE.MathUtils.degToRad(spec.type.spot.outerAngle ?? 30)
      light.angle = outer
      light.penumbra = outer > 0 ? Math.max(0, 1 - inner / outer) : 0
    }
  }
}

export function removeLightSource(parent: THREE.Object3D, key: string): void {
  const light = parent.getObjectByName(key)
  if (light) {
    disposeLight(light as THREE.Light)
    parent.remove(light)
  }
  removeSpotTarget(parent, key)
}

function disposeLight(light: THREE.Light): void {
  light.dispose?.()
  light.shadow?.map?.dispose()
}
