/**
 * Land biome floor — single solid-color plane under the scene (not a GLB).
 * Matches desert plate span so the horizon is filled; y sits just below 0.
 */
import * as THREE from 'three'
import { parseParcelKey } from '../../content/parseParcel'
import { PARCEL_SIZE } from '../../content/types'
import { dclToThreePos } from '../../../bridge/dclTransform'
import { sceneCenterParcel } from '../islandLandscapeKeys'
import { OUTER_SCATTER_RADIUS_PARCELS } from '../scatterFalloff'
import { sceneParcelBounds } from '../Utils/ParcelGrid'

const LAND_PLANE_Y = -0.01

function parseHex(hex: string | undefined, fallback: number): number {
  if (!hex || typeof hex !== 'string') return fallback
  const t = hex.trim()
  if (/^#([0-9a-f]{6})$/i.test(t)) return parseInt(t.slice(1), 16)
  if (/^[0-9a-f]{6}$/i.test(t)) return parseInt(t, 16)
  return fallback
}

function halfExtentM(
  sceneParcels: string[],
  base: { x: number; y: number },
  borderPadding: number
): number {
  const center = sceneCenterParcel(sceneParcels)
  const centerDclX = (center.x - base.x) * PARCEL_SIZE
  const centerDclZ = (center.y - base.y) * PARCEL_SIZE
  let maxCornerDist = 0
  for (const key of sceneParcels) {
    const p = parseParcelKey(key)
    const swX = (p.x - base.x) * PARCEL_SIZE
    const swZ = (p.y - base.y) * PARCEL_SIZE
    for (const c of [
      { x: swX, z: swZ },
      { x: swX + PARCEL_SIZE, z: swZ },
      { x: swX, z: swZ + PARCEL_SIZE },
      { x: swX + PARCEL_SIZE, z: swZ + PARCEL_SIZE }
    ]) {
      maxCornerDist = Math.max(maxCornerDist, Math.hypot(c.x - centerDclX, c.z - centerDclZ))
    }
  }
  return Math.max(
    maxCornerDist + borderPadding * PARCEL_SIZE + OUTER_SCATTER_RADIUS_PARCELS * PARCEL_SIZE + PARCEL_SIZE,
    OUTER_SCATTER_RADIUS_PARCELS * PARCEL_SIZE
  )
}

/**
 * Large flat colored plane under scene + outer expanse.
 * Color is pure material.color — no texture, no tint multiply.
 */
export function buildLandColorGround(
  sceneParcels: string[],
  baseParcel: string,
  borderPadding: number,
  groundColorHex: string
): THREE.Group {
  const group = new THREE.Group()
  group.name = 'landscape:land-color-plane'

  const base = parseParcelKey(baseParcel)
  const center = sceneCenterParcel(sceneParcels)
  const centerDclX = (center.x - base.x) * PARCEL_SIZE
  const centerDclZ = (center.y - base.y) * PARCEL_SIZE
  const half = halfExtentM(sceneParcels, base, borderPadding)
  const sizeM = half * 2

  const geometry = new THREE.PlaneGeometry(sizeM, sizeM, 1, 1)
  geometry.rotateX(-Math.PI / 2)

  const material = new THREE.MeshStandardMaterial({
    color: parseHex(groundColorHex, 0xc43c2c),
    roughness: 0.95,
    metalness: 0.0,
    side: THREE.FrontSide
  })

  const mesh = new THREE.Mesh(geometry, material)
  mesh.name = 'land-color:plane'
  mesh.receiveShadow = true
  mesh.castShadow = false
  mesh.renderOrder = -2
  mesh.frustumCulled = false

  dclToThreePos(centerDclX, LAND_PLANE_Y, centerDclZ, mesh.position)

  group.add(mesh)
  group.userData.landHalfExtentM = half
  group.userData.landSizeM = sizeM
  group.userData.sceneBounds = sceneParcelBounds(sceneParcels)
  return group
}
