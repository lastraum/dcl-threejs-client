import * as THREE from 'three'
import { Water } from 'three/examples/jsm/objects/Water.js'
import { dclToThreePos } from '../bridge/dclTransform'
import { parseParcelKey } from '../dcl/content/parseParcel'
import { ISLAND_WATER_SURFACE_Y } from '../dcl/landscape/IslandShoreMaterial'
import { islandCenterDcl, islandCenterThree, islandShoreLayout } from '../dcl/landscape/islandLandscapeKeys'
import type { AuthorTerrainHeightMap } from './authorTerrainHeightMap'
import type { OutdoorLightingSnapshot } from './OutdoorLighting'
import { patchIslandTerrainShoreMask } from './islandWaterShoreMask'

/**
 * Ocean beyond the island outer shore (half-plane padding).
 * Was 320 m — the square edge was obvious from the beach. Match open-ocean
 * half-extent so the sea reads as horizon-scale (~5.6 km full span).
 * @see OpenOceanWater OPEN_OCEAN_HALF_EXTENT_M
 */
const OCEAN_EXTENT_BEYOND_SHORE_M = 2800
/** Floor half-extent so tiny 1-parcel islands still get a large sea. */
const OCEAN_HALF_EXTENT_MIN_M = 3000
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
  authorHeight: boolean
}

export class IslandWater {
  readonly group = new THREE.Group()
  readonly perf: IslandWaterPerfSnapshot
  private readonly water: Water
  private authorHeightMap: AuthorTerrainHeightMap | null = null

  private constructor(water: Water, span: number, authorHeight: boolean) {
    this.group.name = 'island-water'
    this.water = water
    this.perf = {
      backend: 'water.js',
      variant: 'island',
      planeSpanM: span,
      authorHeight
    }
    this.group.add(water)
  }

  static async create(
    sceneParcels: string[],
    baseParcel: string,
    shoreWidthParcels: number,
    options?: {
      waterColor?: number
      distortionScale?: number
      authorHeightMap?: AuthorTerrainHeightMap | null
    }
  ): Promise<IslandWater> {
    const base = parseParcelKey(baseParcel)
    const layout = islandShoreLayout(sceneParcels, shoreWidthParcels, base)
    const centerThree = islandCenterThree(sceneParcels, base)
    // Half-extent (center → edge). Full plane span = half * 2.
    const halfExtent = Math.max(
      layout.outerRadiusM + OCEAN_EXTENT_BEYOND_SHORE_M,
      OCEAN_HALF_EXTENT_MIN_M
    )
    const planeSpan = halfExtent * 2
    const waterNormals = await loadWaterNormals()
    const author = options?.authorHeightMap ?? null

    const sunDir = new THREE.Vector3(0.45, 0.72, 0.35).normalize()
    const geometry = new THREE.PlaneGeometry(planeSpan, planeSpan)

    const water = new Water(geometry, {
      textureWidth: 512,
      textureHeight: 512,
      waterNormals,
      sunDirection: sunDir,
      sunColor: 0xffffff,
      waterColor: options?.waterColor ?? 0x000a14,
      distortionScale: options?.distortionScale ?? 3.7,
      fog: false
    })

    water.rotation.x = -Math.PI / 2
    water.name = 'island-water:three-water'
    water.frustumCulled = false
    water.renderOrder = 1

    const centerXZ = new THREE.Vector2(centerThree.x, centerThree.z)
    patchIslandTerrainShoreMask(water.material as THREE.ShaderMaterial, layout, centerXZ, author)

    const centerDcl = islandCenterDcl(sceneParcels, base)
    const instance = new IslandWater(water, planeSpan, author != null)
    if (author) instance.authorHeightMap = author
    dclToThreePos(centerDcl.x, ISLAND_WATER_SURFACE_Y, centerDcl.z, instance.group.position)
    instance.group.userData.outerRadiusM = layout.outerRadiusM
    instance.group.userData.halfExtentM = halfExtent
    console.info(
      `[ocean] Water.js active (island) — plane=${planeSpan}m half=${halfExtent}m shoreR=${layout.outerRadiusM.toFixed(0)} authorHeight=${author != null}`
    )
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
    const mat = this.water.material as THREE.ShaderMaterial
    const dummy = mat.userData.authorHeightDummy as THREE.DataTexture | undefined
    dummy?.dispose()
    mat.dispose()
    this.authorHeightMap?.dispose()
    this.authorHeightMap = null
    this.group.removeFromParent()
  }
}