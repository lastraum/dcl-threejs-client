import * as THREE from 'three'
import { dclToThreePos } from '../bridge/dclTransform'
import { parseParcelKey } from '../dcl/content/parseParcel'
import { PARCEL_SIZE } from '../dcl/content/types'
import {
  islandCenterDcl,
  islandShoreLayout,
  sceneCenterParcel
} from '../dcl/landscape/islandLandscapeKeys'
import { landscapeEnvironmentProfile, type LandscapeEnvironmentKind } from '../dcl/landscape/EnvironmentCatalog'
import { ISLAND_WATER_SURFACE_Y } from '../dcl/landscape/IslandShoreMaterial'
import { landscapeParcelKeys, sceneParcelBounds } from '../dcl/landscape/Utils/ParcelGrid'
import { parcelWorldOrigin } from '../dcl/landscape/Utils/SceneSpace'

/** Parcel ring beyond ground padding where ocean tiles are placed. */
const OCEAN_RING_PARCELS = 10

export type IslandOceanConfig = {
  shoreWidthParcels: number
}

const vertexShader = /* glsl */ `
  varying vec2 vUv;
  varying float vElevation;
  varying vec3 vWorldPos;
  uniform float uTime;

  void main() {
    vUv = uv;
    vec4 world = modelMatrix * instanceMatrix * vec4(position, 1.0);
    vWorldPos = world.xyz;
    float wave = sin(world.x * 0.07 + uTime * 0.85) * 0.04
               + sin(world.z * 0.055 + uTime * 0.65) * 0.03;
    vElevation = wave;
    vec3 pos = position;
    pos.y += wave;
    gl_Position = projectionMatrix * modelViewMatrix * modelMatrix * instanceMatrix * vec4(pos, 1.0);
  }
`

const fragmentShader = /* glsl */ `
  varying vec2 vUv;
  varying float vElevation;
  varying vec3 vWorldPos;
  uniform float uTime;
  uniform vec3 uDeepColor;
  uniform vec3 uShallowColor;
  uniform float uIslandMode;
  uniform vec2 uIslandCenterXZ;
  uniform float uIslandOuterR;
  uniform float uFoamWidth;

  void main() {
    float ripple = sin(vUv.x * 20.0 + uTime * 1.1) * 0.5 + 0.5;
    ripple *= sin(vUv.y * 16.0 - uTime * 0.75) * 0.5 + 0.5;
    vec3 color = mix(uDeepColor, uShallowColor, ripple * 0.3 + vElevation * 2.5 + 0.22);

    if (uIslandMode > 0.5) {
      float dist = length(vWorldPos.xz - uIslandCenterXZ);
      float shoreFoam = 1.0 - smoothstep(uIslandOuterR, uIslandOuterR + uFoamWidth, dist);
      color = mix(color, vec3(0.78, 0.86, 0.9), shoreFoam * 0.35);
      float fadeIn = smoothstep(uIslandOuterR - 1.0, uIslandOuterR + 2.0, dist);
      if (fadeIn < 0.02) discard;
    }

    gl_FragColor = vec4(color, 0.92);
  }
`

function oceanTileOriginsRect(
  sceneParcels: string[],
  baseParcel: string,
  landscapePadding = 1,
  landscapeGroundKeys?: string[]
): Array<{ x: number; z: number }> {
  const groundKeys = new Set(
    landscapeGroundKeys ?? landscapeParcelKeys(sceneParcels, landscapePadding)
  )
  const base = parseParcelKey(baseParcel)
  const out: Array<{ x: number; z: number }> = []

  let minPx = Infinity
  let maxPx = -Infinity
  let minPy = Infinity
  let maxPy = -Infinity
  for (const key of groundKeys) {
    const p = parseParcelKey(key)
    minPx = Math.min(minPx, p.x)
    maxPx = Math.max(maxPx, p.x)
    minPy = Math.min(minPy, p.y)
    maxPy = Math.max(maxPy, p.y)
  }
  if (!Number.isFinite(minPx)) {
    const bounds = sceneParcelBounds(sceneParcels)
    minPx = bounds.minX - landscapePadding
    maxPx = bounds.maxX + landscapePadding
    minPy = bounds.minY - landscapePadding
    maxPy = bounds.maxY + landscapePadding
  }
  minPx -= OCEAN_RING_PARCELS
  maxPx += OCEAN_RING_PARCELS
  minPy -= OCEAN_RING_PARCELS
  maxPy += OCEAN_RING_PARCELS

  for (let py = minPy; py <= maxPy; py++) {
    for (let px = minPx; px <= maxPx; px++) {
      const key = `${px},${py}`
      if (groundKeys.has(key)) continue
      const origin = parcelWorldOrigin({ x: px, y: py }, base)
      out.push({
        x: origin.x + PARCEL_SIZE / 2,
        z: origin.z + PARCEL_SIZE / 2
      })
    }
  }

  return out
}

