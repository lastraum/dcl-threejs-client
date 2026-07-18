import * as THREE from 'three'
import { Water } from 'three/examples/jsm/objects/Water.js'
import { dclToThreePos } from '../../bridge/dclTransform'
import { ARENA_WATER_SURFACE_Y, TERRAIN_BIOME_COLORS } from './terrainSculptConstants'

const WATER_NORMALS_URL = '/textures/water/Water_1_M_Normal.jpg'
const MARGIN_M = 32

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
 * Light Water.js plane for the terrain editor — sits at procedural waterToY so
 * “to water” sculpt and water biome bands have a readable surface.
 * Outdoor sun is fixed to editor lighting (no full EnvironmentSystem).
 */
export class EditorWaterPlane {
  readonly group = new THREE.Group()
  private readonly water: Water
  private waterY = ARENA_WATER_SURFACE_Y
  private readonly centerDcl: { x: number; z: number }

  private constructor(water: Water, centerDcl: { x: number; z: number }, waterY: number) {
    this.water = water
    this.centerDcl = centerDcl
    this.waterY = waterY
    this.group.name = 'editor-water'
    this.group.add(water)
    this.syncPosition()
  }

  static async create(
    widthM: number,
    depthM: number,
    originX: number,
    originZ: number,
    waterY: number = ARENA_WATER_SURFACE_Y,
    waterColor: number = TERRAIN_BIOME_COLORS.water
  ): Promise<EditorWaterPlane> {
    const waterNormals = await loadWaterNormals()
    const spanX = widthM + MARGIN_M * 2
    const spanZ = depthM + MARGIN_M * 2
    const geometry = new THREE.PlaneGeometry(spanX, spanZ, 1, 1)

    const sunDir = new THREE.Vector3(120, 220, 80).normalize()
    const water = new Water(geometry, {
      textureWidth: 256,
      textureHeight: 256,
      waterNormals,
      sunDirection: sunDir,
      sunColor: 0xfff5e8,
      waterColor,
      distortionScale: 2.8,
      fog: false
    })
    water.rotation.x = -Math.PI / 2
    water.name = 'editor-water:plane'
    water.renderOrder = 1
    water.frustumCulled = false

    const centerDcl = {
      x: originX + widthM * 0.5,
      z: originZ + depthM * 0.5
    }
    return new EditorWaterPlane(water, centerDcl, waterY)
  }

  mount(scene: THREE.Scene): void {
    scene.add(this.group)
  }

  setWaterLevel(y: number): void {
    if (!Number.isFinite(y) || Math.abs(y - this.waterY) < 1e-4) return
    this.waterY = y
    this.syncPosition()
  }

  setWaterColor(hex: number): void {
    const mat = this.water.material as THREE.ShaderMaterial
    const c = mat.uniforms.waterColor?.value as THREE.Color | undefined
    if (c) c.setHex(hex & 0xffffff)
  }

  setVisible(visible: boolean): void {
    this.group.visible = visible
  }

  update(delta: number): void {
    const mat = this.water.material as THREE.ShaderMaterial
    if (mat.uniforms.time) mat.uniforms.time.value += delta
  }

  dispose(): void {
    this.water.geometry.dispose()
    this.water.material.dispose()
    this.group.removeFromParent()
  }

  private syncPosition(): void {
    dclToThreePos(this.centerDcl.x, this.waterY, this.centerDcl.z, this.group.position)
  }
}
