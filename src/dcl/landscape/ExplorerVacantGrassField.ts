import * as THREE from 'three'
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js'
import { parseParcelKey } from '../content/parseParcel'
import { PARCEL_SIZE } from '../content/types'
import { EZ_TREE_GRASS_TINT_RGB } from './landscapeAssets'
import { dclSceneToLandscapeThree, EMPTY_LAND_GROUND_OFFSET } from './Utils/SceneSpace'
import { hashParcelCoords, mulberry32 } from './Utils/SeededRandom'
import { appendGrassWindShader, setGrassWindElapsed } from './grassWindShader'
import { landscapeLodRangeM } from '../../rendering/RenderQualitySettings'
import type { EzTreeGrassFieldHandle } from './EzTreeGrassField'

/**
 * Unity Explorer empty-parcel details (`GrassIndirectRenderer`):
 * - 256 grass tufts / parcel on a 16×16 grid (positionJitter 50%)
 * - 16 flower0 + 16 flower1 / parcel
 * - detail fade ≤ 180 m
 * Meshes/atlas from unity-explorer Landscape Assets (Stylized Grass + Flowers02).
 */
const ASSET_BASE = '/landscape/explorer-grass'
const GRASS_PER_PARCEL = 256
const FLOWERS_PER_TYPE = 16
const DETAIL_MAX_M = 180
/** Stay inside vacant parcels so tufts don't hang into occupied scenes / water. */
const PARCEL_INSET_M = 1.5
/**
 * FBXLoader already puts geometry in Y-up. Do not apply the node's -90° X
 * (that lays blades on the ground). Local grass Y is ~1.05 m.
 */
const GRASS_MESH_HEIGHT_M = 0.52
const GRASS_HEIGHT_MIN = 0.9
const GRASS_HEIGHT_MAX = 1.1
const FLOWER_MESH_HEIGHT_M = 0.65

const GENESIS_GRASS_TINT = new THREE.Color(
  EZ_TREE_GRASS_TINT_RGB.r / 255,
  EZ_TREE_GRASS_TINT_RGB.g / 255,
  EZ_TREE_GRASS_TINT_RGB.b / 255
)

type MeshTemplate = {
  geometry: THREE.BufferGeometry
  alignY: number
  localMatrix: THREE.Matrix4
}

type Place = {
  x: number
  y: number
  z: number
  rotY: number
  scaleX: number
  scaleY: number
  scaleZ: number
  color: THREE.Color
}

const fbxLoader = new FBXLoader()
const textureLoader = new THREE.TextureLoader()
let templatesPromise: Promise<{
  grass: MeshTemplate
  flower0: MeshTemplate
  flower1: MeshTemplate
  grassMap: THREE.Texture
  flowerMap: THREE.Texture
}> | null = null

function loadTexture(url: string): Promise<THREE.Texture> {
  return new Promise((resolve, reject) => {
    textureLoader.load(
      url,
      (tex) => {
        tex.colorSpace = THREE.SRGBColorSpace
        // Unity FBX UVs — match FBXLoader (flipY false).
        tex.flipY = false
        tex.needsUpdate = true
        resolve(tex)
      },
      undefined,
      reject
    )
  })
}

/**
 * GrassField.png is a black RGB + alpha blade mask (composites white in previews).
 * Three.js `map` multiplies albedo, so black RGB made every tuft black.
 */
function albedoFromAlphaMask(src: THREE.Texture): THREE.Texture {
  const img = src.image as CanvasImageSource & { width: number; height: number }
  const canvas = document.createElement('canvas')
  canvas.width = img.width
  canvas.height = img.height
  const ctx = canvas.getContext('2d')
  if (!ctx) return src
  ctx.drawImage(img, 0, 0)
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height)
  const d = imageData.data
  for (let i = 0; i < d.length; i += 4) {
    d[i] = 255
    d[i + 1] = 255
    d[i + 2] = 255
  }
  ctx.putImageData(imageData, 0, 0)
  const out = new THREE.CanvasTexture(canvas)
  out.colorSpace = THREE.SRGBColorSpace
  out.flipY = src.flipY
  out.needsUpdate = true
  return out
}

