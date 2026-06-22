import * as THREE from 'three'
import { parseParcelKey } from '../../content/parseParcel'
import { islandCenterDcl, islandCenterThree, islandShoreLayout } from '../islandLandscapeKeys'
import { dclToThreePos } from '../../../bridge/dclTransform'
import { beachHeightAtDcl } from '../islandBeachHeight'
import { IslandShoreMaterial, ISLAND_WATER_SURFACE_Y } from '../IslandShoreMaterial'

const RADIAL_STEP = 0.85

function buildCircularHeightmapGeometry(
  sceneParcels: string[],
  baseParcel: string,
  shoreWidthParcels: number
): THREE.BufferGeometry {
  const base = parseParcelKey(baseParcel)
  const layout = islandShoreLayout(sceneParcels, shoreWidthParcels, base)
  const centerDcl = islandCenterDcl(sceneParcels, base)
  const outerR = layout.outerRadiusM

  const ringCount = Math.max(12, Math.ceil(outerR / RADIAL_STEP))
  const angularSegs = Math.max(128, Math.ceil((2 * Math.PI * outerR) / RADIAL_STEP))

  const positions: number[] = []
  const indices: number[] = []
  const ringStarts: number[] = []

  const centerY = beachHeightAtDcl(centerDcl.x, centerDcl.z, 0, layout)
  const _v = new THREE.Vector3()
  dclToThreePos(centerDcl.x, centerY, centerDcl.z, _v)
  positions.push(_v.x, _v.y, _v.z)
  ringStarts.push(0)

  for (let ring = 1; ring <= ringCount; ring++) {
    ringStarts.push(positions.length / 3)
    const r = (ring / ringCount) * outerR

    for (let seg = 0; seg < angularSegs; seg++) {
      const theta = (seg / angularSegs) * Math.PI * 2
      const dclX = centerDcl.x + Math.cos(theta) * r
      const dclZ = centerDcl.z + Math.sin(theta) * r
      const y = beachHeightAtDcl(dclX, dclZ, r, layout)
      dclToThreePos(dclX, y, dclZ, _v)
      positions.push(_v.x, _v.y, _v.z)
    }
  }

  const ring1 = ringStarts[1]!
  for (let seg = 0; seg < angularSegs; seg++) {
    const next = (seg + 1) % angularSegs
    indices.push(0, ring1 + seg, ring1 + next)
  }

  for (let ring = 1; ring < ringCount; ring++) {
    const curr = ringStarts[ring]!
    const next = ringStarts[ring + 1]!
    for (let seg = 0; seg < angularSegs; seg++) {
      const segNext = (seg + 1) % angularSegs
      const a = curr + seg
      const b = curr + segNext
      const c = next + seg
      const d = next + segNext
      indices.push(a, c, b, b, c, d)
    }
  }

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.setIndex(indices)
  geometry.computeVertexNormals()
  return geometry
}

/** Circular island beach — Genesis Games procedural height + sand coloring. */
export async function buildIslandCircularShore(
  sceneParcels: string[],
  baseParcel: string,
  shoreWidthParcels: number
): Promise<THREE.Group> {
  const group = new THREE.Group()
  group.name = 'landscape:island-shore'

  const base = parseParcelKey(baseParcel)
  const layout = islandShoreLayout(sceneParcels, shoreWidthParcels, base)
  const centerThree = islandCenterThree(sceneParcels, base)

  const geometry = buildCircularHeightmapGeometry(sceneParcels, baseParcel, shoreWidthParcels)
  geometry.computeBoundingBox()
  const box = geometry.boundingBox!

  const shoreMaterial = new IslandShoreMaterial()
  shoreMaterial.applyLayout(layout, centerThree)
  if (box) {
    shoreMaterial.updateHeightRange(box.min.y, box.max.y)
  }
  shoreMaterial.setWaterLevel(ISLAND_WATER_SURFACE_Y)

  const mesh = new THREE.Mesh(geometry, shoreMaterial.material)
  mesh.name = 'island-shore:heightmap-disc'
  mesh.receiveShadow = true
  mesh.castShadow = false
  mesh.renderOrder = -2

  group.add(mesh)
  group.userData.islandShoreMaterial = shoreMaterial
  group.userData.flatRadiusM = layout.flatRadiusM
  group.userData.outerRadiusM = layout.outerRadiusM
  group.userData.shoreVertexCount = geometry.getAttribute('position').count
  return group
}