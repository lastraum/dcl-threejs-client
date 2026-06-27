import * as THREE from 'three'
import { parseParcelKey } from '../../content/parseParcel'
import { PARCEL_SIZE } from '../../content/types'
import { dclToThreePos } from '../../../bridge/dclTransform'
import { sceneCenterParcel } from '../islandLandscapeKeys'
import { OUTER_SCATTER_RADIUS_PARCELS } from '../scatterFalloff'
import { sceneParcelBounds } from '../Utils/ParcelGrid'
import { EMPTY_LAND_GROUND_OFFSET } from '../Utils/SceneSpace'

/** Warm sandy gold — continuous desert floor (no sky-gap cyan). */
export const DESERT_GOLD_COLOR = 0xd4a858

function desertGroundRadiusM(sceneParcels: string[], base: { x: number; y: number }, borderPadding: number): number {
  const center = sceneCenterParcel(sceneParcels)
  const centerDclX = (center.x - base.x) * PARCEL_SIZE
  const centerDclZ = (center.y - base.y) * PARCEL_SIZE

  let maxCornerDist = 0
  for (const key of sceneParcels) {
    const p = parseParcelKey(key)
    const swX = (p.x - base.x) * PARCEL_SIZE
    const swZ = (p.y - base.y) * PARCEL_SIZE
    const corners = [
      { x: swX, z: swZ },
      { x: swX + PARCEL_SIZE, z: swZ },
      { x: swX, z: swZ + PARCEL_SIZE },
      { x: swX + PARCEL_SIZE, z: swZ + PARCEL_SIZE }
    ]
    for (const c of corners) {
      maxCornerDist = Math.max(maxCornerDist, Math.hypot(c.x - centerDclX, c.z - centerDclZ))
    }
  }

  const paddingM = borderPadding * PARCEL_SIZE
  const outerM = OUTER_SCATTER_RADIUS_PARCELS * PARCEL_SIZE
  return maxCornerDist + paddingM + outerM + PARCEL_SIZE
}

/**
 * Single flat sandy-gold disc covering scene + padding + outer expanse.
 * Replaces per-parcel sand GLBs so genesis sky nadir never shows through gaps.
 */
export function buildDesertGoldGround(
  sceneParcels: string[],
  baseParcel: string,
  borderPadding: number
): THREE.Group {
  const group = new THREE.Group()
  group.name = 'landscape:desert-gold'

  const base = parseParcelKey(baseParcel)
  const bounds = sceneParcelBounds(sceneParcels)
  const center = sceneCenterParcel(sceneParcels)
  const centerDclX = (center.x - base.x) * PARCEL_SIZE
  const centerDclZ = (center.y - base.y) * PARCEL_SIZE
  const radiusM = desertGroundRadiusM(sceneParcels, base, borderPadding)

  const segments = Math.max(64, Math.ceil((2 * Math.PI * radiusM) / 8))
  const geometry = new THREE.CircleGeometry(radiusM, segments)
  geometry.rotateX(-Math.PI / 2)

  const material = new THREE.MeshStandardMaterial({
    color: DESERT_GOLD_COLOR,
    roughness: 0.92,
    metalness: 0.02,
    side: THREE.FrontSide
  })

  const mesh = new THREE.Mesh(geometry, material)
  mesh.name = 'desert-gold:disc'
  mesh.receiveShadow = true
  mesh.castShadow = false
  mesh.renderOrder = -2

  const y = EMPTY_LAND_GROUND_OFFSET.y
  dclToThreePos(centerDclX, y, centerDclZ, mesh.position)

  group.add(mesh)
  group.userData.desertRadiusM = radiusM
  group.userData.sceneBounds = bounds
  return group
}