function bakeToHeight(
  found: THREE.Mesh,
  targetHeightM: number,
  standUpX: number
): MeshTemplate {
  const geo = found.geometry.clone()
  geo.deleteAttribute('color')
  // Grass cards are authored facing +Y (flat). +90 X stands them up; -90 was inverted.
  if (standUpX !== 0) geo.rotateX(standUpX)
  geo.computeBoundingBox()
  const size = geo.boundingBox!.getSize(new THREE.Vector3())
  const h = Math.max(size.y, 1e-4)
  const s = targetHeightM / h
  geo.scale(s, s, s)
  geo.computeBoundingBox()
  geo.translate(0, -geo.boundingBox!.min.y, 0)
  geo.computeBoundingBox()
  geo.computeBoundingSphere()
  return { geometry: geo, alignY: 0, localMatrix: new THREE.Matrix4() }
}

async function loadFbxTemplate(
  url: string,
  targetHeightM: number,
  standUpX = 0
): Promise<MeshTemplate> {
  const root = await fbxLoader.loadAsync(url)
  let found: THREE.Mesh | undefined
  root.traverse((n) => {
    if (found) return
    if (n instanceof THREE.Mesh && n.geometry && n.visible) found = n
  })
  if (!found) throw new Error(`explorer grass: no mesh in ${url}`)
  return bakeToHeight(found, targetHeightM, standUpX)
}

function loadTemplates() {
  if (templatesPromise) return templatesPromise
  templatesPromise = (async () => {
    const [grass, flower0, flower1, grassMap, flowerMap] = await Promise.all([
      loadFbxTemplate(`${ASSET_BASE}/grass.fbx`, GRASS_MESH_HEIGHT_M, Math.PI / 2),
      loadFbxTemplate(`${ASSET_BASE}/Flower01.fbx`, FLOWER_MESH_HEIGHT_M),
      loadFbxTemplate(`${ASSET_BASE}/Flower02.fbx`, FLOWER_MESH_HEIGHT_M),
      loadTexture(`${ASSET_BASE}/GrassField.png`).then(albedoFromAlphaMask),
      loadTexture(`${ASSET_BASE}/Flowers02.png`)
    ])
    return { grass, flower0, flower1, grassMap, flowerMap }
  })()
  return templatesPromise
}

function makeGrassMaterial(map: THREE.Texture, tint: THREE.Color, wind: boolean): THREE.MeshPhongMaterial {
  const mat = new THREE.MeshPhongMaterial({
    map,
    color: tint.clone(),
    emissive: tint.clone().multiplyScalar(0.45),
    emissiveIntensity: 0.22,
    alphaTest: 0.18,
    transparent: false,
    depthWrite: true,
    side: THREE.DoubleSide,
    vertexColors: true
  })
  if (wind) appendGrassWindShader(mat, true)
  return mat
}

function makeFlowerMaterial(map: THREE.Texture, wind: boolean): THREE.MeshPhongMaterial {
  const mat = new THREE.MeshPhongMaterial({
    map,
    color: 0xffffff,
    alphaTest: 0.4,
    transparent: false,
    depthWrite: true,
    side: THREE.DoubleSide
  })
  if (wind) appendGrassWindShader(mat, true)
  return mat
}

function placeGrass(parcelKeys: string[], primaryBase: string, alignY: number): Place[] {
  const base = parseParcelKey(primaryBase)
  const out: Place[] = []
  const inner = PARCEL_SIZE - PARCEL_INSET_M * 2
  const step = inner / Math.sqrt(GRASS_PER_PARCEL)
  for (const key of parcelKeys) {
    let parcel
    try {
      parcel = parseParcelKey(key)
    } catch {
      continue
    }
    const originX = (parcel.x - base.x) * PARCEL_SIZE
    const originZ = (parcel.y - base.y) * PARCEL_SIZE
    for (let gy = 0; gy < inner; gy += step) {
      for (let gx = 0; gx < inner; gx += step) {
        const cellRng = mulberry32(hashParcelCoords(parcel.x * 16 + gx, parcel.y * 16 + gy, 7))
        // Unity TerrainDetailSettings.positionJitter = 50
        const dclX = originX + PARCEL_INSET_M + gx + (cellRng() - 0.5) * step + step * 0.5
        const dclZ = originZ + PARCEL_INSET_M + gy + (cellRng() - 0.5) * step + step * 0.5
        const three = dclSceneToLandscapeThree(dclX, dclZ, base)
        const h = GRASS_HEIGHT_MIN + cellRng() * (GRASS_HEIGHT_MAX - GRASS_HEIGHT_MIN)
        const shade = 0.82 + cellRng() * 0.28
        out.push({
          x: three.x,
          y: EMPTY_LAND_GROUND_OFFSET.y + alignY,
          z: three.z,
          rotY: cellRng() * Math.PI * 2,
          scaleX: 1,
          scaleY: h,
          scaleZ: 1,
          color: GENESIS_GRASS_TINT.clone().multiplyScalar(shade)
        })
      }
    }
  }
  return out
}

