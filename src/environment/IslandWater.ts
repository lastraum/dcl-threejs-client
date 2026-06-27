import * as THREE from 'three'
import { Water } from 'three/examples/jsm/objects/Water.js'
import { dclToThreePos } from '../bridge/dclTransform'
import { parseParcelKey } from '../dcl/content/parseParcel'
import { ISLAND_WATER_SURFACE_Y } from '../dcl/landscape/IslandShoreMaterial'
import { islandCenterDcl, islandCenterThree, islandShoreLayout } from '../dcl/landscape/islandLandscapeKeys'
import type { OutdoorLightingSnapshot } from './OutdoorLighting'
import { patchIslandTerrainShoreMask } from './islandWaterShoreMask'

const OCEAN_EXTENT_M = 320
const WATER_NORMALS_URL = '/textures/water/Water_1_M_Normal.jpg'

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
 * three.js {@link Water} mirror + normal-map shader, masked to a ring outside the island shore.
 * @see https://github.com/mrdoob/three.js/blob/master/examples/jsm/objects/Water.js
 */
export type IslandWaterPerfSnapshot = {
  backend: 'water.js'
  variant: 'island'
  planeSpanM: number
}

export class IslandWater {
  readonly group = new THREE.Group()
  readonly perf: IslandWaterPerfSnapshot
  private readonly water: Water

  private constructor(water: Water, span: number) {
    this.group.name = 'island-water'
    this.water = water
    this.perf = { backend: 'water.js', variant: 'island', planeSpanM: span }
    this.group.add(water)
  }

  static async create(
    sceneParcels: string[],
    baseParcel: string,
    shoreWidthParcels: number
  ): Promise<IslandWater> {
    const base = parseParcelKey(baseParcel)
    const layout = islandShoreLayout(sceneParcels, shoreWidthParcels, base)
    const centerThree = islandCenterThree(sceneParcels, base)
    const extent = layout.outerRadiusM + OCEAN_EXTENT_M
    const waterNormals = await loadWaterNormals()

    const sunDir = new THREE.Vector3(0.45, 0.72, 0.35).normalize()
    const geometry = new THREE.PlaneGeometry(extent * 2, extent * 2)

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
    water.name = 'island-water:three-water'
    water.frustumCulled = false
    water.renderOrder = 1

    const centerXZ = new THREE.Vector2(centerThree.x, centerThree.z)
    patchIslandTerrainShoreMask(water.material as THREE.ShaderMaterial, layout, centerXZ)

    const centerDcl = islandCenterDcl(sceneParcels, base)
    const instance = new IslandWater(water, extent * 2)
    dclToThreePos(centerDcl.x, ISLAND_WATER_SURFACE_Y, centerDcl.z, instance.group.position)
    instance.group.userData.outerRadiusM = layout.outerRadiusM
    console.info(`[ocean] Water.js active (island) — plane=${extent * 2}m`)
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