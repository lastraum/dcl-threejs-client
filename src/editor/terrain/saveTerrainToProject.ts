import { writeFileBytes, readFileText } from '../localScene/localFileSystem'
import type { ProjectRoot } from '../localScene/projectRoot'
import { getSessionAssetCache } from '../../rendering/AssetCache'
import { deleteGlbBytes, normalizeGlbCacheKey } from '../../rendering/glbByteCache'
import { exportTerrainGlb } from './exportTerrainGlb'
import { mergeTerrainIntoComposite } from '../composite/terrainComposite'
import {
  TERRAIN_GLB_FILE,
  TERRAIN_GRASS_COLOR_FILE,
  TERRAIN_GRASS_FILE,
  TERRAIN_GRASS_MANIFEST_FILE,
  TERRAIN_HEIGHTS_BIN_FILE,
  TERRAIN_SPLAT_FILE,
  type TerrainExportSettings
} from './terrainSculptConstants'
import type { EditorTerrainSystem } from './EditorTerrainSystem'
import { saveTerrainDraft } from './terrainEditorStore'
import { refreshTerrainFootprintFromProject } from './refreshTerrainFootprint'
import { encodeHeightsBin } from './heightmapHeightsBin'
import { imageDataToPngBlob } from './heightmapCodec'
import { grassManifestJson } from './grassManifest'

const COMPOSITE_PATH = 'assets/scene/main.composite'

export type TerrainSaveResult = {
  ok: boolean
  message: string
  paths: string[]
}

/**
 * Writes terrain.glb + composite (DCL-visible ground) and ThreejsClient-only grass sidecars
 * (density/color/heights + grass.json). No per-blade SDK entities.
 */
export async function saveTerrainToProject(
  projectId: string,
  root: ProjectRoot,
  terrain: EditorTerrainSystem,
  exportSettings: TerrainExportSettings,
  grassMask?: Uint8Array,
  grassRgb?: Uint8Array
): Promise<TerrainSaveResult> {
  const { heights, splat, lava } = terrain.getBuffers()
  const resolution = terrain.resolution
  const grass =
    grassMask && grassMask.length === resolution * resolution
      ? grassMask
      : new Uint8Array(resolution * resolution)
  const grassColors =
    grassRgb && grassRgb.length === resolution * resolution * 3
      ? grassRgb
      : new Uint8Array(resolution * resolution * 3)

  await saveTerrainDraft(projectId, {
    resolution,
    heights,
    splat,
    lava,
    grass,
    grassRgb: grassColors,
    proceduralShading: terrain.getProceduralShading(),
    exportSettings
  })

  const paths: string[] = []

  await refreshTerrainFootprintFromProject(root, terrain)
  const compositePos = terrain.getCompositePosition()

  const glb = await exportTerrainGlb(terrain, exportSettings.exportSegmentsPerParcel)
  await writeFileBytes(root, TERRAIN_GLB_FILE, glb)
  paths.push(TERRAIN_GLB_FILE)

  // --- ThreejsClient-only grass field (InstancedMesh from masks; not DCL entities) ---
  const heightsBin = new Uint8Array(encodeHeightsBin(heights, resolution))
  await writeFileBytes(root, TERRAIN_HEIGHTS_BIN_FILE, heightsBin)
  paths.push(TERRAIN_HEIGHTS_BIN_FILE)

  const grassImg = new ImageData(resolution, resolution)
  for (let i = 0; i < grass.length; i++) {
    const v = grass[i]!
    const o = i * 4
    grassImg.data[o] = v
    grassImg.data[o + 1] = v
    grassImg.data[o + 2] = v
    grassImg.data[o + 3] = 255
  }
  const grassBlob = await imageDataToPngBlob(grassImg)
  const grassBytes = new Uint8Array(await grassBlob.arrayBuffer())
  await writeFileBytes(root, TERRAIN_GRASS_FILE, grassBytes)
  paths.push(TERRAIN_GRASS_FILE)

  const colorImg = new ImageData(resolution, resolution)
  for (let i = 0; i < resolution * resolution; i++) {
    const o = i * 4
    const c = i * 3
    colorImg.data[o] = grassColors[c]!
    colorImg.data[o + 1] = grassColors[c + 1]!
    colorImg.data[o + 2] = grassColors[c + 2]!
    colorImg.data[o + 3] = 255
  }
  const colorBlob = await imageDataToPngBlob(colorImg)
  const colorBytes = new Uint8Array(await colorBlob.arrayBuffer())
  await writeFileBytes(root, TERRAIN_GRASS_COLOR_FILE, colorBytes)
  paths.push(TERRAIN_GRASS_COLOR_FILE)

  const manifestText = grassManifestJson(resolution)
  await writeFileBytes(root, TERRAIN_GRASS_MANIFEST_FILE, new TextEncoder().encode(manifestText))
  paths.push(TERRAIN_GRASS_MANIFEST_FILE)

  // Albedo splat for editor / optional tooling (not required for blades).
  const splatImg = new ImageData(resolution, resolution)
  splatImg.data.set(splat)
  const splatBlob = await imageDataToPngBlob(splatImg)
  const splatBytes = new Uint8Array(await splatBlob.arrayBuffer())
  await writeFileBytes(root, TERRAIN_SPLAT_FILE, splatBytes)
  paths.push(TERRAIN_SPLAT_FILE)

  for (const key of [TERRAIN_GLB_FILE, `local://${TERRAIN_GLB_FILE}`]) {
    const cacheKey = normalizeGlbCacheKey(key)
    getSessionAssetCache().evict(cacheKey)
    void deleteGlbBytes(cacheKey)
  }

  const existingComposite = await readFileText(root, COMPOSITE_PATH)
  if (existingComposite) {
    await writeFileBytes(
      root,
      `${COMPOSITE_PATH}.bak`,
      new TextEncoder().encode(existingComposite)
    )
  }
  const merged = mergeTerrainIntoComposite(existingComposite, {
    glbSrc: TERRAIN_GLB_FILE,
    position: compositePos
  })
  await writeFileBytes(root, COMPOSITE_PATH, new TextEncoder().encode(merged))
  paths.push(COMPOSITE_PATH)

  const glbMb = (glb.byteLength / (1024 * 1024)).toFixed(2)
  const meshNote = terrain.usesMergedExportMesh()
    ? `merged footprint mesh (${terrain.footprint.parcels.length} parcels)`
    : `${terrain.footprint.parcels.length} parcel plane(s), ${exportSettings.exportSegmentsPerParcel} segs/parcel`
  return {
    ok: true,
    message:
      `Saved: terrain.glb (${glbMb} MB, ${meshNote}) + main.composite @ (${compositePos.x}, ${compositePos.y}, ${compositePos.z}). ` +
      `ThreejsClient Ez Grass: grass.json + grass.png + grass-color.png + heightmap.heights.bin (InstancedMesh — not SDK entities). ` +
      `Explorer only sees terrain.glb (baked albedo); grass sidecars are ignored there. ` +
      `IndexedDB draft kept for project ${projectId}.`,
    paths
  }
}