import * as THREE from 'three'
import { parseParcelKey } from '../../content/parseParcel'
import { PARCEL_SIZE } from '../../content/types'
import { dclToThreePos } from '../../../bridge/dclTransform'
import { sceneCenterParcel } from '../islandLandscapeKeys'
import { OUTER_SCATTER_RADIUS_PARCELS } from '../scatterFalloff'
import { sceneParcelBounds } from '../Utils/ParcelGrid'
import { EMPTY_LAND_GROUND_OFFSET } from '../Utils/SceneSpace'
import { perlin01 } from '../perlin2d'
import type { ResolvedDesertSettings } from '../../../environment/desertDefaults'
import { resolveDesertSettings } from '../../../environment/desertDefaults'

/** Warm sandy gold — continuous desert floor (no sky-gap cyan). */
export const DESERT_GOLD_COLOR = 0xd4a858

function parseSandColor(hex?: string): number {
  if (!hex || typeof hex !== 'string') return DESERT_GOLD_COLOR
  const t = hex.trim()
  if (/^#([0-9a-f]{6})$/i.test(t)) return parseInt(t.slice(1), 16)
  if (/^[0-9a-f]{6}$/i.test(t)) return parseInt(t, 16)
  return DESERT_GOLD_COLOR
}

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
 * Anisotropic ridge dunes — length along wind, width across, height crest.
 * Ridge shape: abs(perlin*2-1)^k so crests read as dunes, not isotropic bumps.
 */
export function duneHeightAtDcl(
  dclX: number,
  dclZ: number,
  settings: Pick<
    ResolvedDesertSettings,
    'dunes' | 'duneHeight' | 'duneWidth' | 'duneLength' | 'duneWindDeg' | 'duneRipple'
  >,
  seed = 91
): number {
  if (!settings.dunes || settings.duneHeight <= 0.001) return 0
  const rad = (settings.duneWindDeg * Math.PI) / 180
  const cos = Math.cos(rad)
  const sin = Math.sin(rad)
  // Along wind (length) / across wind (width)
  const u = dclX * cos + dclZ * sin
  const v = -dclX * sin + dclZ * cos
  const invLen = 1 / Math.max(4, settings.duneLength)
  const invWid = 1 / Math.max(4, settings.duneWidth)

  const n = perlin01(u * invLen, v * invWid, seed)
  // Ridge: peaks along crests
  const ridge = Math.pow(1 - Math.abs(n * 2 - 1), 1.35)
  let h = settings.duneHeight * ridge

  if (settings.duneRipple > 0.01) {
    const r = perlin01(u * invLen * 4.2, v * invWid * 5.5, seed + 13)
    // Cap ripple contribution so huge heights stay readable
    h += Math.min(settings.duneHeight * 0.22, 2.5) * settings.duneRipple * (r - 0.5)
  }
  return Math.max(0, h)
}

/**
 * Horizon-scale sandy plane with optional Perlin dune displacement.
 * Outer dunes only — scene footprint stays flat for author terrain.
 */
export function buildDesertGoldGround(
  sceneParcels: string[],
  baseParcel: string,
  borderPadding: number,
  sandColorHex?: string,
  desertSettings?: Partial<ResolvedDesertSettings> | null
): THREE.Group {
  const group = new THREE.Group()
  group.name = 'landscape:desert-gold'

  const base = parseParcelKey(baseParcel)
  const bounds = sceneParcelBounds(sceneParcels)
  const center = sceneCenterParcel(sceneParcels)
  const centerDclX = (center.x - base.x) * PARCEL_SIZE
  const centerDclZ = (center.y - base.y) * PARCEL_SIZE
  const halfExtentM = Math.max(
    desertGroundRadiusM(sceneParcels, base, borderPadding),
    OUTER_SCATTER_RADIUS_PARCELS * PARCEL_SIZE
  )
  const sizeM = halfExtentM * 2
  const settings = resolveDesertSettings(desertSettings as never)

  // Segment every ~6 m for dunes; flat plane stays cheap when dunes off.
  const wantDunes = settings.dunes && settings.duneHeight > 0.001
  const seg = wantDunes
    ? Math.max(32, Math.min(256, Math.ceil(sizeM / 6)))
    : 1

  const geometry = new THREE.PlaneGeometry(sizeM, sizeM, seg, seg)
  geometry.rotateX(-Math.PI / 2)

  if (wantDunes) {
    const pos = geometry.attributes.position as THREE.BufferAttribute
    // Plane sits centered on origin in local space; world dcl = center + local (before X flip on parent)
    // Mesh is positioned with dclToThree(center); vertices are local offsets in three space already
    // after rotateX: x = three-local X, z = three-local Z.
    // Parent uses dclToThree so world three = parent + local; dcl X = -threeX relative to center.
    const sceneMinX = (bounds.minX - base.x) * PARCEL_SIZE
    const sceneMaxX = (bounds.maxX - base.x + 1) * PARCEL_SIZE
    const sceneMinZ = (bounds.minY - base.y) * PARCEL_SIZE
    const sceneMaxZ = (bounds.maxY - base.y + 1) * PARCEL_SIZE
    const pad = borderPadding * PARCEL_SIZE

    for (let i = 0; i < pos.count; i++) {
      const lx = pos.getX(i) // three-local (already reflected space once parent is placed)
      const lz = pos.getZ(i)
      // Inverse of dclToThree for offsets from center: dcl offset X = -lx
      const dclX = centerDclX - lx
      const dclZ = centerDclZ + lz
      // Flatten under scene + padding so author terrain / pads aren't wrinkled
      const onFootprint =
        dclX >= sceneMinX - pad &&
        dclX <= sceneMaxX + pad &&
        dclZ >= sceneMinZ - pad &&
        dclZ <= sceneMaxZ + pad
      if (onFootprint) {
        pos.setY(i, 0)
        continue
      }
      pos.setY(i, duneHeightAtDcl(dclX, dclZ, settings))
    }
    pos.needsUpdate = true
    geometry.computeVertexNormals()
  }

  const material = new THREE.MeshStandardMaterial({
    color: parseSandColor(sandColorHex ?? settings.sandColor),
    roughness: 0.92,
    metalness: 0.02,
    side: THREE.FrontSide
  })

  const mesh = new THREE.Mesh(geometry, material)
  mesh.name = 'desert-gold:plane'
  mesh.receiveShadow = true
  mesh.castShadow = false
  mesh.renderOrder = -2
  mesh.frustumCulled = false

  const y = EMPTY_LAND_GROUND_OFFSET.y
  dclToThreePos(centerDclX, y, centerDclZ, mesh.position)

  group.add(mesh)
  group.userData.desertHalfExtentM = halfExtentM
  group.userData.desertSizeM = sizeM
  group.userData.sceneBounds = bounds
  return group
}