function placeFlowers(
  parcelKeys: string[],
  primaryBase: string,
  alignY: number,
  salt: number
): Place[] {
  const base = parseParcelKey(primaryBase)
  const out: Place[] = []
  for (const key of parcelKeys) {
    let parcel
    try {
      parcel = parseParcelKey(key)
    } catch {
      continue
    }
    const originX = (parcel.x - base.x) * PARCEL_SIZE
    const originZ = (parcel.y - base.y) * PARCEL_SIZE
    const rng = mulberry32(hashParcelCoords(parcel.x, parcel.y, 19 + salt))
    for (let i = 0; i < FLOWERS_PER_TYPE; i++) {
      const span = PARCEL_SIZE - PARCEL_INSET_M * 2
      const dclX = originX + PARCEL_INSET_M + rng() * span
      const dclZ = originZ + PARCEL_INSET_M + rng() * span
      const three = dclSceneToLandscapeThree(dclX, dclZ, base)
      const s = 0.85 + rng() * 0.4
      out.push({
        x: three.x,
        y: EMPTY_LAND_GROUND_OFFSET.y + alignY,
        z: three.z,
        rotY: rng() * Math.PI * 2,
        scaleX: s,
        scaleY: s,
        scaleZ: s,
        color: new THREE.Color(1, 1, 1)
      })
    }
  }
  return out
}

function fillInstanced(
  mesh: THREE.InstancedMesh,
  places: Place[],
  localMatrix: THREE.Matrix4,
  withColor: boolean
): void {
  const dummy = new THREE.Object3D()
  const composed = new THREE.Matrix4()
  for (let i = 0; i < places.length; i++) {
    const p = places[i]!
    dummy.position.set(p.x, p.y, p.z)
    dummy.rotation.set(0, p.rotY, 0)
    dummy.scale.set(p.scaleX, p.scaleY, p.scaleZ)
    dummy.updateMatrix()
    composed.copy(dummy.matrix).multiply(localMatrix)
    mesh.setMatrixAt(i, composed)
    if (withColor) mesh.setColorAt(i, p.color)
  }
  mesh.instanceMatrix.needsUpdate = true
  if (withColor && mesh.instanceColor) mesh.instanceColor.needsUpdate = true
  mesh.computeBoundingSphere()
}

function lodCull(
  mesh: THREE.InstancedMesh,
  places: Place[],
  cameraPos: THREE.Vector3,
  localMatrix: THREE.Matrix4,
  withColor: boolean,
  far: number
): void {
  const farSq = far * far
  const dummy = new THREE.Object3D()
  const composed = new THREE.Matrix4()
  let n = 0
  for (let i = 0; i < places.length; i++) {
    const p = places[i]!
    const dx = p.x - cameraPos.x
    const dz = p.z - cameraPos.z
    if (dx * dx + dz * dz > farSq) continue
    dummy.position.set(p.x, p.y, p.z)
    dummy.rotation.set(0, p.rotY, 0)
    dummy.scale.set(p.scaleX, p.scaleY, p.scaleZ)
    dummy.updateMatrix()
    composed.copy(dummy.matrix).multiply(localMatrix)
    mesh.setMatrixAt(n, composed)
    if (withColor) mesh.setColorAt(n, p.color)
    n++
  }
  mesh.count = n
  mesh.instanceMatrix.needsUpdate = true
  if (withColor && mesh.instanceColor) mesh.instanceColor.needsUpdate = true
}

