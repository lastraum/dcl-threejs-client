/**
 * Runtime gate for overhead name tags (local player, remotes, AvatarShape NPCs).
 *
 * Two layers (Explorer-style, like skybox fixedTime lock):
 * 1) **Scene policy** — from scene.json `featureToggles.nameTags` / `?nameTags=`
 *    When the scene (or URL) disables tags, user cannot force them on.
 * 2) **User preference** — `N` toggles show/hide while the scene allows tags.
 *
 * Final visibility = sceneAllows && userWants.
 */

/** Scene / URL policy — false when scene.json or ?nameTags= disables tags. */
let sceneAllowsNameTags = true

/** Session user preference — toggled with N (default show). */
let userWantsNameTags = true

/** @deprecated Use setSceneNameTagsPolicy — kept name for older call sites. */
export function setSceneNameTagsVisible(visible: boolean): void {
  setSceneNameTagsPolicy(visible)
}

/**
 * Set whether the loaded scene allows name tags.
 * When false, tags stay hidden regardless of the N key (skybox-style lock).
 */
export function setSceneNameTagsPolicy(allowed: boolean): void {
  sceneAllowsNameTags = allowed
}

export function isNameTagsSceneLocked(): boolean {
  return !sceneAllowsNameTags
}

export function getUserNameTagsPreference(): boolean {
  return userWantsNameTags
}

/**
 * Toggle user preference. No-ops when scene policy disables tags.
 * @returns whether tags are visible after the call, or null if locked.
 */
export function toggleUserNameTagsVisible(): boolean | null {
  if (!sceneAllowsNameTags) return null
  userWantsNameTags = !userWantsNameTags
  return userWantsNameTags
}

export function setUserNameTagsVisible(visible: boolean): void {
  if (!sceneAllowsNameTags) return
  userWantsNameTags = visible
}

export function areSceneNameTagsVisible(): boolean {
  return sceneAllowsNameTags && userWantsNameTags
}