/** Circular island — ocean tiles only outside the procedural shore disc (no square parcel bite). */
function oceanTileOriginsCircular(
  sceneParcels: string[],
  baseParcel: string,
  shoreWidthParcels: number
): Array<{ x: number; z: number }> {
  const base = parseParcelKey(baseParcel)
  const layout = islandShoreLayout(sceneParcels, shoreWidthParcels, base)
  const center = islandCenterDcl(sceneParcels, base)
  const innerR = layout.outerRadiusM - 0.5
  const outerR = layout.outerRadiusM + OCEAN_RING_PARCELS * PARCEL_SIZE
  const scanParcels = Math.ceil(outerR / PARCEL_SIZE) + 1
  const centerParcel = sceneCenterParcel(sceneParcels)
  const out: Array<{ x: number; z: number }> = []

  for (let py = Math.floor(centerParcel.y - scanParcels); py <= Math.ceil(centerParcel.y + scanParcels); py++) {
    for (let px = Math.floor(centerParcel.x - scanParcels); px <= Math.ceil(centerParcel.x + scanParcels); px++) {
      const origin = parcelWorldOrigin({ x: px, y: py }, base)
      const cx = origin.x + PARCEL_SIZE / 2
      const cz = origin.z + PARCEL_SIZE / 2
      const dist = Math.hypot(cx - center.x, cz - center.z)
      if (dist < innerR || dist > outerR) continue
      out.push({ x: cx, z: cz })
    }
  }

  return out
}

/**
 * Instanced ocean beyond landscape ground — circular ring for island, rectangular for other biomes.
 */
export class OceanRing {
  readonly group = new THREE.Group()
  private mesh: THREE.InstancedMesh | null = null
  private uniforms: {
    uTime: { value: number }
    uDeepColor: { value: THREE.Color }
    uShallowColor: { value: THREE.Color }
    uIslandMode: { value: number }
    uIslandCenterXZ: { value: THREE.Vector2 }
    uIslandOuterR: { value: number }
    uFoamWidth: { value: number }
  } | null = null
  private elapsed = 0

  constructor(
    sceneParcels: string[],
    baseParcel: string,
    landscapePadding = 1,
    landscapeGroundKeys?: string[],
    island?: IslandOceanConfig
  ) {
    this.group.name = 'ocean-ring'

    const tiles = island
      ? oceanTileOriginsCircular(sceneParcels, baseParcel, island.shoreWidthParcels)
      : oceanTileOriginsRect(sceneParcels, baseParcel, landscapePadding, landscapeGroundKeys)
    this.group.userData.oceanTileCount = tiles.length
    if (tiles.length === 0) return

    const geometry = new THREE.PlaneGeometry(PARCEL_SIZE, PARCEL_SIZE, 4, 4)
    geometry.rotateX(-Math.PI / 2)

    const base = parseParcelKey(baseParcel)
    const islandLayout = island
      ? islandShoreLayout(sceneParcels, island.shoreWidthParcels, base)
      : null
    const islandCenter = island ? islandCenterDcl(sceneParcels, base) : null

    this.uniforms = {
      uTime: { value: 0 },
      uDeepColor: { value: new THREE.Color(0x0a3d5c) },
      uShallowColor: { value: new THREE.Color(0x2a8fad) },
      uIslandMode: { value: island ? 1 : 0 },
      uIslandCenterXZ: { value: new THREE.Vector2(islandCenter?.x ?? 0, islandCenter?.z ?? 0) },
      uIslandOuterR: { value: islandLayout?.outerRadiusM ?? 0 },
      uFoamWidth: { value: 5 }
    }

    const material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader,
      fragmentShader,
      transparent: true,
      depthWrite: false
    })

    this.mesh = new THREE.InstancedMesh(geometry, material, tiles.length)
    this.mesh.name = 'ocean-ring:instanced'
    this.mesh.count = tiles.length
    this.mesh.frustumCulled = false
    this.mesh.renderOrder = -5

    const dummy = new THREE.Object3D()
    const m = new THREE.Matrix4()
    for (let i = 0; i < tiles.length; i++) {
      const tile = tiles[i]!
      dclToThreePos(tile.x, ISLAND_WATER_SURFACE_Y, tile.z, dummy.position)
      dummy.rotation.set(0, 0, 0)
      dummy.scale.set(1, 1, 1)
      dummy.updateMatrix()
      m.copy(dummy.matrix)
      this.mesh.setMatrixAt(i, m)
    }
    this.mesh.instanceMatrix.needsUpdate = true
    this.mesh.computeBoundingSphere()
    this.group.add(this.mesh)
  }

  update(delta: number, _camera?: THREE.Camera): void {
    if (!this.uniforms) return
    this.elapsed += delta
    this.uniforms.uTime.value = this.elapsed
  }

  dispose(): void {
    if (this.mesh) {
      this.mesh.geometry.dispose()
      ;(this.mesh.material as THREE.Material).dispose()
    }
    this.group.removeFromParent()
  }
}

export function shouldRenderOcean(kind: LandscapeEnvironmentKind): boolean {
  return landscapeEnvironmentProfile(kind).showWater
}