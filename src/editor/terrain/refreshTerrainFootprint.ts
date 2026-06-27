import type { SceneMetadata } from '../../dcl/content/types'
import { layoutFromSceneMetadata } from '../../dcl/content/sceneLayout'
import { sceneWorldBounds } from '../../player/SceneBounds'
import { readFileText } from '../localScene/localFileSystem'
import type { ProjectRoot } from '../localScene/projectRoot'
import type { EditorTerrainSystem } from './EditorTerrainSystem'
import { terrainFootprintFromBounds } from './terrainFootprint'

/** Re-read scene.json so composite position matches Creator Hub (honours explicit `scene.base`). */
export async function refreshTerrainFootprintFromProject(
  root: ProjectRoot,
  terrain: EditorTerrainSystem
): Promise<void> {
  const sceneJsonText = await readFileText(root, 'scene.json')
  if (!sceneJsonText) return

  const metadata = JSON.parse(sceneJsonText) as SceneMetadata
  const { parcels, base } = layoutFromSceneMetadata(metadata)
  const bounds = sceneWorldBounds(parcels, base)
  terrain.applyFootprint(terrainFootprintFromBounds(parcels, base, bounds))
}