export async function buildExplorerVacantGrassField(
  parcelKeys: string[],
  primaryBase: string,
  options?: { windShader?: boolean }
): Promise<EzTreeGrassFieldHandle | null> {
  if (!parcelKeys.length) return null
  const wind = options?.windShader !== false
  const t = await loadTemplates()

  const grassPlaces = placeGrass(parcelKeys, primaryBase, t.grass.alignY)
  const flower0Places = placeFlowers(parcelKeys, primaryBase, t.flower0.alignY, 0)
  const flower1Places = placeFlowers(parcelKeys, primaryBase, t.flower1.alignY, 1)
  if (!grassPlaces.length) return null

  const grassMat = makeGrassMaterial(t.grassMap, GENESIS_GRASS_TINT, wind)
  const flowerMat = makeFlowerMaterial(t.flowerMap, wind)

  const grassMesh = new THREE.InstancedMesh(t.grass.geometry.clone(), grassMat, grassPlaces.length)
  grassMesh.name = 'aoi-explorer-grass'
  grassMesh.castShadow = false
  grassMesh.receiveShadow = true
  grassMesh.count = grassPlaces.length
  fillInstanced(grassMesh, grassPlaces, t.grass.localMatrix, true)

  const flower0Mesh = new THREE.InstancedMesh(
    t.flower0.geometry.clone(),
    flowerMat,
    Math.max(1, flower0Places.length)
  )
  flower0Mesh.name = 'aoi-explorer-flower-0'
  flower0Mesh.castShadow = false
  flower0Mesh.receiveShadow = true
  flower0Mesh.count = flower0Places.length
  if (flower0Places.length) fillInstanced(flower0Mesh, flower0Places, t.flower0.localMatrix, false)

  const flower1Mesh = new THREE.InstancedMesh(
    t.flower1.geometry.clone(),
    flowerMat,
    Math.max(1, flower1Places.length)
  )
  flower1Mesh.name = 'aoi-explorer-flower-1'
  flower1Mesh.castShadow = false
  flower1Mesh.receiveShadow = true
  flower1Mesh.count = flower1Places.length
  if (flower1Places.length) fillInstanced(flower1Mesh, flower1Places, t.flower1.localMatrix, false)

  const group = new THREE.Group()
  group.name = 'aoi-explorer-grass-field'
  group.add(grassMesh, flower0Mesh, flower1Mesh)
  group.userData.grassInstanceCount = grassPlaces.length
  group.userData.flowerInstanceCount = flower0Places.length + flower1Places.length

  let lastLod = 0
  const update = (elapsed: number, cameraPos: THREE.Vector3): void => {
    if (wind) {
      setGrassWindElapsed(grassMat, elapsed)
      setGrassWindElapsed(flowerMat, elapsed * 0.55)
    }
    const now = performance.now()
    if (now - lastLod < 180) return
    lastLod = now
    const { far } = landscapeLodRangeM()
    const cap = far <= 0 ? 0 : Math.min(far, DETAIL_MAX_M)
    if (cap <= 0) {
      grassMesh.count = 0
      flower0Mesh.count = 0
      flower1Mesh.count = 0
      grassMesh.instanceMatrix.needsUpdate = true
      return
    }
    lodCull(grassMesh, grassPlaces, cameraPos, t.grass.localMatrix, true, cap)
    lodCull(flower0Mesh, flower0Places, cameraPos, t.flower0.localMatrix, false, cap)
    lodCull(flower1Mesh, flower1Places, cameraPos, t.flower1.localMatrix, false, cap)
  }

  const dispose = (): void => {
    grassMat.dispose()
    flowerMat.dispose()
    grassMesh.geometry.dispose()
    flower0Mesh.geometry.dispose()
    flower1Mesh.geometry.dispose()
    grassMesh.removeFromParent()
    flower0Mesh.removeFromParent()
    flower1Mesh.removeFromParent()
    group.clear()
    group.removeFromParent()
  }

  return { group, update, dispose }
}
