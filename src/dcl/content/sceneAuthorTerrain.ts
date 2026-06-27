import type { ResolvedScene } from './types'

/** Deployed path written by the terrain editor (`saveTerrainToProject`). */
export const SCENE_AUTHOR_TERRAIN_GLB = 'assets/terrain/terrain.glb'

/** True when the scene manifest includes editor-authored terrain.glb. */
export function sceneHasAuthorTerrain(scene: ResolvedScene): boolean {
  const target = SCENE_AUTHOR_TERRAIN_GLB.toLowerCase()
  return scene.content.some((entry) => {
    const file = entry.file.toLowerCase()
    return file === target || file.endsWith(`/${target}`)
  })
}