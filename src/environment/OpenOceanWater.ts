import * as THREE from 'three'
import { Water } from 'three/examples/jsm/objects/Water.js'
import { dclToThreePos } from '../bridge/dclTransform'
import { parseParcelKey } from '../dcl/content/parseParcel'
import { islandCenterDcl } from '../dcl/landscape/islandLandscapeKeys'
import { ISLAND_WATER_SURFACE_Y } from '../dcl/landscape/IslandShoreMaterial'
import type { OutdoorLightingSnapshot } from './OutdoorLighting'

const WATER_NORMALS_URL = '/textures/water/Water_1_M_Normal.jpg'
/** Half-extent of the water plane in metres (full span = 2×). */
const OPEN_OCEAN_HALF_EXTENT_M = 2800

let normalsPromise: Promise<THREE.Texture> | null = null

function loadWaterNormals(): Promise<THREE.Texture> {
  if (!normalsPromise) {
    normalsPromise = new THREE.TextureLoader().loadAsync(WATER_NORMALS_URL).then((tex) => {
      tex.wrapS = THREE.RepeatWrapping
      tex.wrapT = THREE.RepeatWrapping
      return tex
    })
  }
  return normalsPromise
}

/**
 * Infinite-style ocean — full Water.js plane, no island shore mask or ground ring.
 * Used by the `water` environment (sky + ocean only).
 */
export type WaterJsPerfSnapshot = {
  backend: 'water.js'
  variant: 'open'
  planeSpanM: number
}

export class OpenOceanWater {
  readonly group = new THREE.Group()
  readonly perf: WaterJsPerfSnapshot
  private readonly water: Water

  private constructor(water: Water, span: number) {
    this.group.name = 'open-ocean-water'
    this.water = water
    this.perf = { backend: 'water.js', variant: 'open', planeSpanM: span }
    this.group.add(water)
  }

  static async create(sceneParcels: string[], baseParcel: string): Promise<OpenOceanWater> {
    const base = parseParcelKey(baseParcel)
    const centerDcl = islandCenterDcl(sceneParcels, base)
    const waterNormals = await loadWaterNormals()

    const sunDir = new THREE.Vector3(0.45, 0.72, 0.35).normalize()
    const span = OPEN_OCEAN_HALF_EXTENT_M * 2
    const geometry = new THREE.PlaneGeometry(span, span)

    const water = new Water(geometry, {
      textureWidth: 512,
      textureHeight: 512,
      waterNormals,
      sunDirection: sunDir,
      sunColor: 0xffffff,
      waterColor: 0x000a14,
      distortionScale: 3.7,
      fog: false
    })

    water.rotation.x = -Math.PI / 2
    water.name = 'open-ocean:three-water'
    water.frustumCulled = false
    water.renderOrder = 1

    const instance = new OpenOceanWater(water, span)
    dclToThreePos(centerDcl.x, ISLAND_WATER_SURFACE_Y, centerDcl.z, instance.group.position)
    instance.group.userData.halfExtentM = OPEN_OCEAN_HALF_EXTENT_M
    console.info(`[ocean] Water.js active (open) — plane=${span}m`)
    return instance
  }

  applyOutdoorLighting(lighting: OutdoorLightingSnapshot): void {
    const mat = this.water.material as THREE.ShaderMaterial
    const active = lighting.isDay ? lighting.sunLight : lighting.moonLight
    ;(mat.uniforms.sunDirection.value as THREE.Vector3).copy(lighting.primaryDir)
    ;(mat.uniforms.sunColor.value as THREE.Color).setRGB(
      THREE.MathUtils.clamp(active.x, 0, 2),
      THREE.MathUtils.clamp(active.y, 0, 2),
      THREE.MathUtils.clamp(active.z, 0, 2)
    )
  }

  update(delta: number, _camera?: THREE.Camera): void {
    const mat = this.water.material as THREE.ShaderMaterial
    mat.uniforms.time.value += delta
  }

  dispose(): void {
    this.water.geometry.dispose()
    this.water.material.dispose()
    this.group.removeFromParent()
  }
}