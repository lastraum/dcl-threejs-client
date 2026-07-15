/**
 * Runtime gate for overhead name tags (local player, remotes, AvatarShape NPCs).
 * Set from ResolvedScene when a scene loads — URL / scene.json already resolved there.
 */
let sceneNameTagsVisible = true

export function setSceneNameTagsVisible(visible: boolean): void {
  sceneNameTagsVisible = visible
}

export function areSceneNameTagsVisible(): boolean {
  return sceneNameTagsVisible
}
