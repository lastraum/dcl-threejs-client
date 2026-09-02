import * as THREE from 'three'
import type { PBLightSource } from '@dcl/ecs/dist/components/generated/pb/decentraland/sdk/components/light_source.gen'
import { color3ToThree, lightIntensityFromCandelas, lightRangeMeters } from './pbColor'
import { configureSpotLightShadow } from '../rendering/spotLightShadow'
import { enableDrawLayers } from '../rendering/drawLayers'

/** Stored on `light.userData.lightSource` for LightManager culling. */
export type LightSourceMeta = {
  ecsActive: boolean
  wantsShadow: boolean
  isSpot: boolean
  /** Spot cookie (plaza aim highlight) — do not distance-cull. */
  skipCull?: boolean
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

type LightTextureResolver = (src: string) => string | null
let resolveLightTextureUrl: LightTextureResolver | null = null

/** Bind scene content URL resolve so Spot shadowMaskTexture (plaza aim cookie) can load. */
export function setLightTextureResolver(fn: LightTextureResolver | null): void {
  resolveLightTextureUrl = fn
}

function shadowMaskSrc(spec: PBLightSource): string | null {
  const raw = spec.shadowMaskTexture as
    | {
        src?: string
        tex?: { texture?: { src?: string }; $case?: string }
        texture?: { src?: string }
      }
    | undefined
  if (!raw) return null
  if (typeof raw.src === 'string' && raw.src.trim()) return raw.src.trim()
  const fromUnion = raw.tex?.$case === 'texture' ? raw.tex.texture?.src : raw.tex?.texture?.src
  if (typeof fromUnion === 'string' && fromUnion.trim()) return fromUnion.trim()
  const inner = raw.texture?.src
  if (typeof inner === 'string' && inner.trim()) return inner.trim()
  return null
}

function goboName(key: string): string {
  return `${key}-gobo`
}

function syncSpotGobo(
  light: THREE.SpotLight,
  key: string,
  spec: PBLightSource,
  active: boolean
): void {
  const src = shadowMaskSrc(spec)
  const name = goboName(key)
  let gobo = light.getObjectByName(name) as THREE.Mesh | undefined
  if (!src) {
    if (gobo) {
      gobo.removeFromParent()
      ;(gobo.material as THREE.Material).dispose()
      gobo.geometry.dispose()
    }
    return
  }
  const dist = 0.95
  const angle = light.angle || THREE.MathUtils.degToRad(30)
  const diameter = 2 * Math.tan(angle) * dist
  if (!gobo) {
    gobo = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        toneMapped: false
      })
    )
    gobo.name = name
    gobo.renderOrder = 2
    light.add(gobo)
  }
  gobo.position.set(0, 0, -dist)
  gobo.lookAt(0, 0, 0)
  gobo.scale.set(diameter, diameter, 1)
  gobo.visible = active
  const mat = gobo.material as THREE.MeshBasicMaterial
  const url = resolveLightTextureUrl?.(src) ?? (/^https?:|^data:|^blob:/i.test(src) ? src : null)
  if (url && mat.userData.dclGoboUrl !== url) {
    mat.userData.dclGoboUrl = url
    new THREE.TextureLoader().load(url, (tex) => {
      tex.colorSpace = THREE.SRGBColorSpace
      mat.map = tex
      mat.needsUpdate = true
    })
  }
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
    isSpot,
    skipCull: isSpot && !!shadowMaskSrc(spec)
  } satisfies LightSourceMeta
  light.visible = active
  if (light instanceof THREE.PointLight || light instanceof THREE.SpotLight) {
    light.distance = distance
    light.decay = 2
    registerWithLightManager(light, light)
  }
  enableDrawLayers(light)
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
    syncSpotGobo(light, key, spec, active)
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
    const gobo = light.getObjectByName(goboName(key)) as THREE.Mesh | undefined
    if (gobo) {
      gobo.removeFromParent()
      ;(gobo.material as THREE.Material).dispose()
      gobo.geometry.dispose()
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
