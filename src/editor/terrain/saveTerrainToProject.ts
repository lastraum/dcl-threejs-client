import { writeFileBytes, readFileText } from '../localScene/localFileSystem'
import type { ProjectRoot } from '../localScene/projectRoot'
import { getSessionAssetCache } from '../../rendering/AssetCache'
import { deleteGlbBytes, normalizeGlbCacheKey } from '../../rendering/glbByteCache'
import { exportTerrainGlb } from './exportTerrainGlb'
import { mergeTerrainIntoComposite } from '../composite/terrainComposite'
import { TERRAIN_GLB_FILE, type TerrainExportSettings } from './terrainSculptConstants'
import type { EditorTerrainSystem } from './EditorTerrainSystem'
import { saveTerrainDraft } from './terrainEditorStore'
import { refreshTerrainFootprintFromProject } from './refreshTerrainFootprint'

const COMPOSITE_PATH = 'assets/scene/main.composite'

export type TerrainSaveResult = {
  ok: boolean
  message: string
  paths: string[]
}

/** Writes deployable assets only (terrain.glb + main.composite). Sculpt buffers → IndexedDB. */
export async function saveTerrainToProject(
  projectId: string,
  root: ProjectRoot,
  terrain: EditorTerrainSystem,
  exportSettings: TerrainExportSettings
): Promise<TerrainSaveResult> {
  const { heights, splat, lava } = terrain.getBuffers()
  const resolution = terrain.resolution

  await saveTerrainDraft(projectId, {
    resolution,
    heights,
    splat,
    lava,
    proceduralShading: terrain.getProceduralShading(),
    exportSettings
  })

  const paths: string[] = []

  await refreshTerrainFootprintFromProject(root, terrain)
  const compositePos = terrain.getCompositePosition()

  const glb = await exportTerrainGlb(terrain, exportSettings.exportSegmentsPerParcel)
  await writeFileBytes(root, TERRAIN_GLB_FILE, glb)
  paths.push(TERRAIN_GLB_FILE)

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
  return {
    ok: true,
    message:
      `Saved deploy files: terrain.glb (${glbMb} MB, ${terrain.footprint.parcels.length} parcel plane(s), ${exportSettings.exportSegmentsPerParcel} segs/parcel, visible CL_PHYSICS, baked albedo) + main.composite @ (${compositePos.x}, ${compositePos.y}, ${compositePos.z}) base=${terrain.footprint.baseParcel}. ` +
      `Unity Explorer ignores vertex paint — colors are baked into the GLB texture. Disable Creator Hub “Landscape Terrain Enabled” so default grass does not cover your mesh. ` +
      `Editor sculpt data stored in this browser (IndexedDB) for project ${projectId}. ` +
      `dcl deploy will not include heightmap/splat sidecars.`,
    paths
  }
}